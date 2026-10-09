// Command firedata turns London Fire Brigade incident records (London
// Datastore) into first-engine arrival times per ward, by day and night,
// and writes internal/sources/lfb_wards.json, which is embedded in the API.
//
// Download "LFB Incident data from 2024 onwards.xlsx" from
// https://data.london.gov.uk/dataset/london-fire-brigade-incident-records, then:
//
//	go run ./cmd/firedata -inspect incidents.xlsx   # print the columns
//	go run ./cmd/firedata incidents.xlsx
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"math"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/xuri/excelize/v2"
)

type acc struct {
	times      []float64 // first-engine arrival, seconds
	night, day []float64
	nightFires int
	first      time.Time
	last       time.Time
}

func (a *acc) add(hour int, secs float64, fire bool, date time.Time) {
	a.times = append(a.times, secs)
	switch {
	case hour >= 23 || hour < 6:
		a.night = append(a.night, secs)
		if fire {
			a.nightFires++
		}
	case hour >= 8 && hour < 20:
		a.day = append(a.day, secs)
	}
	if !date.IsZero() {
		if a.first.IsZero() || date.Before(a.first) {
			a.first = date
		}
		if date.After(a.last) {
			a.last = date
		}
	}
}

// Stats is what the API reads for one area.
type Stats struct {
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

type Output struct {
	Source  string           `json:"source"`
	Period  string           `json:"period"`
	London  Stats            `json:"london"`
	Hourly  [24]int          `json:"hourly_mean_sec"` // London-wide, by hour of call
	Borough map[string]Stats `json:"boroughs"`        // keyed by borough code
	Wards   map[string]Stats `json:"wards"`           // keyed by ward code
}

func mean(xs []float64) int {
	if len(xs) == 0 {
		return 0
	}
	var s float64
	for _, x := range xs {
		s += x
	}
	return int(math.Round(s / float64(len(xs))))
}

func p90(xs []float64) int {
	if len(xs) == 0 {
		return 0
	}
	s := append([]float64(nil), xs...)
	sort.Float64s(s)
	return int(s[int(float64(len(s)-1)*0.9)])
}

func (a *acc) stats(name, borough string, years float64) Stats {
	return Stats{
		Name: name, Borough: borough, Incidents: len(a.times),
		MeanSec: mean(a.times), P90Sec: p90(a.times),
		NightMeanSec: mean(a.night), NightIncidents: len(a.night), DayMeanSec: mean(a.day),
		NightFiresYear: math.Round(float64(a.nightFires)/years*10) / 10,
	}
}

func main() {
	inspect := flag.Bool("inspect", false, "print the header and first rows, then stop")
	out := flag.String("out", "internal/sources/lfb_wards.json", "output file")
	flag.Parse()
	if flag.NArg() != 1 {
		log.Fatal("usage: firedata [-inspect] incidents.xlsx")
	}
	f, err := excelize.OpenFile(flag.Arg(0))
	if err != nil {
		log.Fatal(err)
	}
	defer f.Close()
	rows, err := f.Rows(f.GetSheetList()[0])
	if err != nil {
		log.Fatal(err)
	}
	defer rows.Close()

	var col map[string]int
	london := &acc{}
	var hourly [24]acc
	wards, boroughs := map[string]*acc{}, map[string]*acc{}
	wardName, wardBorough, boroughName := map[string]string{}, map[string]string{}, map[string]string{}
	n, skipped := 0, 0
	for rows.Next() {
		cells, err := rows.Columns()
		if err != nil {
			log.Fatal(err)
		}
		if col == nil {
			col = map[string]int{}
			for i, c := range cells {
				col[c] = i
			}
			for _, need := range []string{"HourOfCall", "DateOfCall", "IncidentGroup", "IncGeo_WardCode", "IncGeo_WardName", "IncGeo_BoroughCode", "ProperCase", "FirstPumpArriving_AttendanceTime"} {
				if _, ok := col[need]; !ok {
					log.Fatalf("column %q missing; run with -inspect", need)
				}
			}
			continue
		}
		if *inspect {
			fmt.Printf("%q\n", cells)
			if n == 3 {
				return
			}
			n++
			continue
		}
		get := func(name string) string {
			if i := col[name]; i < len(cells) {
				return strings.TrimSpace(cells[i])
			}
			return ""
		}
		secs, err1 := strconv.ParseFloat(get("FirstPumpArriving_AttendanceTime"), 64)
		hour, err2 := strconv.Atoi(get("HourOfCall"))
		ward, borough := get("IncGeo_WardCode"), get("IncGeo_BoroughCode")
		// No engine sent, or a nonsense time: skip.
		if err1 != nil || err2 != nil || secs <= 0 || secs > 3600 || hour < 0 || hour > 23 || !strings.HasPrefix(ward, "E05") {
			skipped++
			continue
		}
		date, _ := time.Parse("2-Jan-06", get("DateOfCall"))
		fire := get("IncidentGroup") == "Fire"
		london.add(hour, secs, fire, date)
		hourly[hour].add(hour, secs, fire, date)
		for _, m := range []struct {
			set  map[string]*acc
			code string
		}{{wards, ward}, {boroughs, borough}} {
			a := m.set[m.code]
			if a == nil {
				a = &acc{}
				m.set[m.code] = a
			}
			a.add(hour, secs, fire, date)
		}
		wardName[ward] = titleCase(get("IncGeo_WardName"))
		wardBorough[ward] = get("ProperCase")
		boroughName[borough] = get("ProperCase")
		n++
		if n%100000 == 0 {
			log.Printf("%d incidents", n)
		}
	}
	if *inspect {
		return
	}
	years := london.last.Sub(london.first).Hours() / 24 / 365.25
	o := Output{
		Source:  "London Fire Brigade incident records, London Datastore",
		Period:  london.first.Format("Jan 2006") + " to " + london.last.Format("Jan 2006"),
		London:  london.stats("London", "", years),
		Borough: map[string]Stats{},
		Wards:   map[string]Stats{},
	}
	for h := range hourly {
		o.Hourly[h] = mean(hourly[h].times)
	}
	for code, a := range boroughs {
		o.Borough[code] = a.stats(boroughName[code], "", years)
	}
	for code, a := range wards {
		o.Wards[code] = a.stats(wardName[code], wardBorough[code], years)
	}
	data, err := json.Marshal(o)
	if err != nil {
		log.Fatal(err)
	}
	if err := os.WriteFile(*out, data, 0o644); err != nil {
		log.Fatal(err)
	}
	log.Printf("%d incidents with a first engine (%d skipped), %d wards, %s: wrote %s (%d KB)",
		n, skipped, len(o.Wards), o.Period, *out, len(data)/1024)
}

// "CANN HALL" -> "Cann Hall"; keeps "&" and short words sensible.
func titleCase(s string) string {
	words := strings.Fields(strings.ToLower(s))
	for i, w := range words {
		if (w == "and" || w == "of" || w == "the" || w == "on") && i > 0 {
			continue
		}
		words[i] = strings.ToUpper(w[:1]) + w[1:]
	}
	return strings.Join(words, " ")
}
