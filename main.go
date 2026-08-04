package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
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
}

type Recipe struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	Description string   `json:"description"`
	Ingredients []string `json:"ingredients"`
	Lanes       []Lane   `json:"lanes"`
	Steps       []Step   `json:"steps"`
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
}

// Store keeps one JSON file per recipe under dir; the filename is the id.
type Store struct {
	dir string
	mu  sync.RWMutex
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
		switch {
		case id == "" && r.Method == http.MethodGet:
			recipes, err := st.list()
			if err != nil {
				httpError(w, err)
				return
			}
			q := strings.ToLower(r.URL.Query().Get("q"))
			sums := []Summary{}
			for _, rec := range recipes {
				if q != "" && !strings.Contains(strings.ToLower(rec.Name), q) &&
					!strings.Contains(strings.ToLower(rec.Description), q) {
					continue
				}
				sums = append(sums, Summary{rec.ID, rec.Name, rec.Description, rec.total()})
			}
			sort.Slice(sums, func(i, j int) bool { return sums[i].Name < sums[j].Name })
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

func main() {
	addr := flag.String("addr", ":8080", "listen address")
	dataDir := flag.String("data", "data", "recipe storage directory")
	staticDir := flag.String("static", "static", "static files directory")
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

	mux := http.NewServeMux()
	mux.HandleFunc("/api/recipes", apiHandler(st))
	mux.HandleFunc("/api/recipes/", apiHandler(st))
	mux.HandleFunc("/api/meals", mealsHandler(ms))
	mux.HandleFunc("/api/meals/", mealsHandler(ms))
	mux.Handle("/", http.FileServer(http.Dir(*staticDir)))

	log.Printf("teatime listening on %s", *addr)
	log.Fatal(http.ListenAndServe(*addr, mux))
}
