package sources

import (
	"context"
	"fmt"
	"net/url"
	"sort"
	"strings"
	"time"
)

// NightTubeLines run all night on Fridays and Saturdays (on most of each line).
var NightTubeLines = map[string]string{
	"central":    "Central",
	"jubilee":    "Jubilee",
	"northern":   "Northern",
	"piccadilly": "Piccadilly",
	"victoria":   "Victoria",
	"windrush":   "Windrush", // London Overground, Highbury & Islington to New Cross Gate
}

type NightBus struct {
	Route    string  `json:"route"`
	StopName string  `json:"stop"`
	Distance float64 `json:"distance_m"`
}

var busCache = NewCache[[]NightBus](24 * time.Hour)

// NightBusesNear returns night bus routes (N-prefixed) stopping within radius
// metres, each with its nearest stop.
func NightBusesNear(ctx context.Context, lat, lon float64, radius int) ([]NightBus, error) {
	key := fmt.Sprintf("%.4f,%.4f,%d", lat, lon, radius)
	return busCache.Get(ctx, key, func(ctx context.Context) ([]NightBus, error) {
		var res struct {
			StopPoints []struct {
				CommonName string  `json:"commonName"`
				Indicator  string  `json:"indicator"`
				Distance   float64 `json:"distance"`
				Lines      []Line  `json:"lines"`
			} `json:"stopPoints"`
		}
		q := url.Values{
			"lat": {fmt.Sprint(lat)}, "lon": {fmt.Sprint(lon)}, "radius": {fmt.Sprint(radius)},
			"stopTypes": {"NaptanPublicBusCoachTram"},
		}
		if err := getJSON(ctx, tflURL("/StopPoint", q), &res); err != nil {
			return nil, err
		}
		best := map[string]NightBus{}
		for _, sp := range res.StopPoints {
			for _, l := range sp.Lines {
				if !strings.HasPrefix(l.ID, "n") || len(l.ID) < 2 || l.ID[1] < '0' || l.ID[1] > '9' {
					continue
				}
				if b, ok := best[l.ID]; !ok || sp.Distance < b.Distance {
					best[l.ID] = NightBus{Route: strings.ToUpper(l.Name), StopName: sp.CommonName, Distance: sp.Distance}
				}
			}
		}
		out := make([]NightBus, 0, len(best))
		for _, b := range best {
			out = append(out, b)
		}
		sort.Slice(out, func(i, j int) bool { return out[i].Distance < out[j].Distance })
		return out, nil
	})
}
