package sources

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"sort"
	"time"
)

type Station struct {
	ID       string   `json:"id"`
	Name     string   `json:"name"`
	Lat      float64  `json:"lat"`
	Lon      float64  `json:"lon"`
	Distance float64  `json:"distance_m"`
	Modes    []string `json:"modes"`
	Lines    []Line   `json:"lines"`
}

type Line struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type LineStatus struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Mode     string `json:"mode"`
	Severity int    `json:"severity"` // 10 = good service
	Status   string `json:"status"`
	Reason   string `json:"reason,omitempty"`
}

func tflURL(path string, q url.Values) string {
	if q == nil {
		q = url.Values{}
	}
	if key := os.Getenv("TFL_APP_KEY"); key != "" {
		q.Set("app_key", key)
	}
	return "https://api.tfl.gov.uk" + path + "?" + q.Encode()
}

var stationCache = NewCache[[]Station](24 * time.Hour)

// tflModes are the TfL-run modes we score transport on. National Rail lines
// like c2c show up at shared stations but have no TfL status.
var tflModes = map[string]bool{"tube": true, "overground": true, "dlr": true, "elizabeth-line": true, "tram": true}

// StationsNear returns tube, rail, DLR and Overground stations within radius metres.
func StationsNear(ctx context.Context, lat, lon float64, radius int) ([]Station, error) {
	key := fmt.Sprintf("%.4f,%.4f,%d", lat, lon, radius)
	return stationCache.Get(ctx, key, func(ctx context.Context) ([]Station, error) {
		var res struct {
			StopPoints []struct {
				NaptanID   string   `json:"naptanId"`
				HubCode    string   `json:"hubNaptanCode"`
				CommonName string   `json:"commonName"`
				Lat        float64  `json:"lat"`
				Lon        float64  `json:"lon"`
				Distance   float64  `json:"distance"`
				Modes      []string `json:"modes"`
				Lines      []Line   `json:"lines"`
			} `json:"stopPoints"`
		}
		q := url.Values{
			"lat": {fmt.Sprint(lat)}, "lon": {fmt.Sprint(lon)}, "radius": {fmt.Sprint(radius)},
			"stopTypes": {"NaptanMetroStation,NaptanRailStation"},
		}
		if err := getJSON(ctx, tflURL("/StopPoint", q), &res); err != nil {
			return nil, err
		}
		// The same interchange shows up once per stop type; merge by hub.
		byKey := map[string]*Station{}
		var order []string
		for _, sp := range res.StopPoints {
			k := sp.HubCode
			if k == "" {
				k = sp.NaptanID
			}
			s, ok := byKey[k]
			if !ok {
				s = &Station{ID: k, Name: trimStationName(sp.CommonName), Lat: sp.Lat, Lon: sp.Lon, Distance: sp.Distance}
				byKey[k] = s
				order = append(order, k)
			}
			for _, m := range sp.Modes {
				if tflModes[m] && !contains(s.Modes, m) {
					s.Modes = append(s.Modes, m)
				}
			}
			for _, l := range sp.Lines {
				if !containsLine(s.Lines, l.ID) {
					s.Lines = append(s.Lines, l)
				}
			}
			if sp.Distance < s.Distance {
				s.Distance = sp.Distance
			}
		}
		out := make([]Station, 0, len(order))
		for _, k := range order {
			if len(byKey[k].Modes) > 0 {
				out = append(out, *byKey[k])
			}
		}
		sort.Slice(out, func(i, j int) bool { return out[i].Distance < out[j].Distance })
		return out, nil
	})
}

// LineStatuses returns the current status of every TfL rail-type line.
func LineStatuses(ctx context.Context) ([]LineStatus, error) {
	var res []struct {
		ID           string `json:"id"`
		Name         string `json:"name"`
		ModeName     string `json:"modeName"`
		LineStatuses []struct {
			Severity    int    `json:"statusSeverity"`
			Description string `json:"statusSeverityDescription"`
			Reason      string `json:"reason"`
		} `json:"lineStatuses"`
	}
	if err := getJSON(ctx, tflURL("/Line/Mode/tube,overground,dlr,elizabeth-line,tram/Status", nil), &res); err != nil {
		return nil, err
	}
	out := make([]LineStatus, 0, len(res))
	for _, l := range res {
		s := LineStatus{ID: l.ID, Name: l.Name, Mode: l.ModeName, Severity: 10, Status: "Good Service"}
		// A line can have several statuses (e.g. part closure + minor delays); keep the worst.
		for i, st := range l.LineStatuses {
			if i == 0 || st.Severity < s.Severity {
				s.Severity, s.Status, s.Reason = st.Severity, st.Description, st.Reason
			}
		}
		out = append(out, s)
	}
	return out, nil
}

func trimStationName(n string) string {
	for _, suf := range []string{" Underground Station", " Rail Station", " DLR Station", " (London)"} {
		if len(n) > len(suf) && n[len(n)-len(suf):] == suf {
			n = n[:len(n)-len(suf)]
		}
	}
	return n
}

func contains(xs []string, x string) bool {
	for _, v := range xs {
		if v == x {
			return true
		}
	}
	return false
}

func containsLine(ls []Line, id string) bool {
	for _, l := range ls {
		if l.ID == id {
			return true
		}
	}
	return false
}
