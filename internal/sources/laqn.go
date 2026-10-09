package sources

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"time"
)

// AirSite is one London Air Quality Network monitor with a current reading.
type AirSite struct {
	Code      string  `json:"code"`
	Name      string  `json:"name"`
	Type      string  `json:"type"`
	Lat       float64 `json:"lat"`
	Lon       float64 `json:"lon"`
	Index     int     `json:"index"` // UK Daily Air Quality Index, 1 (low) to 10 (very high)
	Band      string  `json:"band"`
	Pollutant string  `json:"pollutant"` // the species driving the index
	Updated   string  `json:"updated"`
}

// LAQN publishes hourly; it says TTL 16 minutes.
var airCache = NewCache[[]AirSite](15 * time.Minute)

// AirSites returns every London monitor that has a current reading.
func AirSites(ctx context.Context) ([]AirSite, error) {
	return airCache.Get(ctx, "london", func(ctx context.Context) ([]AirSite, error) {
		var res struct {
			Index struct {
				LocalAuthority oneOrMany[laqnAuthority] `json:"LocalAuthority"`
			} `json:"HourlyAirQualityIndex"`
		}
		if err := getJSON(ctx, "https://api.erg.ic.ac.uk/AirQuality/Hourly/MonitoringIndex/GroupName=London/Json", &res); err != nil {
			return nil, err
		}
		var out []AirSite
		for _, la := range res.Index.LocalAuthority {
			for _, s := range la.Site {
				lat, err1 := strconv.ParseFloat(s.Lat, 64)
				lon, err2 := strconv.ParseFloat(s.Lon, 64)
				if err1 != nil || err2 != nil {
					continue
				}
				site := AirSite{Code: s.Code, Name: s.Name, Type: s.Type, Lat: lat, Lon: lon, Updated: s.Date}
				for _, sp := range s.Species {
					idx, _ := strconv.Atoi(sp.Index)
					if sp.Band == "No data" || idx == 0 {
						continue
					}
					if idx > site.Index {
						site.Index, site.Band, site.Pollutant = idx, sp.Band, sp.Code
					}
				}
				if site.Index > 0 {
					out = append(out, site)
				}
			}
		}
		return out, nil
	})
}

type laqnAuthority struct {
	Site oneOrMany[laqnSite] `json:"Site"`
}

type laqnSite struct {
	Code    string                 `json:"@SiteCode"`
	Name    string                 `json:"@SiteName"`
	Type    string                 `json:"@SiteType"`
	Lat     string                 `json:"@Latitude"`
	Lon     string                 `json:"@Longitude"`
	Date    string                 `json:"@BulletinDate"`
	Species oneOrMany[laqnSpecies] `json:"Species"`
}

type laqnSpecies struct {
	Code  string `json:"@SpeciesCode"`
	Index string `json:"@AirQualityIndex"`
	Band  string `json:"@AirQualityBand"`
}

// oneOrMany handles LAQN's XML-to-JSON quirk where a list with one item is
// sent as a bare object.
type oneOrMany[T any] []T

func (o *oneOrMany[T]) UnmarshalJSON(b []byte) error {
	if len(b) > 0 && b[0] == '[' {
		return json.Unmarshal(b, (*[]T)(o))
	}
	if string(b) == "null" {
		return nil
	}
	var one T
	if err := json.Unmarshal(b, &one); err != nil {
		return err
	}
	*o = []T{one}
	return nil
}

// AirByHour is the average concentration at one monitor for each local hour
// of the day over the last two weeks. NaN where there's no data.
type AirByHour struct {
	Site      string      `json:"site"`
	Pollutant string      `json:"pollutant"` // "NO2" when available, else "PM25" or "PM10"
	Hourly    [24]float64 `json:"hourly"`    // µg/m³
	Days      int         `json:"days"`
}

var airHistoryCache = NewCache[*AirByHour](6 * time.Hour)

// AirHistory averages a monitor's hourly readings over the last 14 days.
func AirHistory(ctx context.Context, site AirSite) (*AirByHour, error) {
	return airHistoryCache.Get(ctx, site.Code, func(ctx context.Context) (*AirByHour, error) {
		end := time.Now().In(londonTZ).AddDate(0, 0, 1)
		start := end.AddDate(0, 0, -15)
		var res struct {
			Data struct {
				Points []struct {
					Species string `json:"@SpeciesCode"`
					At      string `json:"@MeasurementDateGMT"`
					Value   string `json:"@Value"`
				} `json:"Data"`
			} `json:"AirQualityData"`
		}
		url := fmt.Sprintf("https://api.erg.ic.ac.uk/AirQuality/Data/Site/SiteCode=%s/StartDate=%s/EndDate=%s/Json",
			site.Code, start.Format(time.DateOnly), end.Format(time.DateOnly))
		if err := getJSON(ctx, url, &res); err != nil {
			return nil, err
		}
		type acc struct{ sum, n [24]float64 }
		bySpecies := map[string]*acc{}
		days := map[string]bool{}
		for _, p := range res.Data.Points {
			v, err := strconv.ParseFloat(p.Value, 64)
			if err != nil {
				continue
			}
			t, err := time.ParseInLocation(time.DateTime, p.At, time.UTC)
			if err != nil {
				continue
			}
			local := t.In(londonTZ)
			a := bySpecies[p.Species]
			if a == nil {
				a = &acc{}
				bySpecies[p.Species] = a
			}
			a.sum[local.Hour()] += v
			a.n[local.Hour()]++
			days[local.Format(time.DateOnly)] = true
		}
		out := &AirByHour{Site: site.Name, Days: len(days)}
		for _, sp := range []string{"NO2", "PM25", "PM10"} {
			if a := bySpecies[sp]; a != nil {
				out.Pollutant = sp
				for h := 0; h < 24; h++ {
					if a.n[h] > 0 {
						out.Hourly[h] = math.Round(a.sum[h]/a.n[h]*10) / 10
					} else {
						out.Hourly[h] = math.NaN()
					}
				}
				return out, nil
			}
		}
		return nil, fmt.Errorf("%s: no NO2 or particulate readings", site.Code)
	})
}

var londonTZ, _ = time.LoadLocation("Europe/London")
