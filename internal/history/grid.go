// Package history keeps measured aircraft activity over London by hour of the
// day, on a ~1 km grid. It's filled from adsb.lol's daily archives (backfill)
// and topped up continuously by the live poller.
package history

import (
	"bytes"
	"compress/gzip"
	_ "embed"
	"encoding/json"
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

// Counts are totals per local hour of day (0 = midnight to 1am).
type Counts struct {
	Passes    [24]float64 `json:"p"`  // distinct aircraft through the cell
	Low       [24]float64 `json:"l"`  // ...of which below LowAltFt
	Helis     [24]float64 `json:"h"`  // distinct helicopters (any operator)
	PoliceSec [24]float64 `json:"ps"` // seconds a police helicopter was in the cell
	AmbSec    [24]float64 `json:"as"` // seconds an air ambulance was in the cell
}

func (c *Counts) add(o *Counts) {
	for h := 0; h < 24; h++ {
		c.Passes[h] += o.Passes[h]
		c.Low[h] += o.Low[h]
		c.Helis[h] += o.Helis[h]
		c.PoliceSec[h] += o.PoliceSec[h]
		c.AmbSec[h] += o.AmbSec[h]
	}
}

// Grid is safe for concurrent use.
type Grid struct {
	mu       sync.RWMutex
	cells    map[Cell]*Counts
	observed map[string]bool // "2026-10-08T03": local date-hours we have data for
}

func NewGrid() *Grid {
	return &Grid{cells: map[Cell]*Counts{}, observed: map[string]bool{}}
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
		// Keep last hour's keys too: archives and polls aren't perfectly ordered.
		if len(r.seen) > 200000 {
			r.seen = map[string]bool{}
		}
		r.hour = dh
	}
	h := local.Hour()
	key := o.Hex + "|" + dh + "|" + string(rune(cell))

	r.g.mu.Lock()
	defer r.g.mu.Unlock()
	r.g.observed[dh] = true
	c := r.g.cells[cell]
	if c == nil {
		c = &Counts{}
		r.g.cells[cell] = c
	}
	if !r.seen[key] {
		r.seen[key] = true
		c.Passes[h]++
		if o.AltFt < LowAltFt {
			c.Low[h]++
		}
		if o.Kind != "plane" {
			c.Helis[h]++
		}
	}
	dt := math.Min(o.DtSec, 60)
	switch o.Kind {
	case "police":
		c.PoliceSec[h] += dt
	case "air_ambulance":
		c.AmbSec[h] += dt
	}
}

// MarkObserved records that we had coverage for a date-hour even if nothing
// flew through the grid (so quiet hours count as zero, not missing).
func (g *Grid) MarkObserved(t time.Time) {
	g.mu.Lock()
	g.observed[t.In(London).Format("2006-01-02T15")] = true
	g.mu.Unlock()
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

// At returns per-day averages for the 3×3 block of cells around a point
// (roughly everything within 1.5 km).
func (g *Grid) At(lat, lon float64) Profile {
	var p Profile
	center, ok := CellOf(lat, lon)
	if !ok {
		return p
	}
	g.mu.RLock()
	defer g.mu.RUnlock()
	for dh := range g.observed {
		var h int
		if len(dh) == 13 {
			h = int(dh[11]-'0')*10 + int(dh[12]-'0')
			p.Days[h]++
		}
	}
	var sum Counts
	for dr := -1; dr <= 1; dr++ {
		for dc := -1; dc <= 1; dc++ {
			if c := g.cells[center+Cell(dr*cols+dc)]; c != nil {
				sum.add(c)
			}
		}
	}
	for h := 0; h < 24; h++ {
		d := p.Days[h]
		if d == 0 {
			continue
		}
		p.Passes[h] = round1(sum.Passes[h] / d)
		p.Low[h] = round1(sum.Low[h] / d)
		p.Helis[h] = round1(sum.Helis[h] / d)
		p.PoliceMin[h] = round1(sum.PoliceSec[h] / 60 / d)
		p.AmbulanceMin[h] = round1(sum.AmbSec[h] / 60 / d)
	}
	return p
}

// HeatCells returns night-time (11pm to 6am) average passes per cell, for the
// map's overflight layer.
func (g *Grid) HeatCells() []HeatCell {
	g.mu.RLock()
	defer g.mu.RUnlock()
	var days [24]float64
	for dh := range g.observed {
		if len(dh) == 13 {
			days[int(dh[11]-'0')*10+int(dh[12]-'0')]++
		}
	}
	var out []HeatCell
	for cell, c := range g.cells {
		var n float64
		for _, h := range NightHours {
			if days[h] > 0 {
				n += c.Passes[h] / days[h]
			}
		}
		if n >= 0.5 {
			r, col := int(cell)/cols, int(cell)%cols
			out = append(out, HeatCell{
				Lat:    round4(MinLat + (float64(r)+0.5)*cellLat),
				Lon:    round4(MinLon + (float64(col)+0.5)*cellLon),
				Passes: round1(n),
			})
		}
	}
	return out
}

type HeatCell struct {
	Lat    float64 `json:"lat"`
	Lon    float64 `json:"lon"`
	Passes float64 `json:"passes"` // per night
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

type snapshot struct {
	Cells    map[Cell]*Counts `json:"cells"`
	Observed []string         `json:"observed"`
}

// Encode serialises the grid as gzipped JSON.
func (g *Grid) Encode() ([]byte, error) {
	g.mu.RLock()
	s := snapshot{Cells: g.cells}
	for dh := range g.observed {
		s.Observed = append(s.Observed, dh)
	}
	raw, err := json.Marshal(s)
	g.mu.RUnlock()
	if err != nil {
		return nil, err
	}
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	zw.Write(raw)
	zw.Close()
	return buf.Bytes(), nil
}

// Merge adds a gzipped snapshot into the grid, skipping date-hours the grid
// already has so the same data is never counted twice.
func (g *Grid) Merge(gz []byte) error {
	if len(gz) == 0 {
		return nil
	}
	zr, err := gzip.NewReader(bytes.NewReader(gz))
	if err != nil {
		return err
	}
	raw, err := io.ReadAll(zr)
	if err != nil {
		return err
	}
	var s snapshot
	if err := json.Unmarshal(raw, &s); err != nil {
		return err
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	overlap := false
	for _, dh := range s.Observed {
		if g.observed[dh] {
			overlap = true
		}
	}
	if overlap {
		return nil // already merged (e.g. a saved snapshot that includes the seed)
	}
	for _, dh := range s.Observed {
		g.observed[dh] = true
	}
	for cell, c := range s.Cells {
		if g.cells[cell] == nil {
			g.cells[cell] = &Counts{}
		}
		g.cells[cell].add(c)
	}
	return nil
}

//go:embed seed.json.gz
var seed []byte

// Seed returns the history bundled into the binary by cmd/backfill.
func Seed() []byte { return seed }
