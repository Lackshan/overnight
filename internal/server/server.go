// Package server wires the HTTP API and serves the built frontend.
package server

import (
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"

	"overnight/internal/auth"
	"overnight/internal/billing"
	"overnight/internal/config"
	"overnight/internal/history"
	"overnight/internal/live"
	"overnight/internal/report"
	"overnight/internal/sources"
	"overnight/internal/store"
)

type Server struct {
	Features *config.Features
	Auth     *auth.Verifier
	Store    store.Store
	Billing  *billing.Billing
	Hub      *live.Hub
	Reports  *report.Builder
	Static   fs.FS // built frontend; nil in dev (Vite serves it)
	DevMode  bool  // allows the X-Dev-Plan header for testing tiers locally

	lookups lookupCounter

	pathsMu sync.Mutex
	paths   map[string]any
	pathsAt time.Time
}

func (s *Server) Routes() http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.RealIP, middleware.Recoverer, middleware.Compress(5))
	r.Get("/healthz", func(w http.ResponseWriter, _ *http.Request) { w.Write([]byte("ok")) })

	// The webhook must see the raw body and has no user token.
	r.Post("/api/stripe/webhook", s.webhook)

	r.Group(func(r chi.Router) {
		r.Use(s.Auth.Middleware)
		r.Get("/api/session", s.session)
		r.Get("/api/report/{postcode}", s.report)
		r.Get("/api/live", s.live)
		r.Get("/api/flightpaths", s.flightPaths)
		r.Post("/api/billing/checkout", s.requireUser(s.checkout))
		r.Post("/api/billing/confirm", s.requireUser(s.confirm))
		r.Post("/api/billing/portal", s.requireUser(s.portal))
	})

	if s.Static != nil {
		r.Handle("/*", spa(s.Static))
	}
	return r
}

// plan works out the caller's plan: anonymous, free, or whatever they've paid for.
func (s *Server) plan(r *http.Request) string {
	if s.DevMode {
		if p := r.Header.Get("X-Dev-Plan"); p != "" {
			if _, ok := s.Features.Plans[p]; ok {
				return p
			}
		}
	}
	u := auth.FromContext(r.Context())
	if u == nil {
		return config.PlanAnonymous
	}
	acct, err := s.Store.Get(r.Context(), u.ID)
	if err != nil {
		log.Printf("store: %v", err)
	}
	if acct == nil || acct.Plan == "" {
		return config.PlanFree
	}
	return acct.Plan
}

type planInfo struct {
	Name       string `json:"name"`
	PriceLabel string `json:"price_label,omitempty"`
}

func (s *Server) session(w http.ResponseWriter, r *http.Request) {
	plan := s.plan(r)
	features, limits := s.Features.StateFor(plan)
	plans := map[string]planInfo{}
	for id, p := range s.Features.Plans {
		plans[id] = planInfo{Name: p.Name, PriceLabel: p.PriceLabel}
	}
	out := map[string]any{
		"plan":     plan,
		"features": features,
		"limits":   limits,
		"plans":    plans,
		"dev_mode": s.DevMode,
	}
	if u := auth.FromContext(r.Context()); u != nil {
		out["email"] = u.Email
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) report(w http.ResponseWriter, r *http.Request) {
	plan := s.plan(r)
	pc := sources.NormalisePostcode(chi.URLParam(r, "postcode"))
	if limit := s.Features.Limit(plan, config.LimitLookupsPerDay); limit > 0 {
		if !s.lookups.allow(callerKey(r), pc, limit) {
			writeJSON(w, http.StatusTooManyRequests, map[string]any{
				"error":      "You've used today's free lookups.",
				"unlocks_on": s.Features.NextPlan(plan, config.ReportScore),
			})
			return
		}
	}
	full, err := s.Reports.Build(r.Context(), pc)
	if errors.Is(err, sources.ErrPostcodeNotFound) {
		writeError(w, http.StatusNotFound, "We couldn't find that postcode.")
		return
	}
	if err != nil {
		log.Printf("report %s: %v", pc, err)
		writeError(w, http.StatusBadGateway, "Couldn't reach the data sources. Try again in a moment.")
		return
	}
	// The response depends on the caller's plan, so the browser mustn't reuse
	// it after an upgrade. The frontend keeps its own per-plan cache.
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, report.Gate(full, plan, s.Features))
}

func (s *Server) live(w http.ResponseWriter, r *http.Request) {
	plan := s.plan(r)
	lat, err1 := strconv.ParseFloat(r.URL.Query().Get("lat"), 64)
	lon, err2 := strconv.ParseFloat(r.URL.Query().Get("lon"), 64)
	if err1 != nil || err2 != nil {
		writeError(w, http.StatusBadRequest, "lat and lon are required")
		return
	}
	var lines []string
	if l := r.URL.Query().Get("lines"); l != "" {
		lines = strings.Split(l, ",")
	}
	// bbox=west,south,east,north: the browser's visible map area.
	var box *live.Box
	if parts := strings.Split(r.URL.Query().Get("bbox"), ","); len(parts) == 4 {
		var v [4]float64
		ok := true
		for i, p := range parts {
			f, err := strconv.ParseFloat(p, 64)
			ok = ok && err == nil
			v[i] = f
		}
		if ok && v[0] < v[2] && v[1] < v[3] {
			box = &live.Box{West: v[0], South: v[1], East: v[2], North: v[3]}
		}
	}
	snap := s.Hub.Query(lat, lon, 25, box, 5, lines, s.Features.Limit(plan, config.LimitFeedItems))
	locked := []string{}
	if !s.Features.Can(plan, config.MapAircraft) {
		snap.Aircraft = nil
		locked = append(locked, config.MapAircraft)
	}
	if !s.Features.Can(plan, config.LiveFeed) {
		snap.Events = nil
		locked = append(locked, config.LiveFeed)
	}
	writeJSON(w, http.StatusOK, map[string]any{"snapshot": snap, "locked": locked})
}

// flightPaths serves the hourly flight-path grid for the map slider. It's the
// same for everyone, so it's rebuilt at most once a minute.
func (s *Server) flightPaths(w http.ResponseWriter, r *http.Request) {
	if !s.Features.Can(s.plan(r), config.MapOverflights) {
		writeJSON(w, http.StatusForbidden, map[string]any{
			"error":      "Sign up to see flight paths.",
			"unlocks_on": s.Features.NextPlan(s.plan(r), config.MapOverflights),
		})
		return
	}
	s.pathsMu.Lock()
	if s.paths == nil || time.Since(s.pathsAt) > time.Minute {
		s.paths = map[string]any{
			"hours": history.FlightPathHours,
			"days":  s.Hub.Grid.DaysObserved(),
			"cells": s.Hub.Grid.HeatCells(),
		}
		s.pathsAt = time.Now()
	}
	paths := s.paths
	s.pathsMu.Unlock()
	writeJSON(w, http.StatusOK, paths)
}

func (s *Server) requireUser(h func(http.ResponseWriter, *http.Request, *auth.User)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := auth.FromContext(r.Context())
		if u == nil {
			writeError(w, http.StatusUnauthorized, "Sign in first.")
			return
		}
		h(w, r, u)
	}
}

type billingReq struct {
	ReturnPath string `json:"return_path"`
	SessionID  string `json:"session_id"`
}

func readBillingReq(r *http.Request) billingReq {
	var req billingReq
	json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&req)
	return req
}

func (s *Server) checkout(w http.ResponseWriter, r *http.Request, u *auth.User) {
	url, err := s.Billing.Checkout(r.Context(), u, readBillingReq(r).ReturnPath)
	if err != nil {
		log.Printf("checkout: %v", err)
		writeError(w, http.StatusBadGateway, billingMessage(err))
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"url": url})
}

func (s *Server) confirm(w http.ResponseWriter, r *http.Request, u *auth.User) {
	if err := s.Billing.Confirm(r.Context(), u, readBillingReq(r).SessionID); err != nil {
		log.Printf("confirm: %v", err)
		writeError(w, http.StatusBadRequest, billingMessage(err))
		return
	}
	s.session(w, r)
}

func (s *Server) portal(w http.ResponseWriter, r *http.Request, u *auth.User) {
	url, err := s.Billing.Portal(r.Context(), u, readBillingReq(r).ReturnPath)
	if err != nil {
		log.Printf("portal: %v", err)
		writeError(w, http.StatusBadRequest, billingMessage(err))
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"url": url})
}

func billingMessage(err error) string {
	if errors.Is(err, billing.ErrNotConfigured) {
		return "Payments aren't set up on this server yet."
	}
	return "Couldn't reach the payment provider. Try again."
}

func (s *Server) webhook(w http.ResponseWriter, r *http.Request) {
	payload, err := io.ReadAll(io.LimitReader(r.Body, 1<<16))
	if err != nil {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	if err := s.Billing.HandleWebhook(r.Context(), payload, r.Header.Get("Stripe-Signature")); err != nil {
		log.Printf("webhook: %v", err)
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	w.WriteHeader(http.StatusOK)
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"error": msg})
}

func callerKey(r *http.Request) string {
	if u := auth.FromContext(r.Context()); u != nil {
		return "u:" + u.ID
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	return "ip:" + host
}

// lookupCounter counts distinct postcodes per caller per day, in memory.
// Re-opening a postcode you've already looked up today is free.
type lookupCounter struct {
	mu   sync.Mutex
	day  string
	seen map[string]map[string]bool
}

func (c *lookupCounter) allow(caller, postcode string, limit int) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	today := time.Now().Format(time.DateOnly)
	if c.day != today || c.seen == nil {
		c.day, c.seen = today, map[string]map[string]bool{}
	}
	got := c.seen[caller]
	if got == nil {
		got = map[string]bool{}
		c.seen[caller] = got
	}
	if got[postcode] {
		return true
	}
	if len(got) >= limit {
		return false
	}
	got[postcode] = true
	return true
}

// spa serves built files, falling back to index.html for client-side routes.
func spa(static fs.FS) http.Handler {
	files := http.FileServerFS(static)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := strings.TrimPrefix(r.URL.Path, "/")
		if p != "" {
			if _, err := fs.Stat(static, p); err == nil {
				if strings.HasPrefix(p, "assets/") {
					w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
				}
				files.ServeHTTP(w, r)
				return
			}
		}
		w.Header().Set("Cache-Control", "no-cache")
		http.ServeFileFS(w, r, static, "index.html")
	})
}
