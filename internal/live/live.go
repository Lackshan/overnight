// Package live polls fast-changing data for all of London in the background,
// so user requests only ever read from memory. Every aircraft position is
// also recorded into the history grid.
package live

import (
	"context"
	"errors"
	"fmt"
	"log"
	"math"
	"sort"
	"sync"
	"time"

	"overnight/internal/history"
	"overnight/internal/sources"
)

const (
	londonLat, londonLon = 51.5072, -0.1276
	londonRadiusNM       = 40 // ~74 km: Greater London plus the approaches
	// adsb.lol rate-limits; poll as fast as it allows, backing off on 429s.
	aircraftMin   = 4 * time.Second
	aircraftMax   = 30 * time.Second
	linesEvery    = 60 * time.Second
	maxEvents     = 200
	eventCooldown = 30 * time.Minute // don't re-announce the same helicopter
	trackKeep     = 20 * time.Minute // per-aircraft history, for the police delay
)

type Event struct {
	ID    string    `json:"id"`
	At    time.Time `json:"at"`
	Kind  string    `json:"kind"` // police, air_ambulance, emergency, tfl
	Text  string    `json:"text"`
	Lat   float64   `json:"lat,omitempty"`
	Lon   float64   `json:"lon,omitempty"`
	Line  string    `json:"line,omitempty"`   // TfL line ID for tfl events
	Good  bool      `json:"good,omitempty"`   // tfl: service restored
	DistM float64   `json:"dist_m,omitempty"` // filled per request
}

type Hub struct {
	// PoliceDelay optionally holds back police helicopter positions. Off by
	// default: they're visible and audible overhead, and public on other trackers.
	PoliceDelay time.Duration
	Grid        *history.Grid

	mu        sync.RWMutex
	tracks    map[string][]sources.Aircraft // recent positions per aircraft, oldest first
	visible   []sources.Aircraft            // what users may see right now
	acUpdated time.Time
	lines     map[string]sources.LineStatus
	events    []Event
	announced map[string]time.Time
	seq       int
	rec       *history.Recorder
}

func NewHub(grid *history.Grid, policeDelay time.Duration) *Hub {
	return &Hub{
		PoliceDelay: policeDelay,
		Grid:        grid,
		tracks:      map[string][]sources.Aircraft{},
		lines:       map[string]sources.LineStatus{},
		announced:   map[string]time.Time{},
		rec:         grid.NewRecorder(),
	}
}

// Run polls until ctx is cancelled.
func (h *Hub) Run(ctx context.Context) {
	every := aircraftMin
	h.pollLines(ctx, true)
	ac := time.NewTimer(0)
	ln := time.NewTicker(linesEvery)
	defer ac.Stop()
	defer ln.Stop()
	ok := 0
	for {
		select {
		case <-ctx.Done():
			return
		case <-ac.C:
			if err := h.pollAircraft(ctx); err != nil {
				var se *sources.StatusError
				if errors.As(err, &se) && se.Code == 429 {
					every = min(every*2, aircraftMax)
					ok = 0
					log.Printf("live: adsb.lol rate limit, polling every %s", every)
				} else {
					log.Printf("live: aircraft: %v", err)
				}
			} else if ok++; ok >= 20 && every > aircraftMin {
				every = max(every-time.Second, aircraftMin)
				ok = 0
			}
			ac.Reset(every)
		case <-ln.C:
			h.pollLines(ctx, false)
		}
	}
}

func (h *Hub) pollAircraft(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, 6*time.Second)
	defer cancel()
	latest, err := sources.AircraftNear(ctx, londonLat, londonLon, londonRadiusNM)
	if err != nil {
		return err
	}
	now := time.Now()
	h.mu.Lock()
	defer h.mu.Unlock()

	// Record into history and extend each aircraft's track.
	h.Grid.MarkObserved(now)
	seen := map[string]bool{}
	for _, a := range latest {
		seen[a.Hex] = true
		tr := h.tracks[a.Hex]
		if n := len(tr); n > 0 && tr[n-1].T >= a.T {
			continue // no new position since last poll
		}
		dt := 3.0
		if n := len(tr); n > 0 {
			dt = float64(a.T-tr[n-1].T) / 1000
		}
		h.rec.Add(history.Observation{
			Hex: a.Hex, At: time.UnixMilli(a.T), Lat: a.Lat, Lon: a.Lon,
			AltFt: a.AltFt, Kind: a.Kind, DtSec: dt,
		})
		h.tracks[a.Hex] = append(tr, a)
	}
	cutoff := now.Add(-trackKeep).UnixMilli()
	for hex, tr := range h.tracks {
		i := 0
		for i < len(tr) && tr[i].T < cutoff {
			i++
		}
		if i == len(tr) {
			delete(h.tracks, hex)
		} else {
			h.tracks[hex] = tr[i:]
		}
	}

	// What users see: the latest position, except police, who are shown as
	// they were PoliceDelay ago.
	h.visible = h.visible[:0]
	delayed := now.Add(-h.PoliceDelay).UnixMilli()
	for hex, tr := range h.tracks {
		last := tr[len(tr)-1]
		if last.Kind != "police" || h.PoliceDelay == 0 {
			if seen[hex] {
				h.visible = append(h.visible, last)
			}
			continue
		}
		// Latest position at or before the delay cut-off, if still fresh.
		for i := len(tr) - 1; i >= 0; i-- {
			if tr[i].T <= delayed {
				if delayed-tr[i].T < 60_000 { // MLAT positions can be sparse
					p := tr[i]
					p.T += h.PoliceDelay.Milliseconds() // so the browser animates it in step
					h.visible = append(h.visible, p)
				}
				break
			}
		}
	}
	h.acUpdated = now

	for _, a := range h.visible {
		var text string
		kind := a.Kind
		switch {
		case a.Squawk == "7700":
			text, kind = fmt.Sprintf("%s declared an emergency (squawk 7700)", name(a)), "emergency"
		case a.Kind == "police" && a.AltFt > 0:
			text = "Police helicopter in the area"
		case a.Kind == "air_ambulance" && a.AltFt > 0:
			text = "Air ambulance in the area"
		default:
			continue
		}
		if last, ok := h.announced[a.Hex]; ok && now.Sub(last) < eventCooldown {
			continue
		}
		h.announced[a.Hex] = now
		h.addLocked(Event{At: now, Kind: kind, Text: text, Lat: a.Lat, Lon: a.Lon})
	}
	return nil
}

func name(a sources.Aircraft) string {
	if a.Callsign != "" {
		return a.Callsign
	}
	return a.Reg
}

func (h *Hub) pollLines(ctx context.Context, first bool) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	ls, err := sources.LineStatuses(ctx)
	if err != nil {
		log.Printf("live: tfl: %v", err)
		return
	}
	now := time.Now()
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, l := range ls {
		prev, seen := h.lines[l.ID]
		h.lines[l.ID] = l
		switch {
		case first && l.Severity != 10:
			h.addLocked(Event{At: now, Kind: "tfl", Line: l.ID, Text: fmt.Sprintf("%s: %s", lineName(l), l.Status)})
		case seen && prev.Severity != l.Severity:
			h.addLocked(Event{At: now, Kind: "tfl", Line: l.ID, Good: l.Severity == 10, Text: fmt.Sprintf("%s: %s", lineName(l), l.Status)})
		}
	}
}

func lineName(l sources.LineStatus) string {
	if l.Mode == "tube" {
		return l.Name + " line"
	}
	return l.Name
}

func (h *Hub) addLocked(e Event) {
	h.seq++
	e.ID = fmt.Sprint(h.seq)
	h.events = append(h.events, e)
	if len(h.events) > maxEvents {
		h.events = h.events[len(h.events)-maxEvents:]
	}
}

// Snapshot is what the browser polls for one location.
type Snapshot struct {
	Now      int64                `json:"now"` // server time, Unix ms, so the browser can sync its clock
	Updated  time.Time            `json:"updated"`
	Aircraft []sources.Aircraft   `json:"aircraft,omitempty"`
	Nearby   int                  `json:"aircraft_nearby"` // airborne within 5 km
	Events   []Event              `json:"events,omitempty"`
	Lines    []sources.LineStatus `json:"lines,omitempty"` // status of lines serving the area
}

// Box is a map viewport: south-west and north-east corners.
type Box struct{ South, West, North, East float64 }

func (b *Box) contains(lat, lon float64) bool {
	return lat >= b.South && lat <= b.North && lon >= b.West && lon <= b.East
}

const maxAircraft = 500

// Query returns aircraft inside box (or within aircraftKM of the point when
// box is nil), events within eventKM or on any of lines, and those lines'
// current status.
func (h *Hub) Query(lat, lon, aircraftKM float64, box *Box, eventKM float64, lines []string, maxEvents int) Snapshot {
	h.mu.RLock()
	defer h.mu.RUnlock()
	s := Snapshot{Now: time.Now().UnixMilli(), Updated: h.acUpdated}
	for _, a := range h.visible {
		d := DistanceM(lat, lon, a.Lat, a.Lon)
		if (box != nil && box.contains(a.Lat, a.Lon)) || (box == nil && d <= aircraftKM*1000) {
			s.Aircraft = append(s.Aircraft, a)
		}
		if d <= 5000 && a.AltFt > 0 {
			s.Nearby++
		}
	}
	if len(s.Aircraft) > maxAircraft {
		// Zoomed right out: keep the ones nearest the middle of the view.
		sort.Slice(s.Aircraft, func(i, j int) bool {
			return DistanceM(lat, lon, s.Aircraft[i].Lat, s.Aircraft[i].Lon) < DistanceM(lat, lon, s.Aircraft[j].Lat, s.Aircraft[j].Lon)
		})
		s.Aircraft = s.Aircraft[:maxAircraft]
	}
	want := map[string]bool{}
	for _, id := range lines {
		want[id] = true
		if l, ok := h.lines[id]; ok {
			s.Lines = append(s.Lines, l)
		}
	}
	sort.Slice(s.Lines, func(i, j int) bool { return s.Lines[i].Severity < s.Lines[j].Severity })
	for i := len(h.events) - 1; i >= 0 && (maxEvents == 0 || len(s.Events) < maxEvents); i-- {
		e := h.events[i]
		if e.Kind == "tfl" {
			if want[e.Line] {
				s.Events = append(s.Events, e)
			}
			continue
		}
		if d := DistanceM(lat, lon, e.Lat, e.Lon); d <= eventKM*1000 {
			e.DistM = math.Round(d/10) * 10
			s.Events = append(s.Events, e)
		}
	}
	return s
}

// LineStatus returns the current status of a TfL line, if known.
func (h *Hub) LineStatus(id string) (sources.LineStatus, bool) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	l, ok := h.lines[id]
	return l, ok
}

// DistanceM is the great-circle distance in metres.
func DistanceM(lat1, lon1, lat2, lon2 float64) float64 {
	const r = 6371000
	p1, p2 := lat1*math.Pi/180, lat2*math.Pi/180
	dp, dl := (lat2-lat1)*math.Pi/180, (lon2-lon1)*math.Pi/180
	a := math.Sin(dp/2)*math.Sin(dp/2) + math.Cos(p1)*math.Cos(p2)*math.Sin(dl/2)*math.Sin(dl/2)
	return 2 * r * math.Asin(math.Sqrt(a))
}
