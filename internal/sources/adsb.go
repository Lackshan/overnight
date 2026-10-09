package sources

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
)

type Aircraft struct {
	Hex      string  `json:"hex"`
	Callsign string  `json:"callsign"`
	Reg      string  `json:"reg"`
	Type     string  `json:"type"`
	Lat      float64 `json:"lat"`
	Lon      float64 `json:"lon"`
	AltFt    int     `json:"alt_ft"` // 0 when on the ground
	Speed    float64 `json:"speed_kt"`
	Track    float64 `json:"track"`
	Kind     string  `json:"kind"` // "police", "air_ambulance", "helicopter" or "plane"
	Squawk   string  `json:"squawk,omitempty"`
	T        int64   `json:"t"` // when this position was received, Unix ms
}

// AircraftNear returns aircraft adsb.lol currently sees within radiusNM.
// Not cached: the live poller calls this on its own schedule.
func AircraftNear(ctx context.Context, lat, lon float64, radiusNM int) ([]Aircraft, error) {
	var res struct {
		Now float64 `json:"now"` // Unix ms
		AC  []struct {
			Hex      string          `json:"hex"`
			Flight   string          `json:"flight"`
			Reg      string          `json:"r"`
			Type     string          `json:"t"`
			Lat      *float64        `json:"lat"`
			Lon      *float64        `json:"lon"`
			Alt      json.RawMessage `json:"alt_baro"` // number, or "ground"
			Speed    float64         `json:"gs"`
			Track    *float64        `json:"track"`
			Heading  *float64        `json:"true_heading"`
			Category string          `json:"category"`
			Squawk   string          `json:"squawk"`
			SeenPos  float64         `json:"seen_pos"` // seconds since the position was received
		} `json:"ac"`
	}
	url := fmt.Sprintf("https://api.adsb.lol/v2/point/%.4f/%.4f/%d", lat, lon, radiusNM)
	if err := getJSON(ctx, url, &res); err != nil {
		return nil, err
	}
	out := make([]Aircraft, 0, len(res.AC))
	for _, a := range res.AC {
		if a.Lat == nil || a.Lon == nil {
			continue
		}
		var alt int
		json.Unmarshal(a.Alt, &alt) // "ground" leaves 0
		ac := Aircraft{
			Hex: a.Hex, Callsign: strings.TrimSpace(a.Flight), Reg: a.Reg, Type: a.Type,
			Lat: *a.Lat, Lon: *a.Lon, AltFt: alt, Speed: a.Speed, Squawk: a.Squawk,
			T: int64(res.Now - a.SeenPos*1000),
		}
		if a.Track != nil {
			ac.Track = *a.Track
		} else if a.Heading != nil {
			ac.Track = *a.Heading
		}
		ac.Kind = Classify(ac, a.Category)
		out = append(out, ac)
	}
	return out, nil
}

// Emergency-service aircraft we label on the map. National Police Air Service
// helicopters fly as "NPAS…" with G-POL… registrations. Add more here.
var (
	policeCallsigns   = []string{"NPAS"}
	policeRegs        = []string{"G-POL"}
	ambulanceRegs     = []string{"G-LNDN", "G-EHMS"} // London's Air Ambulance
	ambulanceCallsign = []string{"HLE", "HELIMED"}
)

// Classify labels emergency-service aircraft from callsign, registration and ADS-B category.
func Classify(a Aircraft, category string) string {
	switch {
	case hasPrefix(a.Callsign, policeCallsigns) || hasPrefix(a.Reg, policeRegs):
		return "police"
	case hasPrefix(a.Reg, ambulanceRegs) || hasPrefix(a.Callsign, ambulanceCallsign):
		return "air_ambulance"
	case category == "A7":
		return "helicopter"
	default:
		return "plane"
	}
}

func hasPrefix(s string, prefixes []string) bool {
	s = strings.ToUpper(s)
	for _, p := range prefixes {
		if strings.HasPrefix(s, p) {
			return true
		}
	}
	return false
}
