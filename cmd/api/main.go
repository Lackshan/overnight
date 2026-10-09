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
	if url := os.Getenv("DATABASE_URL"); url != "" {
		pg, err := store.NewPostgres(ctx, url)
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
		strings.TrimRight(env("APP_URL", "http://localhost:5173"), "/"),
		pro, os.Getenv(pro.StripePriceEnv), st,
	)

	// Flight history: what we've recorded live, plus the bundled backfill.
	grid := history.NewGrid()
	if saved, err := st.GetBlob(ctx, historyKey); err != nil {
		log.Printf("history: %v", err)
	} else if err := grid.Merge(saved); err != nil {
		log.Printf("history: saved snapshot: %v", err)
	}
	if err := grid.Merge(history.Seed()); err != nil {
		log.Printf("history: seed: %v", err)
	}
	log.Printf("history: %d days of flight data", grid.DaysObserved())
	go saveHistory(ctx, st, grid)

	policeDelay, err := time.ParseDuration(env("POLICE_DELAY", "10m"))
	if err != nil {
		log.Fatalf("POLICE_DELAY: %v", err)
	}
	hub := live.NewHub(grid, policeDelay)
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
	if data, err := grid.Encode(); err == nil {
		st.PutBlob(shutdown, historyKey, data)
	}
}

const historyKey = "history.json.gz"

// saveHistory snapshots the recorded flight history every 10 minutes.
func saveHistory(ctx context.Context, st store.Store, grid *history.Grid) {
	t := time.NewTicker(10 * time.Minute)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			data, err := grid.Encode()
			if err == nil {
				err = st.PutBlob(ctx, historyKey, data)
			}
			if err != nil {
				log.Printf("history: save: %v", err)
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
