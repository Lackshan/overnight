package sources

import (
	_ "embed"
	"encoding/json"
	"math"
	"sort"
)

// FireStats are London Fire Brigade first-engine arrival times for an area,
// built from incident records by cmd/firedata.
type FireStats struct {
	Name           string  `json:"name"`
	Borough        string  `json:"borough,omitempty"`
	Incidents      int     `json:"incidents"`
	MeanSec        int     `json:"mean_sec"`
	P90Sec         int     `json:"p90_sec"`
	NightMeanSec   int     `json:"night_mean_sec"`
	NightIncidents int     `json:"night_incidents"`
	DayMeanSec     int     `json:"day_mean_sec"`
	NightFiresYear float64 `json:"night_fires_per_year"`
}

type FireData struct {
	Source  string               `json:"source"`
	Period  string               `json:"period"`
	London  FireStats            `json:"london"`
	Hourly  [24]int              `json:"hourly_mean_sec"`
	Borough map[string]FireStats `json:"boroughs"`
	Wards   map[string]FireStats `json:"wards"`
}

//go:embed lfb_wards.json
var fireJSON []byte

var fire = func() *FireData {
	var d FireData
	if err := json.Unmarshal(fireJSON, &d); err != nil {
		panic("lfb_wards.json: " + err.Error())
	}
	return &d
}()

// Fire returns the stats for a ward, falling back to its borough when the
// ward has too few night incidents to average. area says which was used.
func Fire(wardCode, boroughCode string) (s FireStats, area string, d *FireData) {
	if w, ok := fire.Wards[wardCode]; ok && w.NightIncidents >= 30 {
		return w, "ward", fire
	}
	if b, ok := fire.Borough[boroughCode]; ok {
		return b, "borough", fire
	}
	return fire.London, "london", fire
}

// Hospital is a 24-hour (type 1) emergency department.
type Hospital struct {
	Name     string  `json:"name"`
	Postcode string  `json:"postcode"`
	Lat      float64 `json:"lat"`
	Lon      float64 `json:"lon"`
	Distance float64 `json:"distance_m,omitempty"`
}

//go:embed hospitals.json
var hospitalsJSON []byte

var hospitals = func() []Hospital {
	var d struct {
		Hospitals []Hospital `json:"hospitals"`
	}
	if err := json.Unmarshal(hospitalsJSON, &d); err != nil {
		panic("hospitals.json: " + err.Error())
	}
	return d.Hospitals
}()

// NearestAE returns the n closest 24-hour emergency departments, as the crow flies.
func NearestAE(lat, lon float64, n int) []Hospital {
	out := make([]Hospital, len(hospitals))
	for i, h := range hospitals {
		h.Distance = math.Round(haversine(lat, lon, h.Lat, h.Lon)/10) * 10
		out[i] = h
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Distance < out[j].Distance })
	if len(out) > n {
		out = out[:n]
	}
	return out
}

func haversine(lat1, lon1, lat2, lon2 float64) float64 {
	const r = 6371000
	p1, p2 := lat1*math.Pi/180, lat2*math.Pi/180
	dp, dl := (lat2-lat1)*math.Pi/180, (lon2-lon1)*math.Pi/180
	a := math.Sin(dp/2)*math.Sin(dp/2) + math.Cos(p1)*math.Cos(p2)*math.Sin(dl/2)*math.Sin(dl/2)
	return 2 * r * math.Asin(math.Sqrt(a))
}
