package main

// Accounts: who may sign in, and each person's own state (stars, hidden
// recipes, cook counts). Recipes themselves stay shared.
//
//	data/.users.json     accounts and password hashes
//	data/.session-key    random HMAC key for session cookies
//	data/users/<name>.json  one person's stars, hidden recipes and cook counts
//
// Passwords are PBKDF2-HMAC-SHA256. With no accounts file and no
// TEATIME_PASSWORD the site is open and everyone acts as the admin "local".

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	roleAdmin = "admin"
	roleUser  = "user"

	pbkdfIter   = 150000
	minPassword = 8
	localUser   = "local" // the acting user when the site is open
)

var userRe = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,31}$`)

type User struct {
	Name    string `json:"name"`
	Role    string `json:"role"`
	Salt    string `json:"salt"`
	Hash    string `json:"hash"`
	Iter    int    `json:"iter"`
	Gen     int    `json:"gen"` // bumped on a password change, signing the user out elsewhere
	Created string `json:"created"`
}

type Accounts struct {
	dir  string // data directory
	open bool   // no accounts: no login required

	mu    sync.RWMutex
	users map[string]*User
	key   []byte

	basicMu sync.Mutex
	basicOK map[string]bool // verified basic-auth credentials, so scripts don't re-hash every request

	stMu   sync.Mutex
	states map[string]*userState
}

func pbkdf2(pass, salt []byte, iter int) []byte {
	prf := hmac.New(sha256.New, pass)
	prf.Write(salt)
	prf.Write([]byte{0, 0, 0, 1})
	u := prf.Sum(nil)
	t := append([]byte(nil), u...)
	for i := 1; i < iter; i++ {
		prf.Reset()
		prf.Write(u)
		u = prf.Sum(u[:0])
		for j := range t {
			t[j] ^= u[j]
		}
	}
	return t
}

func (u *User) setPassword(pass string) error {
	if len(pass) < minPassword {
		return errors.New("password must be at least 8 characters")
	}
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return err
	}
	u.Salt = base64.RawStdEncoding.EncodeToString(salt)
	u.Iter = pbkdfIter
	u.Hash = base64.RawStdEncoding.EncodeToString(pbkdf2([]byte(pass), salt, u.Iter))
	u.Gen++
	return nil
}

func (u *User) check(pass string) bool {
	salt, err1 := base64.RawStdEncoding.DecodeString(u.Salt)
	want, err2 := base64.RawStdEncoding.DecodeString(u.Hash)
	if err1 != nil || err2 != nil || u.Iter < 1 {
		return false
	}
	return subtle.ConstantTimeCompare(pbkdf2([]byte(pass), salt, u.Iter), want) == 1
}

func (a *Accounts) usersPath() string { return filepath.Join(a.dir, ".users.json") }

func (a *Accounts) load() error {
	b, err := os.ReadFile(a.usersPath())
	if err != nil {
		return err
	}
	var f struct {
		Users []*User `json:"users"`
	}
	if err := json.Unmarshal(b, &f); err != nil {
		return err
	}
	a.users = map[string]*User{}
	for _, u := range f.Users {
		a.users[u.Name] = u
	}
	return nil
}

// caller holds a.mu
func (a *Accounts) save() error {
	list := make([]*User, 0, len(a.users))
	for _, u := range a.users {
		list = append(list, u)
	}
	sort.Slice(list, func(i, j int) bool { return list[i].Name < list[j].Name })
	b, err := json.MarshalIndent(map[string]any{"users": list}, "", "  ")
	if err != nil {
		return err
	}
	return writeFileAtomic(a.usersPath(), b, 0600)
}

func writeFileAtomic(p string, b []byte, mode os.FileMode) error {
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, b, mode); err != nil {
		return err
	}
	return os.Rename(tmp, p)
}

func (a *Accounts) loadKey() error {
	p := filepath.Join(a.dir, ".session-key")
	if b, err := os.ReadFile(p); err == nil && len(b) >= 32 {
		a.key = b
		return nil
	}
	k := make([]byte, 32)
	if _, err := rand.Read(k); err != nil {
		return err
	}
	a.key = k
	return writeFileAtomic(p, k, 0600)
}

// newAccounts opens the accounts file. With none, TEATIME_PASSWORD bootstraps
// the first admin (TEATIME_USER, default "admin") and hands them the state the
// site had before accounts existed; with neither the site stays open.
func newAccounts(dir string, st *Store, ms *MealStore) *Accounts {
	a := &Accounts{
		dir: dir, users: map[string]*User{},
		basicOK: map[string]bool{}, states: map[string]*userState{},
	}
	if err := os.MkdirAll(filepath.Join(dir, "users"), 0755); err != nil {
		log.Fatal(err)
	}
	err := a.load()
	switch {
	case err == nil:
		if os.Getenv("TEATIME_PASSWORD") != "" {
			log.Printf("accounts exist: TEATIME_PASSWORD/TEATIME_USER are ignored; manage users on the Manage page")
		}
	case os.IsNotExist(err):
		pass := os.Getenv("TEATIME_PASSWORD")
		if pass == "" {
			log.Printf("no accounts and TEATIME_PASSWORD not set: no login required")
			a.open = true
			if _, err := os.Stat(a.statePath(localUser)); os.IsNotExist(err) {
				a.migrateLegacy(st, ms, localUser)
			}
			return a
		}
		name := strings.ToLower(os.Getenv("TEATIME_USER"))
		if name == "" {
			name = "admin"
		}
		if !userRe.MatchString(name) {
			log.Fatalf("TEATIME_USER %q: use lowercase letters, digits and hyphens (up to 32)", name)
		}
		u := &User{Name: name, Role: roleAdmin, Created: time.Now().Format(time.RFC3339)}
		if err := u.setPassword(pass); err != nil {
			log.Fatalf("TEATIME_PASSWORD: %v", err)
		}
		a.users[name] = u
		if err := a.save(); err != nil {
			log.Fatal(err)
		}
		log.Printf("created admin %q from TEATIME_PASSWORD", name)
		a.migrateLegacy(st, ms, name)
	default:
		log.Fatalf("reading accounts: %v", err)
	}
	if err := a.loadKey(); err != nil {
		log.Fatal(err)
	}
	return a
}

// migrateLegacy moves the pre-accounts global stars and cook counts, and the
// unowned saved meals, to one person. Hiding stays as it was (recipe-wide).
func (a *Accounts) migrateLegacy(st *Store, ms *MealStore, owner string) {
	s := a.state(owner)
	recipes, err := st.list()
	if err != nil {
		log.Printf("migrate: %v", err)
	}
	n := 0
	for _, r := range recipes {
		if !r.Starred && r.Cooked == 0 {
			continue
		}
		if r.Starred {
			s.setStar(r.ID, true)
		}
		if r.Cooked > 0 {
			s.setCooked(r.ID, r.Cooked)
		}
		r.Starred, r.Cooked = false, 0
		if err := st.put(r); err != nil {
			log.Printf("migrate %s: %v", r.ID, err)
		}
		n++
	}
	meals, _ := ms.list()
	m := 0
	for _, ml := range meals {
		if ml.Owner == "" {
			ml.Owner = owner
			ms.mu.Lock()
			err := ms.write(ml)
			ms.mu.Unlock()
			if err == nil {
				m++
			}
		}
	}
	s.touch() // leaves a state file even when empty, marking the migration done
	log.Printf("migrated %d recipes and %d meals to %q", n, m, owner)
}

/* ---------- users ---------- */

func (a *Accounts) get(name string) *User {
	a.mu.RLock()
	defer a.mu.RUnlock()
	if u := a.users[name]; u != nil {
		c := *u
		return &c
	}
	return nil
}

// authenticate checks a name and password. Unknown names still pay for a hash.
func (a *Accounts) authenticate(name, pass string) *User {
	u := a.get(strings.ToLower(name))
	if u == nil {
		dummy := &User{Salt: "AAAAAAAAAAAAAAAAAAAAAA", Hash: "AAAA", Iter: pbkdfIter}
		dummy.check(pass)
		return nil
	}
	if !u.check(pass) {
		return nil
	}
	return u
}

// authenticateBasic is authenticate with a cache of credentials already
// verified, since scripts send them on every request.
func (a *Accounts) authenticateBasic(name, pass string) *User {
	u := a.get(strings.ToLower(name))
	if u == nil {
		return a.authenticate(name, pass)
	}
	m := hmac.New(sha256.New, a.key)
	m.Write([]byte(u.Name + "\x00" + pass + "\x00" + u.Hash))
	tok := hex.EncodeToString(m.Sum(nil))
	a.basicMu.Lock()
	ok := a.basicOK[tok]
	a.basicMu.Unlock()
	if ok {
		return u
	}
	if !u.check(pass) {
		return nil
	}
	a.basicMu.Lock()
	if len(a.basicOK) > 256 {
		a.basicOK = map[string]bool{}
	}
	a.basicOK[tok] = true
	a.basicMu.Unlock()
	return u
}

func (a *Accounts) admins() int {
	n := 0
	for _, u := range a.users {
		if u.Role == roleAdmin {
			n++
		}
	}
	return n
}

var (
	errExists   = errors.New("that name is taken")
	errNoUser   = errors.New("no such user")
	errLastAdmn = errors.New("there must be at least one admin")
)

func (a *Accounts) add(name, pass, role string) error {
	name = strings.ToLower(strings.TrimSpace(name))
	if !userRe.MatchString(name) {
		return errors.New("name: lowercase letters, digits and hyphens, up to 32")
	}
	if role != roleAdmin {
		role = roleUser
	}
	u := &User{Name: name, Role: role, Created: time.Now().Format(time.RFC3339)}
	if err := u.setPassword(pass); err != nil {
		return err
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.users[name] != nil || name == localUser {
		return errExists
	}
	a.users[name] = u
	return a.save()
}

// update changes a role and/or password; empty strings leave a field alone.
func (a *Accounts) update(name, pass, role string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	u := a.users[name]
	if u == nil {
		return errNoUser
	}
	if role != "" && role != u.Role {
		if role != roleAdmin && role != roleUser {
			return errors.New("role must be admin or user")
		}
		if u.Role == roleAdmin && a.admins() <= 1 {
			return errLastAdmn
		}
		u.Role = role
	}
	if pass != "" {
		if err := u.setPassword(pass); err != nil {
			return err
		}
	}
	return a.save()
}

func (a *Accounts) remove(name string) error {
	a.mu.Lock()
	u := a.users[name]
	if u == nil {
		a.mu.Unlock()
		return errNoUser
	}
	if u.Role == roleAdmin && a.admins() <= 1 {
		a.mu.Unlock()
		return errLastAdmn
	}
	delete(a.users, name)
	err := a.save()
	a.mu.Unlock()
	if err == nil {
		a.stMu.Lock()
		delete(a.states, name)
		a.stMu.Unlock()
		os.Remove(a.statePath(name))
	}
	return err
}

func (a *Accounts) list() []User {
	a.mu.RLock()
	defer a.mu.RUnlock()
	out := make([]User, 0, len(a.users))
	for _, u := range a.users {
		out = append(out, User{Name: u.Name, Role: u.Role, Created: u.Created})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

/* ---------- per-user state ---------- */

type userState struct {
	path string

	mu      sync.Mutex
	starred map[string]bool
	hidden  map[string]bool
	cooked  map[string]int
}

// a copy to read from without holding the lock
type stateView struct {
	starred, hidden map[string]bool
	cooked          map[string]int
}

func (a *Accounts) statePath(name string) string {
	return filepath.Join(a.dir, "users", name+".json")
}

func (a *Accounts) state(name string) *userState {
	a.stMu.Lock()
	defer a.stMu.Unlock()
	if s := a.states[name]; s != nil {
		return s
	}
	s := &userState{
		path: a.statePath(name), starred: map[string]bool{},
		hidden: map[string]bool{}, cooked: map[string]int{},
	}
	if b, err := os.ReadFile(s.path); err == nil {
		var f struct {
			Starred []string       `json:"starred"`
			Hidden  []string       `json:"hidden"`
			Cooked  map[string]int `json:"cooked"`
		}
		if json.Unmarshal(b, &f) == nil {
			for _, id := range f.Starred {
				s.starred[id] = true
			}
			for _, id := range f.Hidden {
				s.hidden[id] = true
			}
			for id, n := range f.Cooked {
				s.cooked[id] = n
			}
		}
	}
	a.states[name] = s
	return s
}

// forget drops cached state, e.g. after a restore replaced the files
func (a *Accounts) forgetStates() {
	a.stMu.Lock()
	a.states = map[string]*userState{}
	a.stMu.Unlock()
}

func (s *userState) saveLocked() {
	keys := func(m map[string]bool) []string {
		out := make([]string, 0, len(m))
		for k := range m {
			out = append(out, k)
		}
		sort.Strings(out)
		return out
	}
	b, err := json.MarshalIndent(map[string]any{
		"starred": keys(s.starred), "hidden": keys(s.hidden), "cooked": s.cooked,
	}, "", "  ")
	if err == nil {
		err = writeFileAtomic(s.path, b, 0644)
	}
	if err != nil {
		log.Printf("saving %s: %v", s.path, err)
	}
}

func (s *userState) touch() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.saveLocked()
}

func (s *userState) view() stateView {
	s.mu.Lock()
	defer s.mu.Unlock()
	v := stateView{map[string]bool{}, map[string]bool{}, map[string]int{}}
	for k := range s.starred {
		v.starred[k] = true
	}
	for k := range s.hidden {
		v.hidden[k] = true
	}
	for k, n := range s.cooked {
		v.cooked[k] = n
	}
	return v
}

func setIn(m map[string]bool, id string, on bool) {
	if on {
		m[id] = true
	} else {
		delete(m, id)
	}
}

func (s *userState) setStar(id string, on bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	setIn(s.starred, id, on)
	s.saveLocked()
}

func (s *userState) setHidden(id string, on bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	setIn(s.hidden, id, on)
	s.saveLocked()
}

func (s *userState) addCooked(id string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.cooked[id]++
	s.saveLocked()
	return s.cooked[id]
}

func (s *userState) setCooked(id string, n int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.cooked[id] = n
	s.saveLocked()
}

// apply fills a recipe summary's per-person fields.
func (v stateView) apply(s *Summary) {
	s.Starred = v.starred[s.ID]
	s.Hidden = s.Hidden || v.hidden[s.ID]
	s.Cooked = v.cooked[s.ID]
}

func (v stateView) applyRecipe(r *Recipe) {
	r.Starred = v.starred[r.ID]
	r.Hidden = r.Hidden || v.hidden[r.ID]
	r.Cooked = v.cooked[r.ID]
}
