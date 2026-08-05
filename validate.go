//go:build ignore

// Checks every recipe in the data directory for the invariants the timeline
// format relies on. Run: go run validate.go [-data data]
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

type lane struct{ ID, Name string }

type step struct {
	ID, LaneID, Name, Instructions string
	Start, Duration                int
	Alarm                          string
}

type recipe struct {
	ID, Name, Description string
	Ingredients           []string
	Lanes                 []lane
	Steps                 []step
}

func main() {
	dir := flag.String("data", "data", "recipe directory")
	flag.Parse()

	entries, err := os.ReadDir(*dir)
	if err != nil {
		fmt.Println(err)
		os.Exit(1)
	}
	var bad, total int
	for _, e := range entries {
		// dotfiles are the store's own bookkeeping, not recipes
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") || strings.HasPrefix(e.Name(), ".") {
			continue
		}
		total++
		b, err := os.ReadFile(filepath.Join(*dir, e.Name()))
		if err != nil {
			fmt.Printf("%-46s UNREADABLE %v\n", e.Name(), err)
			bad++
			continue
		}
		var r recipe
		if err := json.Unmarshal(b, &r); err != nil {
			fmt.Printf("%-46s BAD JSON %v\n", e.Name(), err)
			bad++
			continue
		}
		if problems := check(&r); len(problems) > 0 {
			bad++
			fmt.Printf("%-46s %s\n", e.Name(), problems[0])
			for _, p := range problems[1:] {
				fmt.Printf("%-46s %s\n", "", p)
			}
		}
	}
	fmt.Printf("\n%d recipes, %d with problems\n", total, bad)
	if bad > 0 {
		os.Exit(1)
	}
}

func check(r *recipe) []string {
	var out []string
	if strings.TrimSpace(r.Name) == "" {
		out = append(out, "no name")
	}
	if len(r.Steps) == 0 {
		return append(out, "NO STEPS")
	}
	if len(r.Ingredients) == 0 {
		out = append(out, "no ingredients")
	}

	lanes := map[string]bool{}
	for _, l := range r.Lanes {
		lanes[l.ID] = true
	}

	// every step references a real lane, has sane numbers and a valid alarm
	min := r.Steps[0].Start
	byLane := map[string][]step{}
	for _, s := range r.Steps {
		if !lanes[s.LaneID] {
			out = append(out, fmt.Sprintf("step %q references missing lane %q", s.Name, s.LaneID))
		}
		if s.Duration <= 0 {
			out = append(out, fmt.Sprintf("step %q has duration %d", s.Name, s.Duration))
		}
		if s.Start < 0 {
			out = append(out, fmt.Sprintf("step %q starts at %d", s.Name, s.Start))
		}
		switch s.Alarm {
		case "", "start", "end", "both":
		default:
			out = append(out, fmt.Sprintf("step %q has invalid alarm %q", s.Name, s.Alarm))
		}
		if s.Start < min {
			min = s.Start
		}
		byLane[s.LaneID] = append(byLane[s.LaneID], s)
	}
	if min != 0 {
		out = append(out, fmt.Sprintf("earliest step starts at %ds, not 0 (dead time at the front)", min))
	}

	// no two steps overlap within a lane
	for id, ss := range byLane {
		sort.Slice(ss, func(i, j int) bool { return ss[i].Start < ss[j].Start })
		for i := 1; i < len(ss); i++ {
			prevEnd := ss[i-1].Start + ss[i-1].Duration
			if ss[i].Start < prevEnd {
				out = append(out, fmt.Sprintf("lane %q: %q overlaps %q by %ds",
					id, ss[i].Name, ss[i-1].Name, prevEnd-ss[i].Start))
			}
		}
	}
	return out
}
