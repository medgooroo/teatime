package main

// Backup and restore of the whole recipe store as a single .tar.gz, driven from
// the front page. The archive holds the data directory verbatim — recipes, saved
// meals, and the Guardian bookkeeping — so a restore reproduces the store exactly.

import (
	"archive/tar"
	"compress/gzip"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

// Entries we are willing to write back out of an archive: a recipe or dotfile at
// the top level, or a saved meal one directory down. Anything else — absolute
// paths, traversal, unexpected directories — is refused.
var backupEntryRe = regexp.MustCompile(`^(meals/)?\.?[a-z0-9][a-z0-9-]*\.json$`)

const maxRestoreBytes = 500 << 20

func safeEntryName(name string) (string, bool) {
	name = strings.ReplaceAll(name, `\`, "/")
	name = strings.TrimPrefix(name, "./")
	if name == "" || path.IsAbs(name) || strings.Contains(name, "..") {
		return "", false
	}
	if !backupEntryRe.MatchString(name) {
		return "", false
	}
	return name, true
}

// files worth archiving: recipes and dotfiles at the top, meals below
func backupFiles(dir string) ([]string, error) {
	var out []string
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	for _, e := range entries {
		if e.IsDir() {
			if e.Name() != "meals" {
				continue
			}
			meals, err := os.ReadDir(filepath.Join(dir, "meals"))
			if err != nil {
				continue
			}
			for _, m := range meals {
				if !m.IsDir() && strings.HasSuffix(m.Name(), ".json") {
					out = append(out, "meals/"+m.Name())
				}
			}
			continue
		}
		if strings.HasSuffix(e.Name(), ".json") {
			out = append(out, e.Name())
		}
	}
	sort.Strings(out)
	return out, nil
}

func backupHandler(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		st.mu.RLock()
		defer st.mu.RUnlock()

		names, err := backupFiles(st.dir)
		if err != nil {
			httpError(w, err)
			return
		}

		stamp := time.Now().Format("2006-01-02")
		w.Header().Set("Content-Type", "application/gzip")
		w.Header().Set("Content-Disposition",
			fmt.Sprintf(`attachment; filename="teatime-%s.tar.gz"`, stamp))
		w.Header().Set("X-Recipe-Count", fmt.Sprint(len(names)))

		gz := gzip.NewWriter(w)
		defer gz.Close()
		tw := tar.NewWriter(gz)
		defer tw.Close()

		for _, name := range names {
			full := filepath.Join(st.dir, filepath.FromSlash(name))
			info, err := os.Stat(full)
			if err != nil {
				continue
			}
			b, err := os.ReadFile(full)
			if err != nil {
				continue
			}
			hdr := &tar.Header{
				Name: name, Mode: 0644, Size: int64(len(b)),
				ModTime: info.ModTime(), Typeflag: tar.TypeReg,
			}
			if tw.WriteHeader(hdr) != nil {
				return // client went away mid-download
			}
			if _, err := tw.Write(b); err != nil {
				return
			}
		}
		log.Printf("backup: %d files served", len(names))
	}
}

type RestoreResult struct {
	Restored int      `json:"restored"`
	Skipped  int      `json:"skipped"`
	Removed  int      `json:"removed"`
	Mode     string   `json:"mode"`
	Problems []string `json:"problems,omitempty"`
}

func restoreHandler(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		mode := r.URL.Query().Get("mode")
		if mode != "replace" {
			mode = "merge"
		}

		body := http.MaxBytesReader(w, r.Body, maxRestoreBytes)
		gz, err := gzip.NewReader(body)
		if err != nil {
			http.Error(w, "not a gzip archive: "+err.Error(), http.StatusBadRequest)
			return
		}
		defer gz.Close()

		// read the whole archive before touching disk, so a corrupt file can't
		// leave the store half-replaced
		type entry struct {
			name string
			data []byte
		}
		var entries []entry
		res := &RestoreResult{Mode: mode}
		tr := tar.NewReader(gz)
		for {
			hdr, err := tr.Next()
			if err == io.EOF {
				break
			}
			if err != nil {
				http.Error(w, "damaged archive: "+err.Error(), http.StatusBadRequest)
				return
			}
			if hdr.Typeflag != tar.TypeReg {
				continue
			}
			name, ok := safeEntryName(hdr.Name)
			if !ok {
				res.Skipped++
				if len(res.Problems) < 10 {
					res.Problems = append(res.Problems, "refused "+hdr.Name)
				}
				continue
			}
			b, err := io.ReadAll(io.LimitReader(tr, 8<<20))
			if err != nil {
				res.Skipped++
				continue
			}
			entries = append(entries, entry{name, b})
		}

		if len(entries) == 0 {
			http.Error(w, "archive contained no recipes", http.StatusBadRequest)
			return
		}

		st.mu.Lock()
		defer st.mu.Unlock()

		if mode == "replace" {
			existing, err := backupFiles(st.dir)
			if err == nil {
				keep := map[string]bool{}
				for _, e := range entries {
					keep[e.name] = true
				}
				for _, name := range existing {
					if keep[name] {
						continue
					}
					if os.Remove(filepath.Join(st.dir, filepath.FromSlash(name))) == nil {
						res.Removed++
					}
				}
			}
		}

		os.MkdirAll(filepath.Join(st.dir, "meals"), 0755)
		for _, e := range entries {
			full := filepath.Join(st.dir, filepath.FromSlash(e.name))
			tmp := full + ".tmp"
			if err := os.WriteFile(tmp, e.data, 0644); err != nil {
				res.Skipped++
				continue
			}
			if err := os.Rename(tmp, full); err != nil {
				os.Remove(tmp)
				res.Skipped++
				continue
			}
			res.Restored++
		}

		// force the next listing to reparse
		st.cacheMu.Lock()
		st.cache = nil
		st.cacheMu.Unlock()

		log.Printf("restore (%s): %d restored, %d removed, %d skipped",
			mode, res.Restored, res.Removed, res.Skipped)
		writeJSON(w, http.StatusOK, res)
	}
}
