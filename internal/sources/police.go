package sources

import (
	"context"
	"fmt"
	"strconv"
	"time"
)

type Crime struct {
	Category string  `json:"category"`
	Lat      float64 `json:"lat"`
	Lon      float64 `json:"lon"`
	Street   string  `json:"street"`
	Month    string  `json:"month"`
}

// The police API publishes monthly, about two months behind, so a long TTL is fine.
var crimeCache = NewCache[[]Crime](12 * time.Hour)

// CrimesNear returns street-level crimes within one mile of a point for the
// latest published month (data.police.uk). Locations are approximate by design.
func CrimesNear(ctx context.Context, lat, lon float64) ([]Crime, error) {
	key := fmt.Sprintf("%.4f,%.4f", lat, lon)
	return crimeCache.Get(ctx, key, func(ctx context.Context) ([]Crime, error) {
		var raw []struct {
			Category string `json:"category"`
			Month    string `json:"month"`
			Location struct {
				Latitude  string `json:"latitude"`
				Longitude string `json:"longitude"`
				Street    struct {
					Name string `json:"name"`
				} `json:"street"`
			} `json:"location"`
		}
		url := fmt.Sprintf("https://data.police.uk/api/crimes-street/all-crime?lat=%.6f&lng=%.6f", lat, lon)
		if err := getJSON(ctx, url, &raw); err != nil {
			return nil, err
		}
		out := make([]Crime, 0, len(raw))
		for _, c := range raw {
			la, err1 := strconv.ParseFloat(c.Location.Latitude, 64)
			lo, err2 := strconv.ParseFloat(c.Location.Longitude, 64)
			if err1 != nil || err2 != nil {
				continue
			}
			out = append(out, Crime{Category: c.Category, Lat: la, Lon: lo, Street: c.Location.Street.Name, Month: c.Month})
		}
		return out, nil
	})
}

// CrimeLabels turns police API category slugs into readable names.
var CrimeLabels = map[string]string{
	"anti-social-behaviour": "Anti-social behaviour",
	"bicycle-theft":         "Bicycle theft",
	"burglary":              "Burglary",
	"criminal-damage-arson": "Criminal damage and arson",
	"drugs":                 "Drugs",
	"other-theft":           "Other theft",
	"possession-of-weapons": "Possession of weapons",
	"public-order":          "Public order",
	"robbery":               "Robbery",
	"shoplifting":           "Shoplifting",
	"theft-from-the-person": "Theft from the person",
	"vehicle-crime":         "Vehicle crime",
	"violent-crime":         "Violence and sexual offences",
	"other-crime":           "Other crime",
}
