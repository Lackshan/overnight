// Command backfill streams adsb.lol's daily archives (about 4 GB per day),
// keeps only aircraft below 10,000 ft over London, and adds them to the
// flight history. Nothing large is saved to disk.
//
// With DATABASE_URL set it writes to Supabase. Each day is imported at most
// once, and hours a live server already recorded are skipped:
//
//	go run ./cmd/backfill -days 2026-10-06,2026-10-07
//
// Once, to move history saved by older versions (a single stored file) into
// the tables:
//
//	go run ./cmd/backfill -import-legacy
//
// Without a database, or with -file, it writes internal/history/seed.json.gz,
// which is bundled into the binary for running without a database.
package main

import (
	"archive/tar"
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"overnight/internal/history"
	"overnight/internal/sources"
	"overnight/internal/store"
)

func main() {
	days := flag.String("days", "", "comma-separated UTC dates, e.g. 2026-10-07,2026-10-08")
	importLegacy := flag.Bool("import-legacy", false, "move history saved by older versions into the database tables")
	toFile := flag.Bool("file", false, "write the seed file even if DATABASE_URL is set")
	out := flag.String("out", "internal/history/seed.json.gz", "seed file (file mode)")
	flag.Parse()
	if *days == "" && !*importLegacy {
		log.Fatal("pass -days or -import-legacy")
	}
	ctx := context.Background()
	if url := os.Getenv("DATABASE_URL"); url != "" && !*toFile {
		pg, err := store.NewPostgres(ctx, url)
		if err != nil {
			log.Fatalf("database: %v", err)
		}
		if *importLegacy {
			if err := importLegacyHistory(ctx, pg); err != nil {
				log.Fatal(err)
			}
		}
		if *days != "" {
			done, err := pg.BackfilledDays(ctx)
			if err != nil {
				log.Fatal(err)
			}
			for _, day := range strings.Split(*days, ",") {
				day = strings.TrimSpace(day)
				if done[day] {
					log.Printf("%s: already imported, skipping", day)
					continue
				}
				if err := backfillToDB(ctx, pg, day); err != nil {
					log.Fatalf("%s: %v", day, err)
				}
			}
		}
		return
	}

	g := history.NewGrid()
	if old, err := os.ReadFile(*out); err == nil {
		if err := g.Merge(old); err != nil {
			log.Fatalf("existing %s: %v", *out, err)
		}
	}
	for _, day := range strings.Split(*days, ",") {
		if err := backfillDay(g, strings.TrimSpace(day)); err != nil {
			log.Fatalf("%s: %v", day, err)
		}
	}
	data, err := g.Encode()
	if err != nil {
		log.Fatal(err)
	}
	if err := os.WriteFile(*out, data, 0o644); err != nil {
		log.Fatal(err)
	}
	log.Printf("wrote %s (%d KB, %d days)", *out, len(data)/1024, g.DaysObserved())
}

// backfillToDB imports one day, skipping hours a live server already recorded.
func backfillToDB(ctx context.Context, pg *store.Postgres, day string) error {
	start, err := time.Parse(time.DateOnly, day)
	if err != nil {
		return err
	}
	existing, err := pg.FlightHours(ctx)
	if err != nil {
		return err
	}
	g := history.NewGrid()
	g.Skip(existing)
	if err := backfillDay(g, day); err != nil {
		return err
	}
	rows, seen := g.Rows()
	if err := pg.AddFlights(ctx, rows, seen, &start); err != nil {
		return err
	}
	log.Printf("%s: added %d totals and %d hours to the database", day, len(rows), len(seen))
	return nil
}

const legacyKey = "history.json.gz"

// legacySeedDay is the archive day the bundled seed was built from.
const legacySeedDay = "2026-10-08"

// importLegacyHistory moves the single stored history file used by older
// versions (which already includes the bundled seed) into the tables, then
// deletes it. Falls back to the bundled seed if there's no stored file.
func importLegacyHistory(ctx context.Context, pg *store.Postgres) error {
	existing, err := pg.FlightHours(ctx)
	if err != nil {
		return err
	}
	if len(existing) > 0 {
		return fmt.Errorf("the flight tables already have %d hours of data; refusing to import over them", len(existing))
	}
	data, err := pg.GetBlob(ctx, legacyKey)
	if err != nil {
		return err
	}
	source := "stored history file"
	if data == nil {
		data, source = history.Seed(), "bundled seed"
	}
	rows, seen, err := history.Decode(data)
	if err != nil {
		return fmt.Errorf("%s: %w", source, err)
	}
	day, _ := time.Parse(time.DateOnly, legacySeedDay)
	if err := pg.AddFlights(ctx, rows, seen, &day); err != nil {
		return err
	}
	log.Printf("imported the %s: %d totals, %d hours", source, len(rows), len(seen))
	if source == "stored history file" {
		if err := pg.DeleteBlob(ctx, legacyKey); err != nil {
			return fmt.Errorf("imported, but couldn't delete the old file: %w", err)
		}
		log.Print("deleted the old stored history file")
	}
	return nil
}

func backfillDay(g *history.Grid, day string) error {
	start, err := time.Parse(time.DateOnly, day)
	if err != nil {
		return err
	}
	// Mark every hour of the day as observed so quiet hours count as zero.
	for t := start; t.Before(start.Add(24 * time.Hour)); t = t.Add(time.Hour) {
		g.MarkObserved(t)
	}

	tag := "v" + strings.ReplaceAll(day, "-", ".") + "-planes-readsb-prod-0"
	parts, err := releaseParts(tag)
	if err != nil {
		return err
	}
	log.Printf("%s: streaming %d parts", day, len(parts))
	body := &multiHTTP{urls: parts}
	defer body.Close()
	counter := &countingReader{r: bufio.NewReaderSize(body, 1<<20)}
	tr := tar.NewReader(counter)

	// Parse traces in parallel; the tar has to be read in order.
	jobs := make(chan []byte, 256)
	var wg sync.WaitGroup
	var mu sync.Mutex
	rec := g.NewRecorder()
	var kept, total atomic.Int64
	for i := 0; i < runtime.NumCPU(); i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for raw := range jobs {
				obs := parseTrace(raw)
				total.Add(1)
				if len(obs) == 0 {
					continue
				}
				kept.Add(1)
				mu.Lock()
				for _, o := range obs {
					rec.Add(o)
				}
				mu.Unlock()
			}
		}()
	}

	last := time.Now()
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			close(jobs)
			wg.Wait()
			return fmt.Errorf("tar: %w", err)
		}
		if !strings.Contains(hdr.Name, "traces/") || !strings.Contains(hdr.Name, "trace_full_") {
			continue
		}
		raw, err := io.ReadAll(tr)
		if err != nil {
			return err
		}
		jobs <- raw
		if time.Since(last) > 10*time.Second {
			last = time.Now()
			log.Printf("%s: %.1f GB read, %d aircraft, %d over London", day, float64(counter.n.Load())/1e9, total.Load(), kept.Load())
		}
	}
	close(jobs)
	wg.Wait()
	log.Printf("%s: done, %d aircraft, %d over London below %d ft", day, total.Load(), kept.Load(), history.MaxAltFt)
	return nil
}

// trace_full JSON from readsb. Each point is
// [secondsAfterTimestamp, lat, lon, altitude ("ground" or ft), groundSpeed, track, flags, vertRate, details|null, ...].
type traceFile struct {
	Hex       string              `json:"icao"`
	Reg       string              `json:"r"`
	Type      string              `json:"t"`
	Timestamp float64             `json:"timestamp"`
	Trace     [][]json.RawMessage `json:"trace"`
}

func parseTrace(raw []byte) []history.Observation {
	if len(raw) > 2 && raw[0] == 0x1f && raw[1] == 0x8b {
		zr, err := gzip.NewReader(bytes.NewReader(raw))
		if err != nil {
			return nil
		}
		if raw, err = io.ReadAll(zr); err != nil {
			return nil
		}
	}
	var tf traceFile
	if json.Unmarshal(raw, &tf) != nil {
		return nil
	}
	var out []history.Observation
	var callsign, category string
	var prevT float64
	for _, p := range tf.Trace {
		if len(p) < 4 {
			continue
		}
		var dt, lat, lon float64
		if json.Unmarshal(p[0], &dt) != nil || json.Unmarshal(p[1], &lat) != nil || json.Unmarshal(p[2], &lon) != nil {
			continue
		}
		// Details (callsign, category) appear on some points only; carry them forward.
		if len(p) > 8 && len(p[8]) > 2 && p[8][0] == '{' {
			var d struct {
				Flight   string `json:"flight"`
				Category string `json:"category"`
			}
			if json.Unmarshal(p[8], &d) == nil {
				if f := strings.TrimSpace(d.Flight); f != "" {
					callsign = f
				}
				if d.Category != "" {
					category = d.Category
				}
			}
		}
		if lat < history.MinLat || lat >= history.MaxLat || lon < history.MinLon || lon >= history.MaxLon {
			prevT = dt
			continue
		}
		var alt int
		json.Unmarshal(p[3], &alt) // "ground" and null leave 0
		a := sources.Aircraft{Callsign: callsign, Reg: tf.Reg, Type: tf.Type}
		o := history.Observation{
			Hex:   tf.Hex,
			At:    time.Unix(0, int64((tf.Timestamp+dt)*1e9)),
			Lat:   lat,
			Lon:   lon,
			AltFt: alt,
			Kind:  sources.Classify(a, category),
			DtSec: dt - prevT,
		}
		prevT = dt
		out = append(out, o)
	}
	return out
}

func releaseParts(tag string) ([]string, error) {
	url := "https://api.github.com/repos/adsblol/globe_history_" + tag[1:5] + "/releases/tags/" + tag
	res, err := http.Get(url)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return nil, fmt.Errorf("%s: %s", url, res.Status)
	}
	var rel struct {
		Assets []struct {
			Name string `json:"name"`
			URL  string `json:"browser_download_url"`
		} `json:"assets"`
	}
	if err := json.NewDecoder(res.Body).Decode(&rel); err != nil {
		return nil, err
	}
	var urls []string
	for _, a := range rel.Assets {
		if strings.Contains(a.Name, ".tar") {
			urls = append(urls, a.URL) // already in .aa, .ab, ... order
		}
	}
	if len(urls) == 0 {
		return nil, fmt.Errorf("%s has no tar parts", tag)
	}
	return urls, nil
}

// multiHTTP reads several URLs back to back, as split tar parts need.
type multiHTTP struct {
	urls []string
	cur  io.ReadCloser
}

func (m *multiHTTP) Read(p []byte) (int, error) {
	for {
		if m.cur == nil {
			if len(m.urls) == 0 {
				return 0, io.EOF
			}
			res, err := http.Get(m.urls[0])
			if err != nil {
				return 0, err
			}
			if res.StatusCode != 200 {
				res.Body.Close()
				return 0, fmt.Errorf("%s: %s", m.urls[0], res.Status)
			}
			m.urls, m.cur = m.urls[1:], res.Body
		}
		n, err := m.cur.Read(p)
		if err == io.EOF {
			m.cur.Close()
			m.cur = nil
			if n > 0 {
				return n, nil
			}
			continue
		}
		return n, err
	}
}

func (m *multiHTTP) Close() error {
	if m.cur != nil {
		return m.cur.Close()
	}
	return nil
}

type countingReader struct {
	r io.Reader
	n atomic.Int64
}

func (c *countingReader) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	c.n.Add(int64(n))
	return n, err
}
