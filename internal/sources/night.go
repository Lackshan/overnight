package sources

import (
	"context"
	"fmt"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"golang.org/x/sync/errgroup"
)

// NightTubeLines run all night on Friday and Saturday nights, on parts of
// each line. Which stations are served comes from TfL's night route data.
// TfL's API has no Tube timetables, so frequencies are TfL's published
// approximate figures, in trains an hour.
var NightTubeLines = map[string]struct {
	Name    string
	PerHour float64
}{
	"central":    {"Central", 6},
	"jubilee":    {"Jubilee", 6},
	"northern":   {"Northern", 7.5},
	"piccadilly": {"Piccadilly", 6},
	"victoria":   {"Victoria", 6},
	"windrush":   {"Windrush", 4}, // London Overground, Highbury & Islington to New Cross Gate
}

var nightStationsCache = NewCache[map[string]bool](24 * time.Hour)

// NightStations returns the station IDs (both the station's own NaPTAN ID and
// its interchange hub ID) that a line's night service calls at.
func NightStations(ctx context.Context, lineID string) (map[string]bool, error) {
	return nightStationsCache.Get(ctx, lineID, func(ctx context.Context) (map[string]bool, error) {
		var res struct {
			Sequences []struct {
				Stops []struct {
					StationID string `json:"stationId"`
					ParentID  string `json:"topMostParentId"`
				} `json:"stopPoint"`
			} `json:"stopPointSequences"`
		}
		if err := getJSON(ctx, tflURL("/Line/"+url.PathEscape(lineID)+"/Route/Sequence/all", url.Values{"serviceTypes": {"Night"}}), &res); err != nil {
			return nil, err
		}
		out := map[string]bool{}
		for _, seq := range res.Sequences {
			for _, s := range seq.Stops {
				out[s.StationID] = true
				out[s.ParentID] = true
			}
		}
		delete(out, "")
		return out, nil
	})
}

// BusRoute is a bus route with its nearest stop to a point.
type BusRoute struct {
	ID       string  `json:"id"`    // TfL line ID, e.g. "n205"
	Name     string  `json:"route"` // as shown on the bus, e.g. "N205"
	StopID   string  `json:"-"`
	StopName string  `json:"stop"`
	Lat      float64 `json:"lat"`
	Lon      float64 `json:"lon"`
	Distance float64 `json:"distance_m"`
}

var busCache = NewCache[[]BusRoute](24 * time.Hour)

// BusRoutesNear returns every bus route stopping within radius metres,
// nearest stop first.
func BusRoutesNear(ctx context.Context, lat, lon float64, radius int) ([]BusRoute, error) {
	key := fmt.Sprintf("%.4f,%.4f,%d", lat, lon, radius)
	return busCache.Get(ctx, key, func(ctx context.Context) ([]BusRoute, error) {
		var res struct {
			StopPoints []struct {
				NaptanID   string  `json:"naptanId"`
				CommonName string  `json:"commonName"`
				Indicator  string  `json:"indicator"`
				Lat        float64 `json:"lat"`
				Lon        float64 `json:"lon"`
				Distance   float64 `json:"distance"`
				Lines      []Line  `json:"lines"`
			} `json:"stopPoints"`
		}
		q := url.Values{
			"lat": {fmt.Sprint(lat)}, "lon": {fmt.Sprint(lon)}, "radius": {fmt.Sprint(radius)},
			"stopTypes": {"NaptanPublicBusCoachTram"}, "modes": {"bus"},
		}
		if err := getJSON(ctx, tflURL("/StopPoint", q), &res); err != nil {
			return nil, err
		}
		best := map[string]BusRoute{}
		for _, sp := range res.StopPoints {
			name := sp.CommonName
			if ind := strings.TrimPrefix(sp.Indicator, "Stop "); ind != "" && len(ind) <= 3 {
				name += " (stop " + ind + ")"
			}
			for _, l := range sp.Lines {
				if b, ok := best[l.ID]; !ok || sp.Distance < b.Distance {
					best[l.ID] = BusRoute{ID: l.ID, Name: strings.ToUpper(l.Name), StopID: sp.NaptanID, StopName: name, Lat: sp.Lat, Lon: sp.Lon, Distance: sp.Distance}
				}
			}
		}
		out := make([]BusRoute, 0, len(best))
		for _, b := range best {
			out = append(out, b)
		}
		sort.Slice(out, func(i, j int) bool { return out[i].Distance < out[j].Distance })
		return out, nil
	})
}

// NightService describes one night (evening into the next morning).
type NightService struct {
	PerHour float64 `json:"per_hour"`       // departures an hour between 1am and 5am; 0 if none
	Last    string  `json:"last,omitempty"` // latest departure between 10pm and 5am
	Approx  bool    `json:"approx,omitempty"`
}

// Week is a service for each night, Monday night first. Nil means no
// service after 10pm that night.
type Week [7]*NightService

var timetableCache = NewCache[*Week](24 * time.Hour)

// BusNights reads a route's timetable at a stop and summarises each night.
func BusNights(ctx context.Context, routeID, stopID string) (*Week, error) {
	return timetableCache.Get(ctx, routeID+"@"+stopID, func(ctx context.Context) (*Week, error) {
		var res struct {
			Timetable struct {
				Routes []struct {
					Schedules []struct {
						Name     string `json:"name"`
						Journeys []struct {
							Hour   string `json:"hour"`
							Minute string `json:"minute"`
						} `json:"knownJourneys"`
					} `json:"schedules"`
				} `json:"routes"`
			} `json:"timetable"`
		}
		if err := getJSON(ctx, tflURL("/Line/"+url.PathEscape(routeID)+"/Timetable/"+url.PathEscape(stopID), nil), &res); err != nil {
			return nil, err
		}
		var week Week
		if len(res.Timetable.Routes) == 0 {
			return &week, nil
		}
		for _, sch := range res.Timetable.Routes[0].Schedules {
			nights := nightsOf(sch.Name)
			if len(nights) == 0 {
				continue
			}
			// TfL writes times after midnight as 24, 25, ... so a night runs
			// from 22:00 to 29:00 (5am). Day timetables starting near 5am
			// write early-morning trips as 0–4; those belong to the night before.
			var late, small int // departures 1am–5am, and the last one from 10pm
			lastMin := -1
			for _, j := range sch.Journeys {
				h, _ := strconv.Atoi(j.Hour)
				m, _ := strconv.Atoi(j.Minute)
				t := h*60 + m
				if h < 5 && !strings.Contains(strings.ToLower(sch.Name), "night") {
					continue // a day timetable's early trips; skip rather than guess
				}
				if h < 5 {
					t += 24 * 60
				}
				if t >= 25*60 && t < 29*60 {
					late++
				}
				if t >= 22*60 && t < 29*60 {
					small++
					if t > lastMin {
						lastMin = t
					}
				}
			}
			if small == 0 {
				continue
			}
			ns := &NightService{PerHour: float64(late) / 4, Last: fmt.Sprintf("%02d:%02d", (lastMin/60)%24, lastMin%60)}
			for _, n := range nights {
				// Several schedules can cover one night; keep the busier one.
				if week[n] == nil || ns.PerHour > week[n].PerHour {
					week[n] = ns
				}
			}
		}
		return &week, nil
	})
}

var dayNames = []struct {
	re  *regexp.Regexp
	day int
}{
	{regexp.MustCompile(`\bmo(n(day)?)?\b`), 0}, {regexp.MustCompile(`\btu(e(s(day)?)?)?\b`), 1},
	{regexp.MustCompile(`\bwe(d(nesday)?)?\b`), 2}, {regexp.MustCompile(`\bth(u(r(s(day)?)?)?)?\b`), 3},
	{regexp.MustCompile(`\bfr(i(day)?)?\b`), 4}, {regexp.MustCompile(`\bsa(t(urday)?)?\b`), 5},
	{regexp.MustCompile(`\bsu(n(day)?)?\b`), 6},
}

// nightsOf works out which nights a TfL schedule name covers, e.g.
// "Mo-Th Nights/Tu-Fr Morning" is Monday to Thursday nights, "Friday Night/
// Saturday Morning" is Friday night, "Monday to Friday" is Monday to Friday.
func nightsOf(name string) []int {
	s := strings.ToLower(name)
	if i := strings.Index(s, "/"); i >= 0 {
		s = s[:i] // "x night/y morning": the night is x
	}
	s = strings.NewReplacer(" to ", "-", " - ", "-", "–", "-", ",", " ", "&", " ").Replace(s)
	var found []int
	for _, part := range strings.Fields(strings.ReplaceAll(s, "-", " - ")) {
		if part == "-" {
			found = append(found, -1)
			continue
		}
		for _, d := range dayNames {
			if d.re.MatchString(part) {
				found = append(found, d.day)
				break
			}
		}
	}
	var out []int
	for i := 0; i < len(found); i++ {
		if found[i] == -1 {
			continue
		}
		if i+2 < len(found) && found[i+1] == -1 && found[i+2] >= 0 {
			for d := found[i]; ; d = (d + 1) % 7 {
				out = append(out, d)
				if d == found[i+2] {
					break
				}
			}
			i += 2
			continue
		}
		out = append(out, found[i])
	}
	return out
}

// BusWeeks fetches timetables for every night route (N…) and the nearest
// `regular` other routes, in parallel. complete is false if any failed (TfL
// rate-limits hard without an app key).
func BusWeeks(ctx context.Context, routes []BusRoute, regular int) (weeks map[string]*Week, complete bool) {
	var pick []BusRoute
	for _, r := range routes { // nearest first
		if len(r.ID) > 1 && r.ID[0] == 'n' && r.ID[1] >= '0' && r.ID[1] <= '9' {
			pick = append(pick, r)
		} else if regular > 0 {
			pick = append(pick, r)
			regular--
		}
	}
	results := make([]*Week, len(pick))
	g, gctx := errgroup.WithContext(ctx)
	g.SetLimit(4)
	for i, r := range pick {
		g.Go(func() error {
			if w, err := BusNights(gctx, r.ID, r.StopID); err == nil {
				results[i] = w
			}
			return nil
		})
	}
	g.Wait()
	weeks = make(map[string]*Week, len(pick))
	complete = true
	for i, r := range pick {
		if results[i] != nil {
			weeks[r.ID] = results[i]
		} else {
			complete = false
		}
	}
	return weeks, complete
}
