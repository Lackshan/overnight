package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"overnight/internal/ask"
	"overnight/internal/auth"
	"overnight/internal/billing"
	"overnight/internal/config"
	"overnight/internal/history"
	"overnight/internal/live"
	"overnight/internal/report"
	"overnight/internal/server"
	"overnight/internal/store"
	"overnight/web"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	features, err := config.Load(env("FEATURES_FILE", "features.yaml"))
	if err != nil {
		log.Fatalf("features: %v", err)
	}

	var st store.Store
	var pg *store.Postgres
	if url := os.Getenv("DATABASE_URL"); url != "" {
		var err error
		pg, err = store.NewPostgres(ctx, url)
		if err != nil {
			log.Fatalf("database: %v", err)
		}
		st = pg
		log.Print("plans: Supabase Postgres")
	} else {
		st = store.NewMemory(env("DATA_DIR", "data"))
		log.Print("plans: in memory, history in ./data (set DATABASE_URL to persist)")
	}

	verifier := auth.NewVerifier(ctx, os.Getenv("SUPABASE_URL"), os.Getenv("SUPABASE_JWT_SECRET"))
	if verifier == nil {
		log.Print("auth: SUPABASE_URL not set, everyone is anonymous")
	}

	pro := features.Plans[config.PlanPro]
	bill := billing.New(
		os.Getenv("STRIPE_SECRET_KEY"), os.Getenv("STRIPE_WEBHOOK_SECRET"),
		strings.TrimRight(env("APP_URL", "http://localhost:8080"), "/"),
		pro, os.Getenv(pro.StripePriceEnv), st,
	)

	// Flight history. Only one server should record (RECORD_HISTORY), or the
	// same aircraft get counted twice; every server reads the shared totals.
	record := env("RECORD_HISTORY", "true") != "false"
	grid := history.NewGrid()
	if record {
		grid.Track()
	}
	var hist historyStore
	if pg != nil {
		hist = dbHistory{pg}
	} else {
		hist = fileHistory{st}
	}
	if err := hist.load(ctx, grid); err != nil {
		log.Printf("history: load: %v", err)
	}
	log.Printf("history: %d days of flight data, recording %v", grid.DaysObserved(), map[bool]string{true: "on", false: "off (RECORD_HISTORY=false)"}[record])
	if grid.DaysObserved() == 0 && pg != nil {
		log.Print("history: no flight history in the database yet; run go run ./cmd/backfill -import-legacy (once) or -days ...")
	}
	go syncHistory(ctx, hist, grid, record)

	policeDelay, err := time.ParseDuration(env("POLICE_DELAY", "0"))
	if err != nil {
		log.Fatalf("POLICE_DELAY: %v", err)
	}
	hub := live.NewHub(grid, policeDelay, record)
	go hub.Run(ctx)

	srv := &server.Server{
		Features: features,
		Auth:     verifier,
		Store:    st,
		Billing:  bill,
		Hub:      hub,
		Reports:  report.NewBuilder(hub),
		Static:   web.Dist(),
		DevMode:  os.Getenv("DEV_MODE") == "true",
	}
	if key := os.Getenv("ANTHROPIC_API_KEY"); key != "" {
		srv.Asker = ask.New(key, os.Getenv("ANTHROPIC_MODEL"))
		log.Printf("ask: on (%s)", env("ANTHROPIC_MODEL", ask.DefaultModel))
	} else {
		log.Printf("ask: off (set ANTHROPIC_API_KEY to turn it on)")
	}
	// Build reports for demo postcodes up front so the first click is instant.
	// Wait for the first live poll so noise and transport have data.
	go func() {
		time.Sleep(15 * time.Second)
		for _, pc := range strings.Split(env("WARM_POSTCODES", "E16AN,SW111AA,TW33AD,SE154QL,E162PX"), ",") {
			if _, err := srv.Reports.Build(ctx, pc); err != nil {
				log.Printf("warm %s: %v", pc, err)
			}
		}
		log.Print("warmed demo postcodes")
	}()

	if srv.Static == nil {
		log.Print("frontend: not built, serving API only (run the Vite dev server)")
	}

	addr := ":" + env("PORT", "8080")
	httpSrv := &http.Server{Addr: addr, Handler: srv.Routes(), ReadHeaderTimeout: 10 * time.Second}
	go func() {
		log.Printf("listening on %s", addr)
		if err := httpSrv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatal(err)
		}
	}()
	<-ctx.Done()
	shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	httpSrv.Shutdown(shutdown)
	if record {
		if err := hist.save(shutdown, grid); err != nil {
			log.Printf("history: save on shutdown: %v", err)
		}
	}
}

// historyStore is where flight history lives: Supabase tables, or a local
// file when there's no database.
type historyStore interface {
	load(ctx context.Context, g *history.Grid) error
	save(ctx context.Context, g *history.Grid) error // adds new counts
}

type dbHistory struct{ pg *store.Postgres }

func (d dbHistory) load(ctx context.Context, g *history.Grid) error {
	rows, seen, err := d.pg.LoadFlights(ctx)
	if err == nil {
		g.Replace(rows, seen)
	}
	return err
}

func (d dbHistory) save(ctx context.Context, g *history.Grid) error {
	rows, seen := g.TakePending()
	if len(rows) == 0 && len(seen) == 0 {
		return nil
	}
	if err := d.pg.AddFlights(ctx, rows, seen, nil); err != nil {
		g.RestorePending(rows, seen)
		return err
	}
	return nil
}

const historyFile = "history.json.gz"

type fileHistory struct{ st store.Store }

// The saved file already includes the seed, so the seed is only for a first run.
func (f fileHistory) load(ctx context.Context, g *history.Grid) error {
	data, err := f.st.GetBlob(ctx, historyFile)
	if err != nil {
		return err
	}
	if data == nil {
		data = history.Seed()
	}
	err = g.Merge(data)
	g.TakePending() // already saved
	return err
}

func (f fileHistory) save(ctx context.Context, g *history.Grid) error {
	g.TakePending()
	data, err := g.Encode()
	if err != nil {
		return err
	}
	return f.st.PutBlob(ctx, historyFile, data)
}

// syncHistory saves new counts every 5 minutes (when recording) and reloads
// the shared totals, so servers that don't record still see new data.
func syncHistory(ctx context.Context, h historyStore, g *history.Grid, record bool) {
	t := time.NewTicker(5 * time.Minute)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if record {
				if err := h.save(ctx, g); err != nil {
					log.Printf("history: save: %v", err)
					continue
				}
			}
			if _, ok := h.(dbHistory); ok {
				if err := h.load(ctx, g); err != nil {
					log.Printf("history: reload: %v", err)
				}
			}
		}
	}
}

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
