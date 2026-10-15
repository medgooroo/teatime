package main

// Login. Browsers get a long-lived signed cookie from a login page, so a phone
// signs in once instead of re-answering a basic-auth prompt every time the tab
// is evicted. Scripts (curl, backups, Claude) keep using basic auth with the
// same credentials. Both are off unless TEATIME_PASSWORD is set, so a local
// "go run ." stays open.

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"html/template"
	"log"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

const (
	sessionCookie = "teatime_session"
	sessionTTL    = 400 * 24 * time.Hour // browsers cap cookie lifetime at 400 days
	renewWithin   = 30 * 24 * time.Hour  // reissue when this close to expiry
)

type auth struct {
	user, pass string
	key        []byte // HMAC key; derived from the password, so changing it signs everyone out
}

func newAuth() *auth {
	pass := os.Getenv("TEATIME_PASSWORD")
	if pass == "" {
		log.Printf("TEATIME_PASSWORD not set: no login required")
		return nil
	}
	user := os.Getenv("TEATIME_USER")
	if user == "" {
		user = "admin"
	}
	k := sha256.Sum256([]byte("teatime-session\x00" + pass))
	return &auth{user: user, pass: pass, key: k[:]}
}

func (a *auth) sign(exp int64) string {
	m := hmac.New(sha256.New, a.key)
	m.Write([]byte(strconv.FormatInt(exp, 10)))
	return strconv.FormatInt(exp, 10) + "." + base64.RawURLEncoding.EncodeToString(m.Sum(nil))
}

// expiry of a valid session cookie, or 0
func (a *auth) session(r *http.Request) int64 {
	c, err := r.Cookie(sessionCookie)
	if err != nil {
		return 0
	}
	expStr, _, ok := strings.Cut(c.Value, ".")
	exp, err := strconv.ParseInt(expStr, 10, 64)
	if !ok || err != nil || time.Now().Unix() > exp {
		return 0
	}
	if !hmac.Equal([]byte(c.Value), []byte(a.sign(exp))) {
		return 0
	}
	return exp
}

func (a *auth) checkPass(user, pass string) bool {
	u := subtle.ConstantTimeCompare([]byte(user), []byte(a.user))
	p := subtle.ConstantTimeCompare([]byte(pass), []byte(a.pass))
	return u&p == 1
}

func (a *auth) setCookie(w http.ResponseWriter, r *http.Request) {
	exp := time.Now().Add(sessionTTL)
	http.SetCookie(w, &http.Cookie{
		Name: sessionCookie, Value: a.sign(exp.Unix()), Path: "/",
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

func (a *auth) wrap(next http.Handler) http.Handler {
	if a == nil {
		return next
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
		if exp := a.session(r); exp != 0 {
			if time.Until(time.Unix(exp, 0)) < renewWithin {
				a.setCookie(w, r)
			}
			next.ServeHTTP(w, r)
			return
		}
		if u, p, ok := r.BasicAuth(); ok && a.checkPass(u, p) {
			next.ServeHTTP(w, r)
			return
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

func (a *auth) login(w http.ResponseWriter, r *http.Request) {
	next := safeNext(r.FormValue("next"))
	failed := false
	if r.Method == http.MethodPost {
		if a.checkPass(a.user, r.PostFormValue("password")) {
			a.setCookie(w, r)
			http.Redirect(w, r, next, http.StatusSeeOther)
			return
		}
		time.Sleep(700 * time.Millisecond) // blunt guessing
		failed = true
		w.WriteHeader(http.StatusUnauthorized)
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	loginPage.Execute(w, map[string]any{"Next": next, "Failed": failed, "User": a.user})
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
  <input type="hidden" name="username" value="{{.User}}" autocomplete="username">
  <label for="pw">Password</label>
  <input id="pw" type="password" name="password" autocomplete="current-password" autofocus required>
  {{if .Failed}}<p class="login-error">Wrong password.</p>{{end}}
  <button class="primary" type="submit">Sign in</button>
  <p class="login-note">You stay signed in on this device.</p>
</form>
</body>
</html>
`))
