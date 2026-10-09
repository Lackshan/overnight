// Package auth checks Supabase access tokens. The browser signs users in with
// supabase-js; the API only verifies the token it sends.
package auth

import (
	"context"
	"errors"
	"log"
	"net/http"
	"strings"

	"github.com/MicahParks/keyfunc/v3"
	"github.com/golang-jwt/jwt/v5"
)

type User struct {
	ID    string
	Email string
}

type ctxKey struct{}

// FromContext returns the signed-in user, or nil for anonymous requests.
func FromContext(ctx context.Context) *User {
	u, _ := ctx.Value(ctxKey{}).(*User)
	return u
}

type Verifier struct {
	issuer string
	jwks   keyfunc.Keyfunc // asymmetric keys (current Supabase projects)
	secret []byte          // legacy HS256 secret (older projects)
}

// NewVerifier uses the project's published JWKS, and the legacy JWT secret if
// one is given. Returns nil when Supabase isn't configured, which makes every
// request anonymous.
func NewVerifier(ctx context.Context, supabaseURL, legacySecret string) *Verifier {
	if supabaseURL == "" {
		return nil
	}
	base := strings.TrimRight(supabaseURL, "/")
	v := &Verifier{issuer: base + "/auth/v1", secret: []byte(legacySecret)}
	k, err := keyfunc.NewDefaultCtx(ctx, []string{v.issuer + "/.well-known/jwks.json"})
	if err != nil {
		log.Printf("auth: couldn't load Supabase JWKS: %v", err)
	} else {
		v.jwks = k
	}
	return v
}

func (v *Verifier) keyFor(t *jwt.Token) (any, error) {
	if t.Method.Alg() == jwt.SigningMethodHS256.Alg() {
		if len(v.secret) == 0 {
			return nil, errors.New("HS256 token but SUPABASE_JWT_SECRET isn't set")
		}
		return v.secret, nil
	}
	if v.jwks == nil {
		return nil, errors.New("no JWKS loaded")
	}
	return v.jwks.Keyfunc(t)
}

func (v *Verifier) Verify(raw string) (*User, error) {
	claims := jwt.MapClaims{}
	_, err := jwt.ParseWithClaims(raw, claims, v.keyFor,
		jwt.WithIssuer(v.issuer),
		jwt.WithAudience("authenticated"),
		jwt.WithValidMethods([]string{"ES256", "RS256", "HS256"}),
	)
	if err != nil {
		return nil, err
	}
	sub, _ := claims["sub"].(string)
	if sub == "" {
		return nil, errors.New("token has no subject")
	}
	email, _ := claims["email"].(string)
	return &User{ID: sub, Email: email}, nil
}

// Middleware attaches the user to the request context when a valid bearer
// token is present. No token means anonymous. A bad token gets a 401 so the
// browser knows to refresh its session.
func (v *Verifier) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if raw == "" || raw == r.Header.Get("Authorization") || v == nil {
			next.ServeHTTP(w, r)
			return
		}
		u, err := v.Verify(raw)
		if err != nil {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusUnauthorized)
			w.Write([]byte(`{"error":"session_expired"}`))
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), ctxKey{}, u)))
	})
}
