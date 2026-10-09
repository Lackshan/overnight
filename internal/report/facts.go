package report

import (
	"fmt"
	"math"
	"strings"

	"overnight/internal/history"
	"overnight/internal/sources"
)

// Fact is one comparable number about a postcode, for side-by-side comparison.
type Fact struct {
	ID        string  `json:"id"`
	Label     string  `json:"label"`
	Value     string  `json:"value"`  // ready to show, e.g. "38 a night"
	Num       float64 `json:"num"`    // for finding the best; NaN-free
	Better    string  `json:"better"` // "lower" or "higher"
	Estimated bool    `json:"estimated,omitempty"`
	Known     bool    `json:"known"` // false when the data isn't available
}

// facts gathers the headline numbers each section is scored on.
func facts(p *sources.Postcode, prof history.Profile, gh *GettingHome, air *sources.AirByHour, crimes []sources.Crime, med *Medical, days int) []Fact {
	var out []Fact
	add := func(f Fact) { out = append(out, f) }

	night, low, police := sum(prof.Passes, nightHours), sum(prof.Low, nightHours), sum(prof.PoliceMin, nightHours)
	add(Fact{ID: "night_flights", Label: "Flights overhead, 11pm–6am", Value: fmt.Sprintf("%.0f a night", night), Num: night, Better: "lower", Known: days > 0})
	add(Fact{ID: "low_flights", Label: "…of them below 4,000 ft", Value: fmt.Sprintf("%.0f", low), Num: low, Better: "lower", Known: days > 0})
	add(Fact{ID: "police_min", Label: "Police helicopter overhead at night", Value: fmt.Sprintf("%.0f min", police), Num: police, Better: "lower", Known: days > 0})

	buses, tubes := 0, []string{}
	if gh != nil {
		for _, o := range gh.Options {
			if o.Kind == "night_tube" || o.Kind == "night_overground" {
				tubes = append(tubes, o.Line)
			} else {
				buses++
			}
		}
	}
	add(Fact{ID: "night_buses", Label: "All-night buses within 500 m", Value: fmt.Sprint(buses), Num: float64(buses), Better: "higher", Known: gh != nil})
	tube := "None"
	if len(tubes) > 0 {
		tube = strings.Join(tubes, ", ") + " (Fri, Sat)"
	}
	add(Fact{ID: "night_tube", Label: "Night Tube nearby", Value: tube, Num: float64(len(tubes)), Better: "higher", Known: gh != nil})

	if air != nil {
		if v := nanAvg(air.Hourly, nightHours); !math.IsNaN(v) {
			add(Fact{ID: "no2_night", Label: pollutantName(air.Pollutant) + " overnight", Value: fmt.Sprintf("%.0f µg/m³", v), Num: v, Better: "lower", Known: true})
		}
	}
	if len(crimes) > 0 {
		share := hourShare(crimes)
		var ns float64
		for _, h := range nightHours {
			ns += share[h]
		}
		v := float64(len(crimes)) * ns
		add(Fact{ID: "crime_night", Label: "Crimes after dark nearby (a month)", Value: commas(int(math.Round(v))), Num: v, Better: "lower", Estimated: true, Known: true})
	}
	if f, _, _ := sources.Fire(p.WardCode, p.Borough); f.NightMeanSec > 0 {
		add(Fact{ID: "fire_night", Label: "First fire engine at night", Value: mins(f.NightMeanSec), Num: float64(f.NightMeanSec), Better: "lower", Known: true})
	}
	if med != nil {
		best, name := math.Inf(1), ""
		for _, u := range med.UTCs {
			if u.Hours.Open24 && u.Distance < best {
				best, name = u.Distance, u.Site+" UTC"
			}
		}
		if len(med.AE) > 0 && med.AE[0].Distance < best {
			best, name = med.AE[0].Distance, med.AE[0].Name+" A&E"
		}
		if !math.IsInf(best, 1) {
			add(Fact{ID: "care_24h", Label: "Nearest 24-hour care", Value: fmt.Sprintf("%s · %s", km(best), name), Num: best, Better: "lower", Known: true})
		}
		add(Fact{ID: "gps_1km", Label: "GP surgeries within 1 km", Value: fmt.Sprint(med.GPsWithin), Num: float64(med.GPsWithin), Better: "higher", Known: true})
	}
	return out
}
