// Package history keeps measured aircraft activity over London by day of the
// week and hour, on a ~1 km grid. It's filled from adsb.lol's daily archives
// (cmd/backfill) and topped up continuously by the live poller.
//
// With a database, counts live in Supabase (store/flights.go): the server
// loads them into memory and adds its new counts every few minutes, so any
// number of servers can share one database. Without one, the grid is seeded
// from the snapshot bundled into the binary.
package history

import (
	"bytes"
	"compress/gzip"
	_ "embed"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"sync"
	"time"
	_ "time/tzdata" // the runtime image has no zoneinfo
)

// The grid covers Greater London plus approach paths.
const (
	MinLat, MaxLat = 51.25, 51.75
	MinLon, MaxLon = -0.65, 0.40
	cellLat        = 0.01  // ~1.1 km
	cellLon        = 0.016 // ~1.1 km at London's latitude
	cols           = 66    // ceil((MaxLon - MinLon) / cellLon)

	MaxAltFt = 10000 // ignore aircraft above this: inaudible on the ground
	LowAltFt = 4000
)

var London, _ = time.LoadLocation("Europe/London")

type Cell int32

func CellOf(lat, lon float64) (Cell, bool) {
	if lat < MinLat || lat >= MaxLat || lon < MinLon || lon >= MaxLon {
		return 0, false
	}
	r := int((lat - MinLat) / cellLat)
	c := int((lon - MinLon) / cellLon)
	return Cell(r*cols + c), true
}

// Key is one cell at one local hour on one day of the week (Monday = 0).
type Key struct {
	Cell Cell
	Dow  int8
	Hour int8
}

// Vals are the totals for a Key.
type Vals struct {
	Passes    float64 // distinct aircraft through the cell
	Low       float64 // ...of which below LowAltFt
	Helis     float64 // distinct helicopters (any operator)
	PoliceSec float64 // seconds a police helicopter was in the cell
	AmbSec    float64 // seconds an air ambulance was in the cell
}

func (v *Vals) add(o *Vals) {
	v.Passes += o.Passes
	v.Low += o.Low
	v.Helis += o.Helis
	v.PoliceSec += o.PoliceSec
	v.AmbSec += o.AmbSec
}

// Row is a Key with its Vals, as stored in the database.
type Row struct {
	Key
	Vals
}

func dowOf(t time.Time) int8 { return int8((int(t.Weekday()) + 6) % 7) }

// Grid is safe for concurrent use.
type Grid struct {
	mu       sync.RWMutex
	vals     map[Key]*Vals
	observed map[string]bool // "2026-10-08T03": local date-hours we have data for

	// Counts recorded since the last save, when tracking is on.
	track       bool
	pending     map[Key]*Vals
	pendingSeen map[string]bool

	// Date-hours to ignore (already recorded elsewhere), for backfills.
	skip map[string]bool
}

func NewGrid() *Grid {
	return &Grid{vals: map[Key]*Vals{}, observed: map[string]bool{}, pending: map[Key]*Vals{}, pendingSeen: map[string]bool{}}
}

// Track makes the grid remember new counts until TakePending collects them.
func (g *Grid) Track() { g.track = true }

// Skip makes the grid ignore observations in these date-hours.
func (g *Grid) Skip(dateHours []string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.skip == nil {
		g.skip = map[string]bool{}
	}
	for _, dh := range dateHours {
		g.skip[dh] = true
	}
}

func (g *Grid) addLocked(k Key, v *Vals) {
	if x := g.vals[k]; x != nil {
		x.add(v)
	} else {
		c := *v
		g.vals[k] = &c
	}
	if g.track {
		if x := g.pending[k]; x != nil {
			x.add(v)
		} else {
			c := *v
			g.pending[k] = &c
		}
	}
}

func (g *Grid) observeLocked(dh string) {
	if !g.observed[dh] {
		g.observed[dh] = true
		if g.track {
			g.pendingSeen[dh] = true
		}
	}
}

// Observation is one aircraft position.
type Observation struct {
	Hex   string
	At    time.Time
	Lat   float64
	Lon   float64
	AltFt int     // 0 on the ground
	Kind  string  // police, air_ambulance, helicopter, plane
	DtSec float64 // time since this aircraft's previous observation, for dwell time
}

// Recorder turns a stream of positions into Grid counts, counting each
// aircraft at most once per cell per hour.
type Recorder struct {
	g    *Grid
	seen map[string]bool
	hour string
}

func (g *Grid) NewRecorder() *Recorder { return &Recorder{g: g, seen: map[string]bool{}} }

func (r *Recorder) Add(o Observation) {
	if o.AltFt <= 0 || o.AltFt > MaxAltFt {
		return
	}
	cell, ok := CellOf(o.Lat, o.Lon)
	if !ok {
		return
	}
	local := o.At.In(London)
	dh := local.Format("2006-01-02T15")
	if dh != r.hour {
		if len(r.seen) > 200000 {
			r.seen = map[string]bool{}
		}
		r.hour = dh
	}
	key := o.Hex + "|" + dh + "|" + fmt.Sprint(cell)

	r.g.mu.Lock()
	defer r.g.mu.Unlock()
	if r.g.skip[dh] {
		return
	}
	r.g.observeLocked(dh)
	var v Vals
	if !r.seen[key] {
		r.seen[key] = true
		v.Passes = 1
		if o.AltFt < LowAltFt {
			v.Low = 1
		}
		if o.Kind != "plane" {
			v.Helis = 1
		}
	}
	dt := math.Min(o.DtSec, 60)
	switch o.Kind {
	case "police":
		v.PoliceSec = dt
	case "air_ambulance":
		v.AmbSec = dt
	}
	if v != (Vals{}) {
		r.g.addLocked(Key{Cell: cell, Dow: dowOf(local), Hour: int8(local.Hour())}, &v)
	}
}

// MarkObserved records that we had coverage for a date-hour even if nothing
// flew through the grid (so quiet hours count as zero, not missing).
func (g *Grid) MarkObserved(t time.Time) {
	dh := t.In(London).Format("2006-01-02T15")
	g.mu.Lock()
	defer g.mu.Unlock()
	if !g.skip[dh] {
		g.observeLocked(dh)
	}
}

// TakePending returns everything recorded since the last call and clears it.
// If saving fails, hand it back with RestorePending.
func (g *Grid) TakePending() ([]Row, []string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	rows := make([]Row, 0, len(g.pending))
	for k, v := range g.pending {
		rows = append(rows, Row{k, *v})
	}
	seen := make([]string, 0, len(g.pendingSeen))
	for dh := range g.pendingSeen {
		seen = append(seen, dh)
	}
	g.pending, g.pendingSeen = map[Key]*Vals{}, map[string]bool{}
	return rows, seen
}

func (g *Grid) RestorePending(rows []Row, seen []string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	for _, r := range rows {
		v := r.Vals
		if x := g.pending[r.Key]; x != nil {
			x.add(&v)
		} else {
			g.pending[r.Key] = &v
		}
	}
	for _, dh := range seen {
		g.pendingSeen[dh] = true
	}
}

// Replace swaps in fresh totals from the database, keeping anything recorded
// here that hasn't been saved yet.
func (g *Grid) Replace(rows []Row, observed []string) {
	vals := make(map[Key]*Vals, len(rows))
	for _, r := range rows {
		v := r.Vals
		vals[r.Key] = &v
	}
	obs := make(map[string]bool, len(observed))
	for _, dh := range observed {
		obs[dh] = true
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	for k, v := range g.pending {
		if x := vals[k]; x != nil {
			x.add(v)
		} else {
			c := *v
			vals[k] = &c
		}
	}
	for dh := range g.pendingSeen {
		obs[dh] = true
	}
	g.vals, g.observed = vals, obs
}

// Rows returns every total in the grid, and the observed date-hours.
func (g *Grid) Rows() ([]Row, []string) {
	g.mu.RLock()
	defer g.mu.RUnlock()
	rows := make([]Row, 0, len(g.vals))
	for k, v := range g.vals {
		rows = append(rows, Row{k, *v})
	}
	seen := make([]string, 0, len(g.observed))
	for dh := range g.observed {
		seen = append(seen, dh)
	}
	return rows, seen
}

// Profile is the average per day at a location, by hour.
type Profile struct {
	Days         [24]float64 `json:"days"` // how many days of data each hour is based on
	Passes       [24]float64 `json:"passes"`
	Low          [24]float64 `json:"low"`
	Helis        [24]float64 `json:"helis"`
	PoliceMin    [24]float64 `json:"police_min"`
	AmbulanceMin [24]float64 `json:"ambulance_min"`
}

func hourOf(dh string) (int, bool) {
	if len(dh) != 13 {
		return 0, false
	}
	return int(dh[11]-'0')*10 + int(dh[12]-'0'), true
}

// At returns per-day averages for the 3×3 block of cells around a point
// (roughly everything within 1.5 km), across every day of the week.
func (g *Grid) At(lat, lon float64) Profile {
	var p Profile
	center, ok := CellOf(lat, lon)
	if !ok {
		return p
	}
	g.mu.RLock()
	defer g.mu.RUnlock()
	for dh := range g.observed {
		if h, ok := hourOf(dh); ok {
			p.Days[h]++
		}
	}
	var sum [24]Vals
	for dr := -1; dr <= 1; dr++ {
		for dc := -1; dc <= 1; dc++ {
			cell := center + Cell(dr*cols+dc)
			for d := int8(0); d < 7; d++ {
				for h := int8(0); h < 24; h++ {
					if v := g.vals[Key{cell, d, h}]; v != nil {
						sum[h].add(v)
					}
				}
			}
		}
	}
	for h := 0; h < 24; h++ {
		d := p.Days[h]
		if d == 0 {
			continue
		}
		p.Passes[h] = round1(sum[h].Passes / d)
		p.Low[h] = round1(sum[h].Low / d)
		p.Helis[h] = round1(sum[h].Helis / d)
		p.PoliceMin[h] = round1(sum[h].PoliceSec / 60 / d)
		p.AmbulanceMin[h] = round1(sum[h].AmbSec / 60 / d)
	}
	return p
}

// FlightPathHours are the hours the map's flight-path slider covers, in
// order: 9pm through to the 9am–10am slot.
var FlightPathHours = []int{21, 22, 23, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9}

// HeatCells returns, for each cell with traffic, the average number of
// aircraft passing per hour for each of FlightPathHours.
func (g *Grid) HeatCells() []HeatCell {
	g.mu.RLock()
	defer g.mu.RUnlock()
	var days [24]float64
	for dh := range g.observed {
		if h, ok := hourOf(dh); ok {
			days[h]++
		}
	}
	perCell := map[Cell]*[24]float64{}
	for k, v := range g.vals {
		c := perCell[k.Cell]
		if c == nil {
			c = &[24]float64{}
			perCell[k.Cell] = c
		}
		c[k.Hour] += v.Passes
	}
	var out []HeatCell
	for cell, c := range perCell {
		hc := HeatCell{Hourly: make([]float64, len(FlightPathHours))}
		var any bool
		for i, h := range FlightPathHours {
			if days[h] > 0 {
				hc.Hourly[i] = round1(c[h] / days[h])
				any = any || hc.Hourly[i] >= 0.3
			}
		}
		if any {
			r, col := int(cell)/cols, int(cell)%cols
			hc.Lat = round4(MinLat + (float64(r)+0.5)*cellLat)
			hc.Lon = round4(MinLon + (float64(col)+0.5)*cellLon)
			out = append(out, hc)
		}
	}
	return out
}

type HeatCell struct {
	Lat    float64   `json:"lat"`
	Lon    float64   `json:"lon"`
	Hourly []float64 `json:"h"` // aircraft per hour, one per FlightPathHours entry
}

// NightHours are 11pm to 6am, in order.
var NightHours = []int{23, 0, 1, 2, 3, 4, 5}

// DaysObserved is how many full days of data the grid holds.
func (g *Grid) DaysObserved() int {
	g.mu.RLock()
	defer g.mu.RUnlock()
	return int(math.Round(float64(len(g.observed)) / 24))
}

func round1(v float64) float64 { return math.Round(v*10) / 10 }
func round4(v float64) float64 { return math.Round(v*1e4) / 1e4 }

// Snapshots: a gzipped JSON copy of a grid, used for the bundled seed and for
// local runs without a database. "rows" is the current format; "cells" (24
// hourly totals per cell, no day of the week) is the old one, still read so
// existing files can be imported.
type snapshot struct {
	Rows     [][8]float64           `json:"rows,omitempty"` // cell, dow, hour, passes, low, helis, police_sec, amb_sec
	Cells    map[Cell]*legacyCounts `json:"cells,omitempty"`
	Observed []string               `json:"observed"`
}

type legacyCounts struct {
	Passes    [24]float64 `json:"p"`
	Low       [24]float64 `json:"l"`
	Helis     [24]float64 `json:"h"`
	PoliceSec [24]float64 `json:"ps"`
	AmbSec    [24]float64 `json:"as"`
}

// Encode serialises the grid as a gzipped snapshot.
func (g *Grid) Encode() ([]byte, error) {
	rows, seen := g.Rows()
	s := snapshot{Observed: seen, Rows: make([][8]float64, len(rows))}
	for i, r := range rows {
		s.Rows[i] = [8]float64{float64(r.Cell), float64(r.Dow), float64(r.Hour), r.Passes, r.Low, r.Helis, r.PoliceSec, r.AmbSec}
	}
	raw, err := json.Marshal(s)
	if err != nil {
		return nil, err
	}
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	zw.Write(raw)
	zw.Close()
	return buf.Bytes(), nil
}

// Decode reads a snapshot in either format. Old-format totals have no day of
// the week, so each hour's totals are shared across the days that hour was
// recorded on, in proportion.
func Decode(gz []byte) ([]Row, []string, error) {
	if len(gz) == 0 {
		return nil, nil, nil
	}
	zr, err := gzip.NewReader(bytes.NewReader(gz))
	if err != nil {
		return nil, nil, err
	}
	raw, err := io.ReadAll(zr)
	if err != nil {
		return nil, nil, err
	}
	var s snapshot
	if err := json.Unmarshal(raw, &s); err != nil {
		return nil, nil, err
	}
	var rows []Row
	for _, r := range s.Rows {
		rows = append(rows, Row{Key{Cell(r[0]), int8(r[1]), int8(r[2])}, Vals{r[3], r[4], r[5], r[6], r[7]}})
	}
	if len(s.Cells) > 0 {
		// Which days of the week each hour was observed on, and how often.
		var dows [24][7]float64
		var total [24]float64
		for _, dh := range s.Observed {
			t, err := time.ParseInLocation("2006-01-02T15", dh, London)
			if err != nil {
				continue
			}
			dows[t.Hour()][dowOf(t)]++
			total[t.Hour()]++
		}
		for cell, c := range s.Cells {
			for h := 0; h < 24; h++ {
				for d := 0; d < 7; d++ {
					if total[h] == 0 || dows[h][d] == 0 {
						continue
					}
					f := dows[h][d] / total[h]
					v := Vals{c.Passes[h] * f, c.Low[h] * f, c.Helis[h] * f, c.PoliceSec[h] * f, c.AmbSec[h] * f}
					if v != (Vals{}) {
						rows = append(rows, Row{Key{cell, int8(d), int8(h)}, v})
					}
				}
			}
		}
	}
	return rows, s.Observed, nil
}

// Merge adds a snapshot into the grid, skipping it if it overlaps date-hours
// the grid already has, so the same data is never counted twice.
func (g *Grid) Merge(gz []byte) error {
	rows, seen, err := Decode(gz)
	if err != nil {
		return err
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	for _, dh := range seen {
		if g.observed[dh] {
			return nil
		}
	}
	for _, dh := range seen {
		g.observeLocked(dh)
	}
	for _, r := range rows {
		v := r.Vals
		g.addLocked(r.Key, &v)
	}
	return nil
}

//go:embed seed.json.gz
var seed []byte

// Seed returns the history bundled into the binary by cmd/backfill.
func Seed() []byte { return seed }
