package main

// Imports recipes from the Guardian's public Feast backend, which serves fully
// structured recipes (parsed ingredients, ordered steps, timings) with no auth.
// See FETCHING.md.

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	gIndexURL   = "https://recipes.guardianapis.com/index.json"
	gContentURL = "https://recipes.guardianapis.com/content/"
	gCacheDir   = "guardian-cache/recipes"
)

type gEntry struct {
	Checksum      string `json:"checksum"`
	RecipeUID     string `json:"recipeUID"`
	CapiArticleID string `json:"capiArticleId"`
}

type gIndex struct {
	Recipes     []gEntry `json:"recipes"`
	LastUpdated string   `json:"lastUpdated"`
}

type gRecipe struct {
	Title            string   `json:"title"`
	Description      string   `json:"description"`
	CanonicalArticle string   `json:"canonicalArticle"`
	Contributors     []string `json:"contributors"`
	Serves           []struct {
		Text string `json:"text"`
	} `json:"serves"`
	Timings []struct {
		Text           string `json:"text"`
		DurationInMins struct{ Min, Max int } `json:"durationInMins"`
	} `json:"timings"`
	Ingredients []struct {
		RecipeSection   string `json:"recipeSection"`
		IngredientsList []struct {
			Text string `json:"text"`
		} `json:"ingredientsList"`
	} `json:"ingredients"`
	Instructions []struct {
		Description string `json:"description"`
	} `json:"instructions"`
}

func gGet(url string) ([]byte, error) {
	req, _ := http.NewRequest("GET", url, nil)
	req.Header.Set("User-Agent", "teatime personal recipe importer")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		io.Copy(io.Discard, res.Body)
		return nil, fmt.Errorf("%s: %s", url, res.Status)
	}
	return io.ReadAll(res.Body)
}

func fetchGuardianIndex() (*gIndex, error) {
	b, err := gGet(gIndexURL)
	if err != nil {
		return nil, err
	}
	var idx gIndex
	if err := json.Unmarshal(b, &idx); err != nil {
		return nil, err
	}
	return &idx, nil
}

var (
	idxMu    sync.Mutex
	idxCache *gIndex
	idxAt    time.Time
)

// The index is 2MB, so hold it briefly rather than re-fetching per lookup.
func guardianIndexCached() (*gIndex, error) {
	idxMu.Lock()
	defer idxMu.Unlock()
	if idxCache != nil && time.Since(idxAt) < time.Hour {
		return idxCache, nil
	}
	idx, err := fetchGuardianIndex()
	if err != nil {
		return nil, err
	}
	idxCache, idxAt = idx, time.Now()
	return idx, nil
}

// The recipe as the Guardian published it, for showing alongside the editor.
func guardianSource(uid string) (*gRecipe, error) {
	if b, err := os.ReadFile(filepath.Join(gCacheDir, uid+".json")); err == nil {
		var r gRecipe
		if json.Unmarshal(b, &r) == nil && len(r.Instructions) > 0 {
			return &r, nil
		}
	}
	idx, err := guardianIndexCached()
	if err != nil {
		return nil, err
	}
	for _, e := range idx.Recipes {
		if e.RecipeUID == uid {
			return fetchGuardianRecipe(e)
		}
	}
	return nil, fmt.Errorf("no source held for %s", uid)
}

// prefers the local mirror, so a bulk import doesn't re-fetch what we have
func fetchGuardianRecipe(e gEntry) (*gRecipe, error) {
	b, err := os.ReadFile(filepath.Join(gCacheDir, e.RecipeUID+".json"))
	if err != nil {
		if b, err = gGet(gContentURL + e.Checksum); err != nil {
			return nil, err
		}
	}
	var r gRecipe
	if err := json.Unmarshal(b, &r); err != nil {
		return nil, err
	}
	return &r, nil
}

/* ---------- turning prose into a timeline ---------- */

var (
	gDurRe = regexp.MustCompile(`(?i)\b(\d+(?:\.\d+)?)\s*(?:-|–|—|\s+to\s+|\s+or\s+)?\s*(\d+(?:\.\d+)?)?\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?)\b`)
	// time you are not standing over the pan
	gPassiveRe = regexp.MustCompile(`(?i)\b(bake|baking|roast|roasting|simmer|simmering|chill|chilling|rest|resting|prove|proving|proof|marinate|marinating|soak|soaking|steam|steaming|reduce|reducing|infuse|infusing|refrigerat|freez|cool|braise|braising|slow-cook|leave|stand)`)
	// a step written to run alongside the one before it
	gMeanwhileRe = regexp.MustCompile(`(?i)^\s*(meanwhile|in the meantime|while (the|this|that|it|they)|as (the|this|it) [a-z]+s\b)`)
)

func parseStepDuration(text string) int {
	best := 0
	for _, m := range gDurRe.FindAllStringSubmatch(text, -1) {
		v, err := strconv.ParseFloat(m[1], 64)
		if err != nil {
			continue
		}
		if m[2] != "" { // a range: take the upper end
			if hi, err := strconv.ParseFloat(m[2], 64); err == nil && hi > v {
				v = hi
			}
		}
		unit := strings.ToLower(m[3])
		switch {
		case strings.HasPrefix(unit, "sec"):
			continue // ignore "stir for 30 seconds"
		case strings.HasPrefix(unit, "hour"), strings.HasPrefix(unit, "hr"):
			v *= 3600
		default:
			v *= 60
		}
		if int(v) > best {
			best = int(v)
		}
	}
	return best
}

func round30(sec int) int {
	if sec < 30 {
		return 30
	}
	return (sec + 15) / 30 * 30
}

func stepName(text string) string {
	name := text
	if n := strings.IndexAny(name, ".,;:"); n > 10 && n < 46 {
		name = name[:n]
	} else if len(name) > 46 {
		if sp := strings.LastIndex(name[:46], " "); sp > 10 {
			name = name[:sp]
		} else {
			name = name[:46]
		}
	}
	return strings.TrimSpace(name)
}

// Builds a timeline: durations read out of the prose where stated, steps
// beginning "meanwhile" moved into a parallel lane so they overlap the passive
// step they were written to fill, and alarms on unattended stretches. This is a
// mechanical schedule, not a considered one — it does not work backwards from
// serving so that components land together.
func convertGuardian(r *gRecipe, uid string) *Recipe {
	type st struct {
		name, text        string
		dur               int
		explicit, passive bool
		lane, start       int
	}
	steps := make([]st, len(r.Instructions))
	statedTotal := 0
	for _, t := range r.Timings {
		statedTotal += t.DurationInMins.Max * 60
	}

	explicitSum, unknown := 0, 0
	for i, ins := range r.Instructions {
		d := parseStepDuration(ins.Description)
		s := st{text: ins.Description, dur: d, explicit: d > 0, name: stepName(ins.Description)}
		s.passive = d >= 300 && gPassiveRe.MatchString(ins.Description)
		if d > 0 {
			explicitSum += d
		} else {
			unknown++
		}
		steps[i] = s
	}

	fill := 120
	if unknown > 0 && statedTotal > explicitSum {
		fill = (statedTotal - explicitSum) / unknown
	}
	for i := range steps {
		steps[i].dur = round30(steps[i].dur)
		if !steps[i].explicit {
			steps[i].dur = round30(fill)
		}
	}

	laneEnd := []int{0, 0}
	usedSecond := false
	for i := range steps {
		if i > 0 && gMeanwhileRe.MatchString(steps[i].text) && steps[i-1].passive && steps[i-1].lane == 0 {
			start := steps[i-1].start
			if laneEnd[1] > start {
				start = laneEnd[1]
			}
			// only worth a lane if it genuinely fits inside the passive window
			if start+steps[i].dur <= steps[i-1].start+steps[i-1].dur {
				steps[i].lane, steps[i].start = 1, start
				laneEnd[1] = start + steps[i].dur
				usedSecond = true
				continue
			}
		}
		start := laneEnd[0]
		if laneEnd[1] > start {
			start = laneEnd[1] // don't resume the spine until parallel work is done
		}
		steps[i].lane, steps[i].start = 0, start
		laneEnd[0] = start + steps[i].dur
	}

	lanes := []Lane{{ID: "l-main", Name: "Main"}}
	if usedSecond {
		lanes = append(lanes, Lane{ID: "l-alongside", Name: "Alongside"})
	}

	out := make([]Step, len(steps))
	for i, s := range steps {
		lane := "l-main"
		if s.lane == 1 {
			lane = "l-alongside"
		}
		alarm := ""
		if s.passive && s.explicit {
			alarm = "end"
		}
		out[i] = Step{
			ID: fmt.Sprintf("s-%02d", i+1), LaneID: lane, Name: s.name,
			Instructions: s.text, Start: s.start, Duration: s.dur, Alarm: alarm,
		}
	}

	var ingredients []string
	for _, g := range r.Ingredients {
		if s := strings.TrimSpace(g.RecipeSection); s != "" {
			ingredients = append(ingredients, s+":")
		}
		for _, i := range g.IngredientsList {
			ingredients = append(ingredients, i.Text)
		}
	}

	desc := strings.TrimSpace(r.Description)
	var bits []string
	if len(r.Serves) > 0 {
		bits = append(bits, r.Serves[0].Text)
	}
	for _, t := range r.Timings {
		bits = append(bits, t.Text)
	}
	if len(bits) > 0 {
		if desc != "" && !strings.HasSuffix(desc, ".") {
			desc += "."
		}
		desc = strings.TrimSpace(desc + " " + strings.Join(bits, ", ") + ".")
	}

	name := strings.TrimSpace(r.Title)
	if name == "" {
		name = "Untitled Guardian recipe"
	}
	return &Recipe{
		Name: name, Description: desc, Ingredients: ingredients,
		Lanes: lanes, Steps: out,
		Source: &Source{
			Type: "guardian", UID: uid,
			URL:          "https://www.theguardian.com/" + r.CanonicalArticle,
			Contributors: r.Contributors,
		},
	}
}

/* ---------- syncing into the store ---------- */

// Two lists of Guardian ids the sync must not import: ones that are permanently
// unavailable (403, or content that won't parse), and ones you have deleted.
// Without the second, deleting an imported recipe just means the next check
// fetches it again. Dotfiles, so the recipe listing ignores them.
func unavailablePath(st *Store) string {
	return filepath.Join(st.dir, ".guardian-unavailable.json")
}

func deletedPath(st *Store) string {
	return filepath.Join(st.dir, ".guardian-deleted.json")
}

func loadIDSet(path string) map[string]bool {
	out := map[string]bool{}
	b, err := os.ReadFile(path)
	if err != nil {
		return out
	}
	var ids []string
	json.Unmarshal(b, &ids)
	for _, id := range ids {
		out[id] = true
	}
	return out
}

func saveIDSet(path string, m map[string]bool) {
	ids := make([]string, 0, len(m))
	for id := range m {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	b, _ := json.MarshalIndent(ids, "", " ")
	os.WriteFile(path, b, 0644)
}

// The deleted ledger maps uid -> recipe name, so the Hidden page can list what
// was removed by name. Older deployments wrote a bare array of uids; those load
// with empty names.
func loadDeleted(path string) map[string]string {
	out := map[string]string{}
	b, err := os.ReadFile(path)
	if err != nil {
		return out
	}
	if json.Unmarshal(b, &out) == nil {
		return out
	}
	var ids []string
	if json.Unmarshal(b, &ids) == nil {
		for _, id := range ids {
			out[id] = ""
		}
	}
	return out
}

func saveDeleted(path string, m map[string]string) {
	if len(m) == 0 {
		os.Remove(path)
		return
	}
	b, _ := json.MarshalIndent(m, "", " ")
	os.WriteFile(path, b, 0644)
}

// Called when a recipe is deleted over the API, so the next check brings it
// back hidden rather than in plain sight.
func recordGuardianDeletion(st *Store, rec *Recipe) {
	if rec == nil || rec.Source == nil || rec.Source.Type != "guardian" || rec.Source.UID == "" {
		return
	}
	m := loadDeleted(deletedPath(st))
	if _, ok := m[rec.Source.UID]; ok {
		return
	}
	m[rec.Source.UID] = rec.Name
	saveDeleted(deletedPath(st), m)
	log.Printf("guardian: %q deleted, will return hidden on the next check", rec.Name)
}

// Progress of an import, polled by the browser while it runs.
type SyncState struct {
	Running bool     `json:"running"`
	Stage   string   `json:"stage"`
	Indexed int      `json:"indexed"`
	Already int      `json:"already"`
	ToFetch int      `json:"toFetch"`
	Added       int    `json:"added"`
	Failed      int    `json:"failed"`
	Unavailable int    `json:"unavailable"`
	Restored    int    `json:"restored"` // previously deleted, brought back hidden
	Current     string `json:"current"`
	Names   []string `json:"names,omitempty"`
	Partial bool     `json:"partial,omitempty"`
	Err     string   `json:"error,omitempty"`
	Took    string   `json:"took,omitempty"`
	Done    bool     `json:"done"`
}

var (
	syncMu    sync.Mutex
	syncState SyncState
)

func syncStatus() SyncState {
	syncMu.Lock()
	defer syncMu.Unlock()
	return syncState
}

func setSync(f func(*SyncState)) {
	syncMu.Lock()
	defer syncMu.Unlock()
	f(&syncState)
}

// Starts an import in the background if one isn't already going, and returns the
// state immediately so the caller can poll.
func startSyncGuardian(st *Store, limit int) SyncState {
	syncMu.Lock()
	if syncState.Running {
		s := syncState
		syncMu.Unlock()
		return s
	}
	syncState = SyncState{Running: true, Stage: "Fetching the Guardian index"}
	syncMu.Unlock()

	go runSyncGuardian(st, limit)
	return syncStatus()
}

func runSyncGuardian(st *Store, limit int) {
	start := time.Now()
	finish := func() {
		setSync(func(s *SyncState) {
			s.Running, s.Done, s.Current = false, true, ""
			s.Took = time.Since(start).Round(time.Millisecond).String()
			if s.Err == "" {
				s.Stage = "Finished"
			}
		})
	}

	idx, err := fetchGuardianIndex()
	if err != nil {
		setSync(func(s *SyncState) { s.Err = err.Error(); s.Stage = "Could not reach the Guardian" })
		finish()
		return
	}
	setSync(func(s *SyncState) {
		s.Indexed = len(idx.Recipes)
		s.Stage = "Checking what we already have"
	})

	have, err := st.guardianUIDs()
	if err != nil {
		setSync(func(s *SyncState) { s.Err = err.Error(); s.Stage = "Could not read the recipe store" })
		finish()
		return
	}

	dead := loadIDSet(unavailablePath(st))
	// Recipes deleted before hiding existed: imported like any other below,
	// but arrive hidden, and their ledger entry is dropped once handled.
	deleted := loadDeleted(deletedPath(st))
	var todo []gEntry
	already, unavailable := 0, 0
	for _, e := range idx.Recipes {
		if have[e.RecipeUID] {
			already++
			continue
		}
		if dead[e.RecipeUID] {
			unavailable++
			continue
		}
		todo = append(todo, e)
	}
	setSync(func(s *SyncState) { s.Unavailable = unavailable })
	partial := false
	if limit > 0 && len(todo) > limit {
		todo, partial = todo[:limit], true
	}
	setSync(func(s *SyncState) {
		s.Already, s.ToFetch, s.Partial = already, len(todo), partial
		s.Stage = "Importing"
		if len(todo) == 0 {
			s.Stage = "Already up to date"
		}
	})

	newlyDead, ledgerDirty := false, false
	for _, e := range todo {
		_, wasDeleted := deleted[e.RecipeUID]
		gr, err := fetchGuardianRecipe(e)
		if err != nil || len(gr.Instructions) == 0 || strings.TrimSpace(gr.Title) == "" {
			setSync(func(s *SyncState) { s.Failed++ })
			dead[e.RecipeUID], newlyDead = true, true
			if wasDeleted { // the dead list covers it from here
				delete(deleted, e.RecipeUID)
				ledgerDirty = true
			}
			continue
		}
		rec := convertGuardian(gr, e.RecipeUID)
		rec.Hidden = wasDeleted
		if err := st.create(rec); err != nil {
			setSync(func(s *SyncState) { s.Failed++ })
			continue
		}
		if wasDeleted {
			delete(deleted, e.RecipeUID)
			ledgerDirty = true
		}
		setSync(func(s *SyncState) {
			s.Added++
			if wasDeleted {
				s.Restored++
			}
			s.Current = rec.Name
			if len(s.Names) < 100 {
				s.Names = append(s.Names, rec.Name)
			}
		})
	}

	if newlyDead {
		saveIDSet(unavailablePath(st), dead)
	}
	if ledgerDirty {
		saveDeleted(deletedPath(st), deleted)
	}
	finish()
	s := syncStatus()
	log.Printf("guardian sync: %d indexed, %d already held, %d added, %d failed, %d unavailable in %s",
		s.Indexed, s.Already, s.Added, s.Failed, s.Unavailable, s.Took)
}

// Blocking import used by -import-guardian.
func syncGuardian(st *Store, limit int) (*SyncState, error) {
	startSyncGuardian(st, limit)
	for {
		s := syncStatus()
		if !s.Running {
			if s.Err != "" {
				return &s, fmt.Errorf("%s", s.Err)
			}
			return &s, nil
		}
		time.Sleep(250 * time.Millisecond)
	}
}
