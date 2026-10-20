package main

// Login. Browsers get a long-lived signed cookie from a login page, so a phone
// signs in once instead of re-answering a basic-auth prompt every time the tab
// is evicted. Scripts (curl, backups, Claude) use basic auth with the same
// name and password. Accounts live in accounts.go; with none the site is open.

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"html/template"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const (
	sessionCookie = "teatime_session"
	sessionTTL    = 400 * 24 * time.Hour // browsers cap cookie lifetime at 400 days
	renewWithin   = 30 * 24 * time.Hour  // reissue when this close to expiry
)

// Principal is who a request acts as.
type Principal struct {
	Name  string
	Admin bool
}

type principalKey struct{}

func who(r *http.Request) *Principal {
	p, _ := r.Context().Value(principalKey{}).(*Principal)
	if p == nil {
		return &Principal{Name: localUser, Admin: true}
	}
	return p
}

func principalOf(u *User) *Principal { return &Principal{Name: u.Name, Admin: u.Role == roleAdmin} }

func (a *Accounts) sign(msg string) string {
	m := hmac.New(sha256.New, a.key)
	m.Write([]byte(msg))
	return base64.RawURLEncoding.EncodeToString(m.Sum(nil))
}

// cookie value: name.gen.expiry.signature
func (a *Accounts) cookieValue(u *User, exp int64) string {
	body := u.Name + "." + strconv.Itoa(u.Gen) + "." + strconv.FormatInt(exp, 10)
	return body + "." + a.sign(body)
}

// the signed-in user and the cookie's expiry, or nil
func (a *Accounts) session(r *http.Request) (*User, int64) {
	c, err := r.Cookie(sessionCookie)
	if err != nil {
		return nil, 0
	}
	parts := strings.Split(c.Value, ".")
	if len(parts) != 4 {
		return nil, 0
	}
	body := strings.Join(parts[:3], ".")
	if !hmac.Equal([]byte(parts[3]), []byte(a.sign(body))) {
		return nil, 0
	}
	gen, err1 := strconv.Atoi(parts[1])
	exp, err2 := strconv.ParseInt(parts[2], 10, 64)
	if err1 != nil || err2 != nil || time.Now().Unix() > exp {
		return nil, 0
	}
	u := a.get(parts[0])
	if u == nil || u.Gen != gen {
		return nil, 0
	}
	return u, exp
}

func (a *Accounts) setCookie(w http.ResponseWriter, r *http.Request, u *User) {
	exp := time.Now().Add(sessionTTL)
	http.SetCookie(w, &http.Cookie{
		Name: sessionCookie, Value: a.cookieValue(u, exp.Unix()), Path: "/",
		Expires: exp, MaxAge: int(sessionTTL.Seconds()),
		HttpOnly: true, SameSite: http.SameSiteLaxMode,
		Secure: r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https",
	})
}

// paths that must load without a session: the login page itself and the
// icons phones fetch on their own without credentials
func publicPath(p string) bool {
	switch p {
	case "/login", "/logout", "/style.css", "/favicon.ico":
		return true
	}
	return strings.HasPrefix(p, "/apple-touch-icon")
}

func (a *Accounts) wrap(next http.Handler) http.Handler {
	serve := func(w http.ResponseWriter, r *http.Request, p *Principal) {
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), principalKey{}, p)))
	}
	if a.open {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			serve(w, r, &Principal{Name: localUser, Admin: true})
		})
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/login":
			a.login(w, r)
			return
		case "/logout":
			http.SetCookie(w, &http.Cookie{Name: sessionCookie, Value: "", Path: "/", MaxAge: -1})
			http.Redirect(w, r, "/login", http.StatusSeeOther)
			return
		}
		if u, exp := a.session(r); u != nil {
			if time.Until(time.Unix(exp, 0)) < renewWithin {
				a.setCookie(w, r, u)
			}
			serve(w, r, principalOf(u))
			return
		}
		if name, pass, ok := r.BasicAuth(); ok {
			if u := a.authenticateBasic(name, pass); u != nil {
				serve(w, r, principalOf(u))
				return
			}
		}
		if publicPath(r.URL.Path) {
			next.ServeHTTP(w, r)
			return
		}
		// No WWW-Authenticate header: that is what makes browsers pop the
		// basic-auth dialog. Pages go to the login form; the API just says no.
		if strings.HasPrefix(r.URL.Path, "/api/") {
			http.Error(w, "login required", http.StatusUnauthorized)
			return
		}
		http.Redirect(w, r, "/login?next="+url.QueryEscape(r.URL.RequestURI()), http.StatusSeeOther)
	})
}

// only local paths, so the login form can't be used to bounce someone offsite
func safeNext(s string) string {
	if !strings.HasPrefix(s, "/") || strings.HasPrefix(s, "//") || strings.HasPrefix(s, "/\\") {
		return "/"
	}
	return s
}

func (a *Accounts) login(w http.ResponseWriter, r *http.Request) {
	next := safeNext(r.FormValue("next"))
	failed := false
	name := strings.TrimSpace(r.PostFormValue("username"))
	if r.Method == http.MethodPost {
		if u := a.authenticate(name, r.PostFormValue("password")); u != nil {
			a.setCookie(w, r, u)
			http.Redirect(w, r, next, http.StatusSeeOther)
			return
		}
		time.Sleep(700 * time.Millisecond) // blunt guessing
		failed = true
		w.WriteHeader(http.StatusUnauthorized)
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	loginPage.Execute(w, map[string]any{"Next": next, "Failed": failed, "User": name})
}

/* ---------- account API ---------- */

func readJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<16)
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		http.Error(w, "bad request body", http.StatusBadRequest)
		return false
	}
	return true
}

func methodNotAllowed(w http.ResponseWriter) {
	http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
}

// /api/me — who am I; /api/me/password — change my own password
func (a *Accounts) meHandler(w http.ResponseWriter, r *http.Request) {
	p := who(r)
	switch strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/me"), "/") {
	case "":
		if r.Method != http.MethodGet {
			methodNotAllowed(w)
			return
		}
		role := roleUser
		if p.Admin {
			role = roleAdmin
		}
		writeJSON(w, http.StatusOK, map[string]any{"name": p.Name, "role": role, "open": a.open})
	case "password":
		if r.Method != http.MethodPost {
			methodNotAllowed(w)
			return
		}
		if a.open {
			http.Error(w, "no accounts: set TEATIME_PASSWORD first", http.StatusBadRequest)
			return
		}
		var body struct{ Current, New string }
		if !readJSON(w, r, &body) {
			return
		}
		if a.authenticate(p.Name, body.Current) == nil {
			time.Sleep(700 * time.Millisecond)
			http.Error(w, "current password is wrong", http.StatusForbidden)
			return
		}
		if err := a.update(p.Name, body.New, ""); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if u := a.get(p.Name); u != nil {
			a.setCookie(w, r, u) // other devices are signed out; this one stays in
		}
		w.WriteHeader(http.StatusNoContent)
	default:
		http.NotFound(w, r)
	}
}

// /api/users — admin only
func (a *Accounts) usersHandler(ms *MealStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		p := who(r)
		if !p.Admin {
			http.Error(w, "admin only", http.StatusForbidden)
			return
		}
		if a.open {
			http.Error(w, "no accounts: set TEATIME_PASSWORD first", http.StatusBadRequest)
			return
		}
		name := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/users"), "/")
		fail := func(err error) {
			code := http.StatusBadRequest
			switch err {
			case errExists:
				code = http.StatusConflict
			case errNoUser:
				code = http.StatusNotFound
			}
			http.Error(w, err.Error(), code)
		}
		switch {
		case name == "" && r.Method == http.MethodGet:
			writeJSON(w, http.StatusOK, a.list())
		case name == "" && r.Method == http.MethodPost:
			var body struct{ Name, Password, Role string }
			if !readJSON(w, r, &body) {
				return
			}
			if err := a.add(body.Name, body.Password, body.Role); err != nil {
				fail(err)
				return
			}
			w.WriteHeader(http.StatusCreated)
		case name != "" && r.Method == http.MethodPut:
			var body struct{ Password, Role string }
			if !readJSON(w, r, &body) {
				return
			}
			if err := a.update(name, body.Password, body.Role); err != nil {
				fail(err)
				return
			}
			w.WriteHeader(http.StatusNoContent)
		case name != "" && r.Method == http.MethodDelete:
			if name == p.Name {
				http.Error(w, "you cannot remove yourself", http.StatusBadRequest)
				return
			}
			if err := a.remove(name); err != nil {
				fail(err)
				return
			}
			ms.dropOwner(name)
			w.WriteHeader(http.StatusNoContent)
		default:
			methodNotAllowed(w)
		}
	}
}

var loginPage = template.Must(template.New("login").Parse(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in — teatime</title>
<link rel="stylesheet" href="style.css">
</head>
<body>
<form class="login" method="post" action="/login">
  <h1>teatime</h1>
  <input type="hidden" name="next" value="{{.Next}}">
  <label for="un">Name</label>
  <input id="un" type="text" name="username" value="{{.User}}" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" {{if not .User}}autofocus{{end}} required>
  <label for="pw">Password</label>
  <input id="pw" type="password" name="password" autocomplete="current-password" {{if .User}}autofocus{{end}} required>
  {{if .Failed}}<p class="login-error">Wrong name or password.</p>{{end}}
  <button class="primary" type="submit">Sign in</button>
  <p class="login-note">You stay signed in on this device.</p>
</form>
</body>
</html>
`))
