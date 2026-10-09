package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"slices"
	"sync"
	"time"

	"overnight/internal/ask"
	"overnight/internal/config"
	"overnight/internal/report"
	"overnight/internal/sources"
)

// ask answers questions about one postcode, or the postcodes being compared,
// with Claude. Claude sees only what the caller's plan can see. The answer
// streams back as lines of JSON: {"left":n}, then {"text":"..."} pieces,
// then {"done":true} or {"error":"..."}.
//
//	POST /api/ask {"postcodes":["SW111AA"],"messages":[{"role":"user","text":"..."}]}
func (s *Server) ask(w http.ResponseWriter, r *http.Request) {
	plan := s.plan(r)
	if s.Asker == nil {
		writeError(w, http.StatusServiceUnavailable, "Questions aren't set up on this server.")
		return
	}
	if !s.Features.Can(plan, config.Ask) {
		writeJSON(w, http.StatusForbidden, map[string]any{
			"error":      "Sign up free to ask questions about the data.",
			"unlocks_on": s.Features.NextPlan(plan, config.Ask),
		})
		return
	}
	var body struct {
		Postcodes []string   `json:"postcodes"`
		Messages  []ask.Turn `json:"messages"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "Couldn't read the question.")
		return
	}
	var pcs []string
	for _, pc := range body.Postcodes {
		if pc = sources.NormalisePostcode(pc); pc != "" && !slices.Contains(pcs, pc) {
			pcs = append(pcs, pc)
		}
	}
	max := 1
	if len(pcs) > 1 {
		if !s.Features.Can(plan, config.Compare) {
			writeJSON(w, http.StatusForbidden, map[string]any{
				"error":      "Asking about several postcodes at once is for supporters.",
				"unlocks_on": s.Features.NextPlan(plan, config.Compare),
			})
			return
		}
		max = s.Features.Limit(plan, config.LimitCompare)
	}
	if len(pcs) == 0 || (max > 0 && len(pcs) > max) {
		writeError(w, http.StatusBadRequest, fmt.Sprintf("Ask about 1 to %d postcodes.", max))
		return
	}
	turns := ask.Clean(body.Messages)
	if len(turns) == 0 || turns[len(turns)-1].Role != "user" {
		writeError(w, http.StatusBadRequest, "Ask a question.")
		return
	}

	places := make([]ask.Place, len(pcs))
	errs := make([]error, len(pcs))
	var wg sync.WaitGroup
	for i, pc := range pcs {
		wg.Add(1)
		go func() {
			defer wg.Done()
			full, err := s.Reports.Build(r.Context(), pc)
			if err != nil {
				errs[i] = err
				return
			}
			g := report.Gate(full, plan, s.Features)
			p := ask.Place{Report: g}
			if s.Features.Can(plan, config.ReportDetails) {
				p.Facts = full.Facts
			}
			snap := s.Hub.Query(full.Place.Lat, full.Place.Lon, 5, nil, 2, full.Lines, s.Features.Limit(plan, config.LimitFeedItems))
			if !s.Features.Can(plan, config.LiveFeed) {
				snap.Events = nil
			}
			p.Live = &snap
			places[i] = p
		}()
	}
	wg.Wait()
	for i, err := range errs {
		if errors.Is(err, sources.ErrPostcodeNotFound) {
			writeError(w, http.StatusNotFound, fmt.Sprintf("We couldn't find %s.", pcs[i]))
			return
		}
		if err != nil {
			log.Printf("ask: report %s: %v", pcs[i], err)
			writeError(w, http.StatusBadGateway, "Couldn't reach the data sources. Try again in a moment.")
			return
		}
	}

	caller := callerKey(r)
	limit := s.Features.Limit(plan, config.LimitAsk)
	left, ok := s.questions.take(caller, limit)
	if !ok {
		writeJSON(w, http.StatusTooManyRequests, map[string]any{
			"error":      fmt.Sprintf("You've asked today's %d questions. More tomorrow.", limit),
			"unlocks_on": s.morePlan(plan, config.LimitAsk),
		})
		return
	}

	w.Header().Set("Content-Type", "application/x-ndjson")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Accel-Buffering", "no") // proxies: don't hold the stream back
	flusher, _ := w.(http.Flusher)
	enc := json.NewEncoder(w)
	send := func(v any) error {
		if err := enc.Encode(v); err != nil {
			return err
		}
		if flusher != nil {
			flusher.Flush()
		}
		return nil
	}
	started := false
	err := s.Asker.Stream(r.Context(), places, turns, time.Now(), func(t string) error {
		if !started && limit > 0 { // only once the answer is really coming
			send(map[string]int{"left": left})
		}
		started = true
		return send(map[string]string{"text": t})
	})
	if err != nil {
		if r.Context().Err() == nil {
			log.Printf("ask: %v", err)
			send(map[string]string{"error": "Claude couldn't answer just now. Try again in a moment."})
		}
		s.questions.giveBack(caller) // a failed answer doesn't use up a question
		return
	}
	send(map[string]bool{"done": true})
}

// morePlan is the next plan up with a higher cap on limit, if any.
func (s *Server) morePlan(plan, limit string) string {
	cur := s.Features.Limit(plan, limit)
	i := slices.Index(s.Features.UpgradeOrder, plan)
	for _, p := range s.Features.UpgradeOrder[i+1:] {
		if l := s.Features.Limit(p, limit); l == 0 || l > cur {
			return p
		}
	}
	return ""
}

// dailyCounter counts things per caller per day, in memory.
type dailyCounter struct {
	mu    sync.Mutex
	day   string
	count map[string]int
}

// take uses one of the caller's limit for today and says how many are left.
// A limit of 0 means unlimited.
func (c *dailyCounter) take(caller string, limit int) (left int, ok bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if today := time.Now().Format(time.DateOnly); c.day != today || c.count == nil {
		c.day, c.count = today, map[string]int{}
	}
	if limit > 0 && c.count[caller] >= limit {
		return 0, false
	}
	c.count[caller]++
	return limit - c.count[caller], true
}

func (c *dailyCounter) giveBack(caller string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.count[caller] > 0 {
		c.count[caller]--
	}
}
