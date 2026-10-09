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
	VRate    int     `json:"vrate_fpm"` // climb (+) or descent (-) in feet per minute
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
			BaroRate *float64        `json:"baro_rate"`
			GeomRate *float64        `json:"geom_rate"`
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
		if a.BaroRate != nil {
			ac.VRate = int(*a.BaroRate)
		} else if a.GeomRate != nil {
			ac.VRate = int(*a.GeomRate)
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

// Emergency-service aircraft we label on the map. Most don't broadcast a
// telling callsign (the Met's G-MPSC sends "GMPSC"), so match registrations.
var (
	// National Police Air Service fleet, per its June 2026 FOI response,
	// plus the H135s replacing it. The P68s are fixed-wing.
	policeRegs = setOf(
		"G-CPAO", "G-CPAS", "G-NWOI", "G-EMID", "G-POLA", "G-SUFK", "G-TVHB", "G-HEOI",
		"G-POLB", "G-POLC", "G-POLD", "G-POLF", "G-POLG", "G-POLH", "G-POLJ", "G-POLU", "G-POLS",
		"G-DCPB", "G-MPSA", "G-MPSB", "G-MPSC",
		"G-POLV", "G-POLW", "G-POLX", "G-POLZ",
		"G-NPAA", "G-NPAB", "G-NPAC", "G-NPAS",
	)
	policeCallsigns = []string{"NPAS", "UKP"}
	// Air ambulances fly as "Helimed" (HLE) almost everywhere in the UK.
	ambulanceCallsigns = []string{"HLE", "HELIMED"}
	ambulanceRegs      = setOf("G-EHMS", "G-LNDN", "G-LAAA", "G-LAAB") // London's Air Ambulance
	// Helicopter type designators, for when the ADS-B category is missing.
	heliTypes = setOf(
		"EC35", "EC45", "H145", "EC30", "EC55", "EC75", "AS50", "AS55", "AS65", "A109", "A119", "A139", "A169", "A189",
		"EH10", "S76", "S92", "H60", "H47", "R22", "R44", "R66", "B06", "B407", "B429", "EXPL", "MD90", "H160",
	)
)

// Classify labels emergency-service aircraft and helicopters.
func Classify(a Aircraft, category string) string {
	reg, cs := strings.ToUpper(a.Reg), strings.ToUpper(a.Callsign)
	switch {
	case policeRegs[reg] || hasPrefix(cs, policeCallsigns):
		return "police"
	case ambulanceRegs[reg] || hasPrefix(cs, ambulanceCallsigns):
		return "air_ambulance"
	case category == "A7" || heliTypes[strings.ToUpper(a.Type)]:
		return "helicopter"
	default:
		return "plane"
	}
}

func setOf(xs ...string) map[string]bool {
	m := make(map[string]bool, len(xs))
	for _, x := range xs {
		m[x] = true
	}
	return m
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
