package sources

import (
	"context"
	_ "embed"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"time"
)

// AmbulanceStats are London Ambulance Service response times from NHS
// England's Ambulance Quality Indicators (AmbSYS), published monthly. London
// is a single service area, so every London postcode gets the same numbers.
type AmbulanceStats struct {
	Service string `json:"service"`
	Period  string `json:"period"` // e.g. "September 2026"
	Source  string `json:"source"`
	Live    bool   `json:"live"` // false: the built-in fallback figures
	// Category 1 is life-threatening (cardiac arrest); category 2 is
	// emergencies such as strokes and chest pain.
	Cat1MeanSec    int `json:"cat1_mean_sec"`
	Cat1P90Sec     int `json:"cat1_p90_sec"`
	Cat2MeanSec    int `json:"cat2_mean_sec"`
	Cat2P90Sec     int `json:"cat2_p90_sec"`
	EngCat1MeanSec int `json:"england_cat1_mean_sec"`
	EngCat2MeanSec int `json:"england_cat2_mean_sec"`
	// National standards: category 1 mean 7 minutes, category 2 mean 18 minutes.
	Cat1TargetSec int `json:"cat1_target_sec"`
	Cat2TargetSec int `json:"cat2_target_sec"`
}

const aqiPage = "https://www.england.nhs.uk/statistics/statistical-work-areas/ambulance-quality-indicators/"

var ambsysLink = regexp.MustCompile(`https://www\.england\.nhs\.uk/statistics/wp-content/uploads/sites/2/\d{4}/\d{2}/AmbSYS-to-[A-Za-z]{3}-\d{4}[^"'\s]*\.csv`)

//go:embed ambulance.json
var ambulanceJSON []byte

var ambulanceCache = NewCache[AmbulanceStats](24 * time.Hour)

// LondonAmbulance returns the latest published London figures, or the
// built-in ones if NHS England can't be reached.
func LondonAmbulance(ctx context.Context) AmbulanceStats {
	s, err := ambulanceCache.Get(ctx, "london", fetchAmbSYS)
	if err != nil {
		var fallback AmbulanceStats
		if err := json.Unmarshal(ambulanceJSON, &fallback); err != nil {
			panic("ambulance.json: " + err.Error())
		}
		return fallback
	}
	return s
}

func fetchAmbSYS(ctx context.Context) (AmbulanceStats, error) {
	var s AmbulanceStats
	page, err := getText(ctx, aqiPage, 4<<20)
	if err != nil {
		return s, err
	}
	link := ambsysLink.FindString(page)
	if link == "" {
		return s, fmt.Errorf("no AmbSYS CSV link on %s", aqiPage)
	}
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, link, nil)
	req.Header.Set("User-Agent", "overnight/0.1")
	res, err := client.Do(req)
	if err != nil {
		return s, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return s, fmt.Errorf("%s: %s", link, res.Status)
	}
	r := csv.NewReader(io.LimitReader(res.Body, 32<<20))
	r.FieldsPerRecord = -1
	header, err := r.Read()
	if err != nil {
		return s, err
	}
	col := map[string]int{}
	for i, h := range header {
		col[stripBOM(h)] = i
	}
	type row struct {
		ym     int
		values map[string]int
	}
	latest := map[string]row{} // org code -> most recent month
	for {
		rec, err := r.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			return s, err
		}
		org := field(rec, col, "Org Code")
		if org != "RRU" && org != "Eng" {
			continue
		}
		y, _ := strconv.Atoi(field(rec, col, "Year"))
		m, _ := strconv.Atoi(field(rec, col, "Month"))
		vals := map[string]int{}
		for _, k := range []string{"A25", "A26", "A31", "A32"} {
			vals[k], _ = strconv.Atoi(field(rec, col, k))
		}
		if vals["A25"] == 0 || vals["A31"] == 0 {
			continue // month not yet reported
		}
		if prev, ok := latest[org]; !ok || y*100+m > prev.ym {
			latest[org] = row{ym: y*100 + m, values: vals}
		}
	}
	lon, ok := latest["RRU"]
	if !ok {
		return s, fmt.Errorf("no London Ambulance Service rows in %s", link)
	}
	eng := latest["Eng"]
	period := time.Date(lon.ym/100, time.Month(lon.ym%100), 1, 0, 0, 0, 0, time.UTC).Format("January 2006")
	return AmbulanceStats{
		Service: "London Ambulance Service", Period: period, Source: link, Live: true,
		Cat1MeanSec: lon.values["A25"], Cat1P90Sec: lon.values["A26"],
		Cat2MeanSec: lon.values["A31"], Cat2P90Sec: lon.values["A32"],
		EngCat1MeanSec: eng.values["A25"], EngCat2MeanSec: eng.values["A31"],
		Cat1TargetSec: 420, Cat2TargetSec: 1080,
	}, nil
}

func field(rec []string, col map[string]int, name string) string {
	if i, ok := col[name]; ok && i < len(rec) {
		return rec[i]
	}
	return ""
}

func stripBOM(s string) string {
	if len(s) >= 3 && s[:3] == "\xef\xbb\xbf" {
		return s[3:]
	}
	return s
}

func getText(ctx context.Context, url string, limit int64) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", "overnight/0.1")
	res, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return "", &StatusError{Code: res.StatusCode, URL: url}
	}
	b, err := io.ReadAll(io.LimitReader(res.Body, limit))
	return string(b), err
}
