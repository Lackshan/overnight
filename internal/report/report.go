// Package report builds the hour-by-hour report for a postcode and strips out
// whatever the caller's plan isn't allowed to see.
package report

import (
	"context"
	"fmt"
	"math"
	"os"
	"sort"
	"strings"
	"time"

	"golang.org/x/sync/errgroup"

	"overnight/internal/config"
	"overnight/internal/history"
	"overnight/internal/live"
	"overnight/internal/sources"
)

const (
	RadiusM    = 800 // stations: about a 10-minute walk
	BusRadiusM = 500 // night buses: a short walk in the dark
)

var (
	nightHours = history.NightHours // 11pm to 6am
	dayHours   = []int{8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19}
)

type Report struct {
	Place       *sources.Postcode `json:"place"`
	RadiusM     int               `json:"radius_m"`
	Generated   time.Time         `json:"generated"`
	HistoryDays int               `json:"history_days"` // days of aircraft history behind the numbers
	Night       *Score            `json:"night,omitempty"`
	Day         *Score            `json:"day,omitempty"`
	Hourly      []int             `json:"hourly,omitempty"` // overall score for each hour, 0 = midnight
	Sections    []Section         `json:"sections,omitempty"`
	Breakdown   []CategoryCount   `json:"breakdown,omitempty"`
	GettingHome *GettingHome      `json:"getting_home,omitempty"`
	Layers      Layers            `json:"layers"`
	Lines       []string          `json:"lines"` // TfL line IDs serving the area, for the live feed
	Locked      []string          `json:"locked"`
	partial     bool              // built from incomplete data; not cached
}

type Score struct {
	Score int    `json:"score"`
	Band  string `json:"band"`
}

type Section struct {
	ID        string   `json:"id"`
	Label     string   `json:"label"`
	Night     *int     `json:"night"` // average score 11pm–6am; nil when unavailable
	Day       *int     `json:"day"`   // average score 8am–8pm
	Headline  string   `json:"headline"`
	DayLine   string   `json:"day_line"`
	Unit      string   `json:"unit"`
	Measured  bool     `json:"measured"` // false: estimated
	Sample    bool     `json:"sample,omitempty"`
	Note      string   `json:"note,omitempty"`
	Hourly    []*Point `json:"hourly,omitempty"` // 24 entries, 0 = midnight; nil where there's no data
	Details   []Detail `json:"details,omitempty"`
	hourScore [24]float64
	hourValue [24]float64
}

// Point is one hour: the raw value in the section's unit, and its 0–100 score.
type Point struct {
	Value float64 `json:"value"`
	Score int     `json:"score"`
}

type Detail struct {
	Label string `json:"label"`
	Value string `json:"value"`
}

type CategoryCount struct {
	Category string `json:"category"`
	Label    string `json:"label"`
	Count    int    `json:"count"`
}

type Layers struct {
	Crime    []sources.Crime   `json:"crime,omitempty"`
	Air      []sources.AirSite `json:"air,omitempty"`
	Stations []sources.Station `json:"stations,omitempty"`
}

type Builder struct {
	Hub   *live.Hub
	cache *sources.Cache[*Report]
}

func NewBuilder(hub *live.Hub) *Builder {
	return &Builder{Hub: hub, cache: sources.NewCache[*Report](10 * time.Minute)}
}

// Build returns the full, ungated report for a postcode.
func (b *Builder) Build(ctx context.Context, postcode string) (*Report, error) {
	place, err := sources.LookupPostcode(ctx, postcode)
	if err != nil {
		return nil, err
	}
	r, err := b.cache.Get(ctx, place.Postcode, func(ctx context.Context) (*Report, error) {
		return b.build(ctx, place)
	})
	if r != nil && r.partial {
		b.cache.Forget(place.Postcode) // try the missing sources again next time
	}
	return r, err
}

func (b *Builder) build(ctx context.Context, p *sources.Postcode) (*Report, error) {
	var (
		crimes          []sources.Crime
		stations        []sources.Station
		buses           []sources.BusRoute
		weeks           map[string]*sources.Week
		partial         bool // some source failed: don't cache this report
		airSites        []sources.AirSite
		airHist         *sources.AirByHour
		crimeErr, stErr error
		busErr, airErr  error
	)
	g, gctx := errgroup.WithContext(ctx)
	g.Go(func() error { crimes, crimeErr = sources.CrimesNear(gctx, p.Lat, p.Lon); return nil })
	g.Go(func() error { stations, stErr = sources.StationsNear(gctx, p.Lat, p.Lon, RadiusM); return nil })
	g.Go(func() error {
		buses, busErr = sources.BusRoutesNear(gctx, p.Lat, p.Lon, BusRadiusM)
		if busErr == nil {
			var ok bool
			// Night routes plus the nearest regular ones (to spot 24-hour routes).
			// Without a TfL app key the rate limit only allows a few.
			regular := 6
			if os.Getenv("TFL_APP_KEY") != "" {
				regular = 20
			}
			weeks, ok = sources.BusWeeks(gctx, buses, regular)
			partial = partial || !ok
		}
		return nil
	})
	g.Go(func() error {
		airSites, airErr = sources.AirSites(gctx)
		if airErr != nil {
			return nil
		}
		// Use the nearest monitor that has history.
		sort.Slice(airSites, func(i, j int) bool {
			return live.DistanceM(p.Lat, p.Lon, airSites[i].Lat, airSites[i].Lon) < live.DistanceM(p.Lat, p.Lon, airSites[j].Lat, airSites[j].Lon)
		})
		for i := 0; i < len(airSites) && i < 4; i++ {
			if h, err := sources.AirHistory(gctx, airSites[i]); err == nil {
				airHist = h
				return nil
			}
		}
		return nil
	})
	g.Wait()

	prof := b.Hub.Grid.At(p.Lat, p.Lon)
	gh, ghOK := b.nightOptions(ctx, stations, buses, weeks)
	partial = partial || !ghOK || crimeErr != nil || stErr != nil || busErr != nil || airErr != nil
	r := &Report{Place: p, RadiusM: RadiusM, Generated: time.Now(), HistoryDays: b.Hub.Grid.DaysObserved(), partial: partial}

	r.Lines = b.tflLines(stations)
	r.Sections = []Section{
		aircraftSection(prof, r.HistoryDays),
		helicopterSection(prof, r.HistoryDays),
		b.gettingHomeSection(stations, gh, stErr, busErr),
		airSection(p, airSites, airHist),
		safetySection(crimes, crimeErr),
		emergencySection(prof),
	}
	r.Breakdown = breakdown(crimes)
	r.GettingHome = gh

	// Overall score per hour, weighted across sections that have data.
	weights := map[string]float64{"aircraft": .25, "helicopters": .1, "getting_home": .2, "air": .15, "safety": .2, "emergency": .1}
	var hourly [24]float64
	for h := 0; h < 24; h++ {
		var sum, w float64
		for _, s := range r.Sections {
			if s.Night != nil {
				sum += s.hourScore[h] * weights[s.ID]
				w += weights[s.ID]
			}
		}
		if w > 0 {
			hourly[h] = sum / w
		}
	}
	r.Hourly = make([]int, 24)
	for h := range hourly {
		r.Hourly[h] = int(math.Round(hourly[h]))
	}
	// Headline scores come from the sections' own night and day scores, which
	// include caps (like the dawn-arrivals one) that hourly averages miss.
	var ns, ds, w float64
	for _, s := range r.Sections {
		if s.Night != nil {
			ns += float64(*s.Night) * weights[s.ID]
			ds += float64(*s.Day) * weights[s.ID]
			w += weights[s.ID]
		}
	}
	n, d := int(math.Round(ns/w)), int(math.Round(ds/w))
	r.Night = &Score{Score: n, Band: nightBand(n)}
	r.Day = &Score{Score: d, Band: dayBand(d)}

	r.Layers = Layers{Crime: crimes, Stations: stations}
	for _, s := range airSites {
		if live.DistanceM(p.Lat, p.Lon, s.Lat, s.Lon) <= 10000 {
			r.Layers.Air = append(r.Layers.Air, s)
		}
	}
	return r, nil
}

func nightBand(s int) string {
	switch {
	case s >= 75:
		return "Quiet nights"
	case s >= 60:
		return "Mostly quiet"
	case s >= 45:
		return "Restless"
	default:
		return "Lively nights"
	}
}

func dayBand(s int) string {
	switch {
	case s >= 75:
		return "Great by day"
	case s >= 60:
		return "Good by day"
	case s >= 45:
		return "Fair by day"
	default:
		return "Busy by day"
	}
}

func clamp(v float64) float64 { return math.Max(0, math.Min(100, v)) }

func avg(v [24]float64, hours []int) int {
	var s float64
	for _, h := range hours {
		s += v[h]
	}
	return int(math.Round(s / float64(len(hours))))
}

func sum(v [24]float64, hours []int) float64 {
	var s float64
	for _, h := range hours {
		s += v[h]
	}
	return s
}

// finish fills the night and day scores and the hourly series from
// hourValue and hourScore.
func (s *Section) finish() Section {
	n, d := avg(s.hourScore, nightHours), avg(s.hourScore, dayHours)
	s.Night, s.Day = &n, &d
	s.Hourly = make([]*Point, 24)
	for h := 0; h < 24; h++ {
		if math.IsNaN(s.hourValue[h]) {
			continue
		}
		s.Hourly[h] = &Point{Value: round1(s.hourValue[h]), Score: int(math.Round(s.hourScore[h]))}
	}
	return *s
}

func round1(v float64) float64 { return math.Round(v*10) / 10 }

// Planes: measured from ADS-B history within about 1.5 km.
func aircraftSection(p history.Profile, days int) Section {
	s := Section{ID: "aircraft", Label: "Planes overhead", Unit: "flights an hour", Measured: true}
	if days == 0 {
		s.Headline = "Still collecting flight history for this area"
		return s
	}
	// Low aircraft are what you hear; high ones barely count.
	for h := 0; h < 24; h++ {
		s.hourValue[h] = p.Passes[h]
		s.hourScore[h] = clamp(100 - 1.5*(p.Passes[h]-p.Low[h]) - 12*p.Low[h])
	}
	night, low := sum(p.Passes, nightHours), sum(p.Low, nightHours)

	first := -1
	for h := 4; h <= 7; h++ {
		if p.Passes[h] >= 1 {
			first = h
			break
		}
	}
	switch {
	case night < 0.5:
		s.Headline = "No planes overhead between 11pm and 6am"
	default:
		s.Headline = fmt.Sprintf("%.0f flights overhead between 11pm and 6am", night)
		if low >= 0.5 {
			s.Headline += fmt.Sprintf(", %.0f of them below 4,000 ft", low)
		}
	}
	if first >= 0 {
		s.Details = append(s.Details, Detail{Label: "First regular flight", Value: "around " + hourName(first)})
	}
	s.DayLine = fmt.Sprintf("%.0f an hour by day", sum(p.Passes, dayHours)/float64(len(dayHours)))
	s.Details = append(s.Details, Detail{Label: "Based on", Value: fmt.Sprintf("%d days of ADS-B data within about 1.5 km", days)})
	out := s.finish()
	// A quiet 1am doesn't make up for 40 low arrivals from 4:30am, so the
	// night score is also capped by the night's total.
	if capped := int(clamp(100 - 0.5*(night-low) - 1.5*low)); capped < *out.Night {
		*out.Night = capped
	}
	return out
}

// Helicopters: police and air ambulance time overhead, measured.
func helicopterSection(p history.Profile, days int) Section {
	s := Section{ID: "helicopters", Label: "Helicopters", Unit: "minutes an hour", Measured: true}
	if days == 0 {
		s.Headline = "Still collecting helicopter history for this area"
		return s
	}
	for h := 0; h < 24; h++ {
		mins := p.PoliceMin[h] + p.AmbulanceMin[h]
		s.hourValue[h] = mins
		s.hourScore[h] = clamp(100 - 15*mins - 8*p.Helis[h])
	}
	police, amb := sum(p.PoliceMin, nightHours), sum(p.AmbulanceMin, nightHours)
	switch {
	case police+amb < 0.5:
		s.Headline = "Police and air ambulance helicopters rarely hover here at night"
	case police >= amb:
		s.Headline = fmt.Sprintf("A police helicopter is overhead about %.0f minutes a night", police)
	default:
		s.Headline = fmt.Sprintf("An air ambulance is overhead about %.0f minutes a night", amb)
	}
	s.DayLine = fmt.Sprintf("%.0f minutes of police and air ambulance time by day", sum(p.PoliceMin, dayHours)+sum(p.AmbulanceMin, dayHours))
	s.Details = []Detail{
		{Label: "Police, 11pm–6am", Value: fmt.Sprintf("%.0f min a night", police)},
		{Label: "Air ambulance, 11pm–6am", Value: fmt.Sprintf("%.0f min a night", amb)},
		{Label: "Other helicopters", Value: fmt.Sprintf("%.0f a day", sum(p.Helis, allHours()))},
	}
	return s.finish()
}

func allHours() []int {
	h := make([]int, 24)
	for i := range h {
		h[i] = i
	}
	return h
}

// NightOption is one way home after midnight and the nights it runs.
type NightOption struct {
	Kind     string       `json:"kind"`  // night_tube, night_overground, night_bus, all_night_bus
	Line     string       `json:"line"`  // "Central", "N205", "25"
	Where    string       `json:"where"` // station or stop
	Lat      float64      `json:"lat"`
	Lon      float64      `json:"lon"`
	Distance float64      `json:"distance_m"`
	Nights   sources.Week `json:"nights"` // Monday night first; null where it doesn't run
}

// LastBus is a regular route's last departure on a weeknight.
type LastBus struct {
	Route string `json:"route"`
	Stop  string `json:"stop"`
	Time  string `json:"time"`
}

type GettingHome struct {
	Options   []NightOption `json:"options"`
	LastBuses []LastBus     `json:"last_buses,omitempty"`
}

// nightOptions finds the Night Tube stations and all-night buses nearby.
func (b *Builder) nightOptions(ctx context.Context, stations []sources.Station, buses []sources.BusRoute, weeks map[string]*sources.Week) (*GettingHome, bool) {
	gh := &GettingHome{Options: []NightOption{}}
	ok := true
	// Night Tube: the nearest station on each night line that the night service calls at.
	done := map[string]bool{}
	for _, st := range stations { // nearest first
		for _, l := range st.Lines {
			info, ok := sources.NightTubeLines[l.ID]
			if !ok || done[l.ID] {
				continue
			}
			served, err := sources.NightStations(ctx, l.ID)
			if err != nil {
				ok = false
				continue
			}
			for _, id := range st.IDs {
				if served[id] {
					done[l.ID] = true
					kind := "night_tube"
					if l.ID == "windrush" {
						kind = "night_overground"
					}
					var w sources.Week
					w[4] = &sources.NightService{PerHour: info.PerHour, Approx: true} // Friday night
					w[5] = &sources.NightService{PerHour: info.PerHour, Approx: true} // Saturday night
					gh.Options = append(gh.Options, NightOption{Kind: kind, Line: info.Name, Where: st.Name, Lat: st.Lat, Lon: st.Lon, Distance: math.Round(st.Distance/10) * 10, Nights: w})
					break
				}
			}
		}
	}
	// Buses running at least hourly between 1am and 5am count as all-night on
	// that night. Routes that only squeeze in a late trip are "last buses".
	var lasts []LastBus
	for _, r := range buses {
		w := weeks[r.ID]
		if w == nil {
			continue
		}
		var nights sources.Week
		any := false
		for i, n := range w {
			if n != nil && n.PerHour >= 1 {
				nights[i] = &sources.NightService{PerHour: n.PerHour}
				any = true
			}
		}
		if any {
			kind := "night_bus"
			if !isNightRoute(r.ID) {
				kind = "all_night_bus"
			}
			gh.Options = append(gh.Options, NightOption{Kind: kind, Line: r.Name, Where: r.StopName, Lat: r.Lat, Lon: r.Lon, Distance: math.Round(r.Distance/10) * 10, Nights: nights})
		} else if n := w[0]; n != nil && n.Last != "" { // Monday night, as a typical weeknight
			lasts = append(lasts, LastBus{Route: r.Name, Stop: r.StopName, Time: n.Last})
		}
	}
	// Latest first, treating times before 5am as after midnight.
	late := func(t string) string {
		if t < "05:00" {
			return "1" + t
		}
		return "0" + t
	}
	sort.Slice(lasts, func(i, j int) bool { return late(lasts[i].Time) > late(lasts[j].Time) })
	if len(lasts) > 3 {
		lasts = lasts[:3]
	}
	gh.LastBuses = lasts
	return gh, ok
}

func isNightRoute(id string) bool {
	return len(id) > 1 && id[0] == 'n' && id[1] >= '0' && id[1] <= '9'
}

// Getting home: what still runs at each hour.
func (b *Builder) gettingHomeSection(stations []sources.Station, gh *GettingHome, stErr, busErr error) Section {
	s := Section{ID: "getting_home", Label: "Getting home", Unit: "ways home", Measured: true}
	if stErr != nil && busErr != nil {
		s.Headline = "TfL data unavailable right now"
		return s
	}
	lines := map[string]bool{}
	for _, st := range stations {
		for _, l := range st.Lines {
			if _, ok := b.Hub.LineStatus(l.ID); ok {
				lines[l.ID] = true
			}
		}
	}
	// Night: average departures an hour across the week, from everything nearby.
	var weekPerHour float64
	var buses, tubes []string
	for _, o := range gh.Options {
		for _, n := range o.Nights {
			if n != nil {
				weekPerHour += n.PerHour / 7
			}
		}
		if o.Kind == "night_tube" || o.Kind == "night_overground" {
			tubes = append(tubes, o.Line)
		} else {
			buses = append(buses, o.Line)
		}
	}
	dayScore := clamp(15 + 22*float64(len(stations)) + 6*float64(len(lines)))
	nightScore := clamp(10 + 7*weekPerHour)
	dayValue, nightValue := float64(len(lines)), float64(len(gh.Options))
	for h := 0; h < 24; h++ {
		switch {
		case h >= 1 && h < 5: // tube and most buses stop
			s.hourValue[h], s.hourScore[h] = nightValue, nightScore
		case h == 0 || h == 5: // last and first trains
			s.hourValue[h], s.hourScore[h] = (dayValue+nightValue)/2, (dayScore+nightScore)/2
		default:
			s.hourValue[h], s.hourScore[h] = dayValue, dayScore
		}
	}
	switch len(buses) {
	case 0:
		s.Headline = "No buses after 1am within 500 m"
	case 1:
		s.Headline = fmt.Sprintf("1 all-night bus (%s) within 500 m", buses[0])
	default:
		s.Headline = fmt.Sprintf("%d all-night buses within 500 m (%s)", len(buses), joinMax(buses, 3))
	}
	if len(tubes) > 0 {
		s.Headline += fmt.Sprintf(", Night Tube on Friday and Saturday nights (%s)", strings.Join(tubes, ", "))
	}
	s.DayLine = fmt.Sprintf("%s and %s within %d m by day", plural(len(stations), "station"), plural(len(lines), "line"), RadiusM)
	return s.finish()
}

func contains(xs []string, x string) bool {
	for _, v := range xs {
		if v == x {
			return true
		}
	}
	return false
}

// Air: the nearest monitor's average by hour over the last two weeks.
func airSection(p *sources.Postcode, sites []sources.AirSite, hist *sources.AirByHour) Section {
	s := Section{ID: "air", Label: "Air", Measured: true}
	if hist == nil {
		s.Headline = "No air quality history nearby"
		return s
	}
	s.Unit = "µg/m³ " + pollutantName(hist.Pollutant)
	limit := map[string]float64{"NO2": 10, "PM25": 5, "PM10": 15}[hist.Pollutant] // WHO annual guideline
	for h := 0; h < 24; h++ {
		v := hist.Hourly[h]
		s.hourValue[h] = v
		if math.IsNaN(v) {
			s.hourScore[h] = 50
			continue
		}
		s.hourScore[h] = clamp(100 - (v/limit-1)*22)
	}
	night, day := nanAvg(hist.Hourly, nightHours), nanAvg(hist.Hourly, dayHours)
	s.Headline = fmt.Sprintf("%s averages %.0f µg/m³ overnight", pollutantName(hist.Pollutant), night)
	s.DayLine = fmt.Sprintf("%.0f µg/m³ by day", day)
	var dist float64
	for _, site := range sites {
		if site.Name == hist.Site {
			dist = live.DistanceM(p.Lat, p.Lon, site.Lat, site.Lon)
		}
	}
	s.Details = []Detail{
		{Label: "Monitor", Value: fmt.Sprintf("%s, %.1f km away", hist.Site, dist/1000)},
		{Label: "Based on", Value: fmt.Sprintf("%d days of hourly readings", hist.Days)},
		{Label: "WHO guideline", Value: fmt.Sprintf("%.0f µg/m³ (annual average)", limit)},
	}
	return s.finish()
}

func pollutantName(code string) string {
	return map[string]string{"NO2": "NO₂", "PM25": "PM2.5", "PM10": "PM10"}[code]
}

func nanAvg(v [24]float64, hours []int) float64 {
	var s, n float64
	for _, h := range hours {
		if !math.IsNaN(v[h]) {
			s += v[h]
			n++
		}
	}
	if n == 0 {
		return math.NaN()
	}
	return s / n
}

// Safety: recorded crime within a mile, spread across the day by crime type.
func safetySection(crimes []sources.Crime, err error) Section {
	s := Section{ID: "safety", Label: "Safety after dark", Unit: "crimes a month in this hour", Measured: false}
	if err != nil {
		s.Headline = "Police data unavailable right now"
		return s
	}
	n := float64(max(len(crimes), 1))
	// Log scale: ~50 crimes a month within a mile scores 95, ~4,000 scores 5.
	base := 95 - 90*(math.Log(n)-math.Log(50))/(math.Log(4000)-math.Log(50))
	share := hourShare(crimes)
	for h := 0; h < 24; h++ {
		s.hourValue[h] = float64(len(crimes)) * share[h]
		// Busier-than-average hours score lower than the area's base score.
		s.hourScore[h] = clamp(base - 30*(share[h]*24-1))
	}
	var nightShare float64
	for _, h := range nightHours {
		nightShare += share[h]
	}
	month := ""
	if len(crimes) > 0 {
		if t, err := time.Parse("2006-01", crimes[0].Month); err == nil {
			month = t.Format("January 2006")
		}
	}
	s.Headline = fmt.Sprintf("About %s of the %s crimes reported nearby in %s happened between 11pm and 6am", commas(int(math.Round(n*nightShare))), commas(len(crimes)), month)
	s.DayLine = fmt.Sprintf("About %s between 8am and 8pm", commas(int(math.Round(n*sumShare(share, dayHours)))))
	s.Note = "Estimated: police data has no times, so each crime is spread over the hours when that type usually happens."
	return s.finish()
}

func sumShare(share [24]float64, hours []int) float64 {
	var s float64
	for _, h := range hours {
		s += share[h]
	}
	return s
}

func breakdown(crimes []sources.Crime) []CategoryCount {
	counts := map[string]int{}
	for _, c := range crimes {
		counts[c.Category]++
	}
	var out []CategoryCount
	for cat, n := range counts {
		label := sources.CrimeLabels[cat]
		if label == "" {
			label = cat
		}
		out = append(out, CategoryCount{Category: cat, Label: label, Count: n})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Count > out[j].Count })
	return out
}

// Emergency: ambulance response times (London-wide) and air ambulance activity here.
func emergencySection(p history.Profile) Section {
	a := sources.LondonAmbulance()
	ratio := float64(a.Cat2MeanSec) / float64(a.Cat2TargetSec)
	base := clamp(90 - 50*(ratio-1))
	s := Section{ID: "emergency", Label: "Emergency help", Unit: "air ambulance minutes", Measured: true, Sample: a.Sample}
	for h := 0; h < 24; h++ {
		s.hourValue[h] = p.AmbulanceMin[h]
		s.hourScore[h] = base
	}
	s.Headline = fmt.Sprintf("Category 2 ambulances take %s on average (target %s)", mins(a.Cat2MeanSec), mins(a.Cat2TargetSec))
	s.DayLine = "London Ambulance Service covers all of London as one area"
	s.Details = []Detail{
		{Label: "Category 1 (life-threatening)", Value: fmt.Sprintf("%s average, target %s", mins(a.Cat1MeanSec), mins(a.Cat1TargetSec))},
		{Label: "Air ambulance nearby", Value: fmt.Sprintf("%.0f min a day", sum(p.AmbulanceMin, allHours()))},
	}
	if a.Sample {
		s.Note = "Sample response times. Replace with the latest AmbSYS figures."
	}
	return s.finish()
}

func plural(n int, word string) string {
	if n == 1 {
		return "1 " + word
	}
	return fmt.Sprintf("%d %ss", n, word)
}

func mins(sec int) string { return fmt.Sprintf("%dm %02ds", sec/60, sec%60) }

func commas(n int) string {
	s := fmt.Sprint(n)
	for i := len(s) - 3; i > 0; i -= 3 {
		s = s[:i] + "," + s[i:]
	}
	return s
}

func joinMax(xs []string, n int) string {
	if len(xs) <= n {
		return strings.Join(xs, ", ")
	}
	return strings.Join(xs[:n], ", ") + fmt.Sprintf(" +%d more", len(xs)-n)
}

func (b *Builder) tflLines(stations []sources.Station) []string {
	seen := map[string]bool{}
	var out []string
	for _, st := range stations {
		for _, l := range st.Lines {
			if _, ok := b.Hub.LineStatus(l.ID); ok && !seen[l.ID] {
				seen[l.ID] = true
				out = append(out, l.ID)
			}
		}
	}
	sort.Strings(out)
	return out
}

// Gate returns a copy of r with everything plan can't see removed.
func Gate(r *Report, plan string, f *config.Features) *Report {
	out := *r
	out.Locked = []string{}
	lock := func(feature string) bool {
		if f.Can(plan, feature) {
			return false
		}
		out.Locked = append(out.Locked, feature)
		return true
	}
	if lock(config.ReportScore) {
		out.Night, out.Day = nil, nil
	}
	noTimeline := lock(config.ReportTimeline)
	if noTimeline {
		out.Hourly = nil
	}
	if lock(config.ReportSections) {
		out.Sections = nil
	} else {
		noDetails := lock(config.ReportDetails)
		out.Sections = make([]Section, len(r.Sections))
		for i, s := range r.Sections {
			if noDetails {
				s.Details = nil
			}
			if noTimeline {
				s.Hourly = nil
			}
			out.Sections[i] = s
		}
	}
	if !f.Can(plan, config.ReportDetails) {
		out.GettingHome = nil
	}
	if lock(config.SafetyBreakdown) {
		out.Breakdown = nil
	}
	if lock(config.MapCrime) {
		out.Layers.Crime = nil
	}
	if lock(config.MapAir) {
		out.Layers.Air = nil
	}
	if lock(config.MapTransport) {
		out.Layers.Stations = nil
	}
	return &out
}
