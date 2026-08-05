package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

type Lane struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type Step struct {
	ID           string `json:"id"`
	LaneID       string `json:"laneId"`
	Name         string `json:"name"`
	Instructions string `json:"instructions"`
	Start        int    `json:"start"`    // seconds from recipe start
	Duration     int    `json:"duration"` // seconds
	Alarm        string `json:"alarm"`    // "", "start", "end" or "both"
}

// Where an imported recipe came from, so a re-import can tell what it already has.
type Source struct {
	Type         string   `json:"type,omitempty"`
	UID          string   `json:"uid,omitempty"`
	URL          string   `json:"url,omitempty"`
	Contributors []string `json:"contributors,omitempty"`
}

type Recipe struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	Description string   `json:"description"`
	Ingredients []string `json:"ingredients"`
	Lanes       []Lane   `json:"lanes"`
	Steps       []Step   `json:"steps"`
	Source      *Source  `json:"source,omitempty"`
	Starred     bool     `json:"starred,omitempty"`
}

func (r *Recipe) total() int {
	t := 0
	for _, s := range r.Steps {
		if end := s.Start + s.Duration; end > t {
			t = end
		}
	}
	return t
}

type Summary struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	Description  string `json:"description"`
	TotalSeconds int    `json:"totalSeconds"`
	Starred      bool   `json:"starred"`
}

// Store keeps one JSON file per recipe under dir; the filename is the id.
// Listing parses every file, so summaries are cached and only rebuilt when the
// directory's file count or newest timestamp changes — including for edits made
// outside the server.
type Store struct {
	dir string
	mu  sync.RWMutex

	cacheMu    sync.Mutex
	cache      []indexed
	cacheCount int
	cacheStamp time.Time
}

// A cached summary plus the lowercased text the search filters against. The
// ingredient text is kept separate so ingredient search can't match a word that
// only appears in the title.
type indexed struct {
	Summary
	hay  string
	ings string
}

var idRe = regexp.MustCompile(`^[a-z0-9][a-z0-9-]*$`)

var errBadID = errors.New("invalid id")

func (st *Store) path(id string) (string, error) {
	if !idRe.MatchString(id) {
		return "", errBadID
	}
	return filepath.Join(st.dir, id+".json"), nil
}

func (st *Store) get(id string) (*Recipe, error) {
	st.mu.RLock()
	defer st.mu.RUnlock()
	return st.read(id)
}

func (st *Store) read(id string) (*Recipe, error) {
	p, err := st.path(id)
	if err != nil {
		return nil, err
	}
	b, err := os.ReadFile(p)
	if err != nil {
		return nil, err
	}
	var r Recipe
	if err := json.Unmarshal(b, &r); err != nil {
		return nil, err
	}
	r.ID = id
	return &r, nil
}

func (st *Store) write(r *Recipe) error {
	p, err := st.path(r.ID)
	if err != nil {
		return err
	}
	if r.Ingredients == nil {
		r.Ingredients = []string{}
	}
	if r.Lanes == nil {
		r.Lanes = []Lane{}
	}
	if r.Steps == nil {
		r.Steps = []Step{}
	}
	b, err := json.MarshalIndent(r, "", "  ")
	if err != nil {
		return err
	}
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, b, 0644); err != nil {
		return err
	}
	return os.Rename(tmp, p)
}

func (st *Store) put(r *Recipe) error {
	st.mu.Lock()
	defer st.mu.Unlock()
	return st.write(r)
}

// setStar flips one recipe's star. The cached index is patched in place rather
// than invalidated, so starring stays instant on a store of thousands.
func (st *Store) setStar(id string, on bool) (*Recipe, error) {
	st.mu.Lock()
	rec, err := st.read(id)
	if err == nil {
		rec.Starred = on
		err = st.write(rec)
	}
	st.mu.Unlock()
	if err != nil {
		return nil, err
	}

	st.cacheMu.Lock()
	defer st.cacheMu.Unlock()
	if st.cache != nil {
		for i := range st.cache {
			if st.cache[i].ID == id {
				st.cache[i].Starred = on
				break
			}
		}
		// adopt the directory's new state so the write we just made doesn't
		// look like an outside edit and trigger a full reparse
		if count, newest, err := st.dirState(); err == nil {
			st.cacheCount, st.cacheStamp = count, newest
		}
	}
	return rec, nil
}

func (st *Store) dirState() (int, time.Time, error) {
	entries, err := os.ReadDir(st.dir)
	if err != nil {
		return 0, time.Time{}, err
	}
	count := 0
	var newest time.Time
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		count++
		if info, err := e.Info(); err == nil && info.ModTime().After(newest) {
			newest = info.ModTime()
		}
	}
	return count, newest, nil
}

// create assigns a unique slug id derived from the recipe name.
func (st *Store) create(r *Recipe) error {
	st.mu.Lock()
	defer st.mu.Unlock()
	base := slugify(r.Name)
	id := base
	for i := 2; ; i++ {
		p, err := st.path(id)
		if err != nil {
			return err
		}
		if _, err := os.Stat(p); os.IsNotExist(err) {
			break
		}
		id = fmt.Sprintf("%s-%d", base, i)
	}
	r.ID = id
	return st.write(r)
}

func (st *Store) delete(id string) error {
	st.mu.Lock()
	defer st.mu.Unlock()
	p, err := st.path(id)
	if err != nil {
		return err
	}
	return os.Remove(p)
}

// summaries returns every recipe's summary, rebuilding the cache only when the
// directory has changed.
func (st *Store) summaries() ([]indexed, error) {
	count, newest, err := st.dirState()
	if err != nil {
		return nil, err
	}

	st.cacheMu.Lock()
	defer st.cacheMu.Unlock()
	if st.cache != nil && st.cacheCount == count && st.cacheStamp.Equal(newest) {
		return st.cache, nil
	}

	recipes, err := st.list()
	if err != nil {
		return nil, err
	}
	sums := make([]indexed, 0, len(recipes))
	for _, r := range recipes {
		ings := strings.ToLower(strings.Join(r.Ingredients, "\n"))
		sums = append(sums, indexed{
			Summary: Summary{
				ID: r.ID, Name: r.Name, Description: r.Description,
				TotalSeconds: r.total(), Starred: r.Starred,
			},
			hay:  strings.ToLower(r.Name + "\n" + r.Description),
			ings: ings,
		})
	}
	sort.Slice(sums, func(i, j int) bool { return sums[i].Name < sums[j].Name })
	st.cache, st.cacheCount, st.cacheStamp = sums, count, newest
	log.Printf("recipe index rebuilt: %d recipes", len(sums))
	return sums, nil
}

// The Guardian ids already imported, so a sync knows what to skip.
func (st *Store) guardianUIDs() (map[string]bool, error) {
	recipes, err := st.list()
	if err != nil {
		return nil, err
	}
	out := make(map[string]bool, len(recipes))
	for _, r := range recipes {
		if r.Source != nil && r.Source.UID != "" {
			out[r.Source.UID] = true
		}
	}
	return out, nil
}

func (st *Store) list() ([]*Recipe, error) {
	st.mu.RLock()
	defer st.mu.RUnlock()
	entries, err := os.ReadDir(st.dir)
	if err != nil {
		return nil, err
	}
	var out []*Recipe
	for _, e := range entries {
		id := strings.TrimSuffix(e.Name(), ".json")
		if e.IsDir() || id == e.Name() || !idRe.MatchString(id) {
			continue
		}
		r, err := st.read(id)
		if err != nil {
			log.Printf("skipping %s: %v", e.Name(), err)
			continue
		}
		out = append(out, r)
	}
	return out, nil
}

func slugify(name string) string {
	var b strings.Builder
	for _, c := range strings.ToLower(name) {
		switch {
		case c >= 'a' && c <= 'z' || c >= '0' && c <= '9':
			b.WriteRune(c)
		default:
			b.WriteRune('-')
		}
	}
	slug := strings.Trim(regexp.MustCompile(`-+`).ReplaceAllString(b.String(), "-"), "-")
	if slug == "" {
		return "recipe"
	}
	return slug
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}

func httpError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errBadID):
		http.Error(w, "invalid recipe id", http.StatusBadRequest)
	case os.IsNotExist(err):
		http.Error(w, "recipe not found", http.StatusNotFound)
	default:
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

func decodeRecipe(w http.ResponseWriter, r *http.Request) (*Recipe, bool) {
	var rec Recipe
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	if err := json.NewDecoder(r.Body).Decode(&rec); err != nil {
		http.Error(w, "bad request body", http.StatusBadRequest)
		return nil, false
	}
	if strings.TrimSpace(rec.Name) == "" {
		rec.Name = "Untitled recipe"
	}
	return &rec, true
}

func apiHandler(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/recipes"), "/")

		// /api/recipes/{id}/star — mark a recipe for the week ahead
		if rest, ok := strings.CutSuffix(id, "/star"); ok {
			if r.Method != http.MethodPost {
				http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
				return
			}
			on := true
			if v := r.URL.Query().Get("on"); v != "" {
				on = v == "1" || strings.EqualFold(v, "true")
			}
			rec, err := st.setStar(rest, on)
			if err != nil {
				httpError(w, err)
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{"id": rec.ID, "starred": rec.Starred})
			return
		}

		// /api/recipes/{id}/source — the recipe as originally published
		if rest, ok := strings.CutSuffix(id, "/source"); ok {
			if r.Method != http.MethodGet {
				http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
				return
			}
			rec, err := st.get(rest)
			if err != nil {
				httpError(w, err)
				return
			}
			if rec.Source == nil || rec.Source.Type != "guardian" || rec.Source.UID == "" {
				http.Error(w, "no original held for this recipe", http.StatusNotFound)
				return
			}
			src, err := guardianSource(rec.Source.UID)
			if err != nil {
				http.Error(w, err.Error(), http.StatusNotFound)
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{
				"title": src.Title, "description": src.Description,
				"contributors": src.Contributors, "serves": src.Serves,
				"timings": src.Timings, "ingredients": src.Ingredients,
				"instructions": src.Instructions, "url": rec.Source.URL,
			})
			return
		}

		switch {
		case id == "" && r.Method == http.MethodGet:
			all, err := st.summaries()
			if err != nil {
				httpError(w, err)
				return
			}
			q := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("q")))
			// ?ing=chicken,lemon or repeated ?ing= — every term must appear
			var ings []string
			for _, v := range r.URL.Query()["ing"] {
				for _, part := range strings.Split(v, ",") {
					if p := strings.ToLower(strings.TrimSpace(part)); p != "" {
						ings = append(ings, p)
					}
				}
			}

			starredOnly := r.URL.Query().Get("starred") == "1"

			sums := []Summary{}
			for _, s := range all {
				if starredOnly && !s.Starred {
					continue
				}
				if q != "" && !strings.Contains(s.hay, q) && !strings.Contains(s.ings, q) {
					continue
				}
				missing := false
				for _, want := range ings {
					if !strings.Contains(s.ings, want) {
						missing = true
						break
					}
				}
				if missing {
					continue
				}
				sums = append(sums, s.Summary)
			}
			// a huge store would otherwise ship megabytes to the browser
			limit := 500
			if v := r.URL.Query().Get("limit"); v != "" {
				fmt.Sscanf(v, "%d", &limit)
			}
			w.Header().Set("X-Total-Count", fmt.Sprint(len(sums)))
			if limit > 0 && len(sums) > limit {
				sums = sums[:limit]
			}
			writeJSON(w, http.StatusOK, sums)
		case id == "" && r.Method == http.MethodPost:
			rec, ok := decodeRecipe(w, r)
			if !ok {
				return
			}
			if err := st.create(rec); err != nil {
				httpError(w, err)
				return
			}
			writeJSON(w, http.StatusCreated, rec)
		case id != "" && r.Method == http.MethodGet:
			rec, err := st.get(id)
			if err != nil {
				httpError(w, err)
				return
			}
			writeJSON(w, http.StatusOK, rec)
		case id != "" && r.Method == http.MethodPut:
			rec, ok := decodeRecipe(w, r)
			if !ok {
				return
			}
			rec.ID = id
			if err := st.put(rec); err != nil {
				httpError(w, err)
				return
			}
			writeJSON(w, http.StatusOK, rec)
		case id != "" && r.Method == http.MethodDelete:
			if err := st.delete(id); err != nil {
				httpError(w, err)
				return
			}
			w.WriteHeader(http.StatusNoContent)
		default:
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	}
}

// Meal is a saved combination of recipes cooked to finish together.
type Meal struct {
	ID        string   `json:"id"`
	Name      string   `json:"name"`
	RecipeIDs []string `json:"recipeIds"`
}

type MealStore struct {
	dir string
	mu  sync.RWMutex
}

func (st *MealStore) path(id string) (string, error) {
	if !idRe.MatchString(id) {
		return "", errBadID
	}
	return filepath.Join(st.dir, id+".json"), nil
}

func (st *MealStore) read(id string) (*Meal, error) {
	p, err := st.path(id)
	if err != nil {
		return nil, err
	}
	b, err := os.ReadFile(p)
	if err != nil {
		return nil, err
	}
	var m Meal
	if err := json.Unmarshal(b, &m); err != nil {
		return nil, err
	}
	m.ID = id
	return &m, nil
}

func (st *MealStore) write(m *Meal) error {
	p, err := st.path(m.ID)
	if err != nil {
		return err
	}
	if m.RecipeIDs == nil {
		m.RecipeIDs = []string{}
	}
	b, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, b, 0644); err != nil {
		return err
	}
	return os.Rename(tmp, p)
}

func (st *MealStore) create(m *Meal) error {
	st.mu.Lock()
	defer st.mu.Unlock()
	base := slugify(m.Name)
	id := base
	for i := 2; ; i++ {
		p, err := st.path(id)
		if err != nil {
			return err
		}
		if _, err := os.Stat(p); os.IsNotExist(err) {
			break
		}
		id = fmt.Sprintf("%s-%d", base, i)
	}
	m.ID = id
	return st.write(m)
}

func (st *MealStore) list() ([]*Meal, error) {
	st.mu.RLock()
	defer st.mu.RUnlock()
	entries, err := os.ReadDir(st.dir)
	if err != nil {
		return nil, err
	}
	out := []*Meal{}
	for _, e := range entries {
		id := strings.TrimSuffix(e.Name(), ".json")
		if e.IsDir() || id == e.Name() || !idRe.MatchString(id) {
			continue
		}
		m, err := st.read(id)
		if err != nil {
			log.Printf("skipping meal %s: %v", e.Name(), err)
			continue
		}
		out = append(out, m)
	}
	return out, nil
}

func mealsHandler(st *MealStore) http.HandlerFunc {
	decode := func(w http.ResponseWriter, r *http.Request) (*Meal, bool) {
		var m Meal
		r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
		if err := json.NewDecoder(r.Body).Decode(&m); err != nil {
			http.Error(w, "bad request body", http.StatusBadRequest)
			return nil, false
		}
		if strings.TrimSpace(m.Name) == "" {
			m.Name = "Untitled meal"
		}
		return &m, true
	}
	return func(w http.ResponseWriter, r *http.Request) {
		id := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/meals"), "/")
		switch {
		case id == "" && r.Method == http.MethodGet:
			meals, err := st.list()
			if err != nil {
				httpError(w, err)
				return
			}
			sort.Slice(meals, func(i, j int) bool { return meals[i].Name < meals[j].Name })
			writeJSON(w, http.StatusOK, meals)
		case id == "" && r.Method == http.MethodPost:
			m, ok := decode(w, r)
			if !ok {
				return
			}
			if err := st.create(m); err != nil {
				httpError(w, err)
				return
			}
			writeJSON(w, http.StatusCreated, m)
		case id != "" && r.Method == http.MethodGet:
			st.mu.RLock()
			m, err := st.read(id)
			st.mu.RUnlock()
			if err != nil {
				httpError(w, err)
				return
			}
			writeJSON(w, http.StatusOK, m)
		case id != "" && r.Method == http.MethodPut:
			m, ok := decode(w, r)
			if !ok {
				return
			}
			m.ID = id
			st.mu.Lock()
			err := st.write(m)
			st.mu.Unlock()
			if err != nil {
				httpError(w, err)
				return
			}
			writeJSON(w, http.StatusOK, m)
		case id != "" && r.Method == http.MethodDelete:
			p, err := st.path(id)
			if err != nil {
				httpError(w, err)
				return
			}
			st.mu.Lock()
			err = os.Remove(p)
			st.mu.Unlock()
			if err != nil {
				httpError(w, err)
				return
			}
			w.WriteHeader(http.StatusNoContent)
		default:
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	}
}

func noCache(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-cache")
		h.ServeHTTP(w, r)
	})
}

func main() {
	addr := flag.String("addr", ":8080", "listen address")
	dataDir := flag.String("data", "data", "recipe storage directory")
	staticDir := flag.String("static", "static", "static files directory")
	importGuardian := flag.Bool("import-guardian", false, "import every Guardian recipe, then exit")
	flag.Parse()

	if err := os.MkdirAll(*dataDir, 0755); err != nil {
		log.Fatal(err)
	}
	mealsDir := filepath.Join(*dataDir, "meals")
	if err := os.MkdirAll(mealsDir, 0755); err != nil {
		log.Fatal(err)
	}
	st := &Store{dir: *dataDir}
	ms := &MealStore{dir: mealsDir}

	if *importGuardian {
		res, err := syncGuardian(st, 0)
		if err != nil {
			log.Fatal(err)
		}
		log.Printf("imported %d Guardian recipes (%d already held, %d failed) in %s",
			res.Added, res.Already, res.Failed, res.Took)
		return
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/api/recipes", apiHandler(st))
	mux.HandleFunc("/api/recipes/", apiHandler(st))
	mux.HandleFunc("/api/guardian/sync", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			writeJSON(w, http.StatusOK, syncStatus())
		case http.MethodPost:
			limit := 500
			fmt.Sscanf(r.URL.Query().Get("limit"), "%d", &limit)
			writeJSON(w, http.StatusOK, startSyncGuardian(st, limit))
		default:
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	})
	mux.HandleFunc("/api/meals", mealsHandler(ms))
	mux.HandleFunc("/api/meals/", mealsHandler(ms))
	// without this browsers apply heuristic freshness and can sit on a stale
	// script for hours; "no-cache" still allows 304s, it just forces a revalidate
	mux.Handle("/", noCache(http.FileServer(http.Dir(*staticDir))))

	// Listen explicitly so the resolved address is logged. A bare ":8080" will
	// silently fall back to IPv6-only if another process already holds the IPv4
	// address, leaving the server reachable on [::1] but not 127.0.0.1.
	ln, err := net.Listen("tcp", *addr)
	if err != nil {
		log.Fatalf("cannot listen on %s: %v", *addr, err)
	}
	log.Printf("teatime listening on %s (data %s)", ln.Addr(), *dataDir)
	if tcp, ok := ln.Addr().(*net.TCPAddr); ok && tcp.IP.To4() == nil && !tcp.IP.IsUnspecified() {
		log.Printf("warning: bound IPv6 only — 127.0.0.1:%d will not reach this server", tcp.Port)
	}
	log.Fatal(http.Serve(ln, mux))
}
