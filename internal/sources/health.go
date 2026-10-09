package sources

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// GP is an NHS GP practice. ODS publishes locations but not opening hours,
// so the app shows standard contracted core hours (8am–6:30pm on weekdays).
type GP struct {
	Code     string  `json:"code"`
	Name     string  `json:"name"`
	Address  string  `json:"address"`
	Postcode string  `json:"postcode"`
	Phone    string  `json:"phone,omitempty"`
	Lat      float64 `json:"lat"`
	Lon      float64 `json:"lon"`
	Distance float64 `json:"distance_m,omitempty"`
}

//go:embed gps.json
var gpsJSON []byte

var gps = func() []GP {
	var d struct {
		Practices []GP `json:"practices"`
	}
	if err := json.Unmarshal(gpsJSON, &d); err != nil {
		panic("gps.json: " + err.Error())
	}
	return d.Practices
}()

// GPCoreHours are the hours GP contracts require practices to be open.
var GPCoreHours = MustHours("Mon-Fri 08:00-18:30")

// NearestGPs returns the n closest practices, as the crow flies.
func NearestGPs(lat, lon float64, n int) []GP {
	out := make([]GP, len(gps))
	for i, g := range gps {
		g.Distance = roundTo10(haversine(lat, lon, g.Lat, g.Lon))
		out[i] = g
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Distance < out[j].Distance })
	return out[:min(n, len(out))]
}

// GPsWithin counts practices within radius metres.
func GPsWithin(lat, lon, radius float64) int {
	n := 0
	for _, g := range gps {
		if haversine(lat, lon, g.Lat, g.Lon) <= radius {
			n++
		}
	}
	return n
}

// UTC is an NHS urgent treatment centre (or urgent care centre).
type UTC struct {
	Name     string  `json:"name"`
	Site     string  `json:"site"`
	Postcode string  `json:"postcode"`
	HoursRaw *string `json:"hours"` // "24/7", "Mon-Fri 08:00-20:00; Sat-Sun 09:00-17:00", or null if unknown
	WalkIn   *bool   `json:"walkIn"`
	Source   string  `json:"source"`
	Note     string  `json:"note,omitempty"`
	Lat      float64 `json:"lat"`
	Lon      float64 `json:"lon"`
	Hours    *Hours  `json:"-"`
}

//go:embed utcs.json
var utcsJSON []byte

var utcs = func() []UTC {
	var d struct {
		Centres []UTC `json:"centres"`
	}
	if err := json.Unmarshal(utcsJSON, &d); err != nil {
		panic("utcs.json: " + err.Error())
	}
	for i := range d.Centres {
		if d.Centres[i].HoursRaw != nil {
			if h, err := ParseHours(*d.Centres[i].HoursRaw); err == nil {
				d.Centres[i].Hours = h
			} else {
				panic(fmt.Sprintf("utcs.json: %s: %v", d.Centres[i].Name, err))
			}
		}
	}
	return d.Centres
}()

// NearbyUTC is a centre with its distance from a point.
type NearbyUTC struct {
	UTC
	Distance float64 `json:"distance_m"`
}

// NearestUTCs returns the n closest centres with known hours.
func NearestUTCs(lat, lon float64, n int) []NearbyUTC {
	var out []NearbyUTC
	for _, u := range utcs {
		if u.Hours != nil {
			out = append(out, NearbyUTC{UTC: u, Distance: roundTo10(haversine(lat, lon, u.Lat, u.Lon))})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Distance < out[j].Distance })
	return out[:min(n, len(out))]
}

func roundTo10(m float64) float64 { return float64(int(m/10+0.5)) * 10 }

// Hours is a weekly opening schedule. Days run Monday (0) to Sunday (6);
// times are minutes after midnight, and 1440 means midnight at the end of the day.
type Hours struct {
	Open24 bool      `json:"open24"`
	Days   [7][]Span `json:"days"`
	Text   string    `json:"text"` // human-readable, e.g. "Every day, 8am–10pm"
}

type Span struct {
	From int `json:"from"`
	To   int `json:"to"`
}

// OpenAt reports whether it's open on day (Mon=0) at minute m.
func (h *Hours) OpenAt(day, m int) bool {
	if h.Open24 {
		return true
	}
	for _, s := range h.Days[day] {
		if m >= s.From && m < s.To {
			return true
		}
	}
	return false
}

var dayIndex = map[string]int{"mon": 0, "tue": 1, "wed": 2, "thu": 3, "fri": 4, "sat": 5, "sun": 6}
var spanRe = regexp.MustCompile(`^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$`)

// ParseHours reads "24/7" or "Mon-Fri 08:00-20:00; Sat-Sun 09:00-17:00".
// A closing time at or before the opening time runs past midnight.
func ParseHours(s string) (*Hours, error) {
	s = strings.TrimSpace(s)
	if strings.EqualFold(s, "24/7") || strings.EqualFold(s, "24 hours") {
		return &Hours{Open24: true, Text: "24 hours, every day"}, nil
	}
	h := &Hours{}
	for _, part := range strings.Split(s, ";") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		fields := strings.Fields(part)
		if len(fields) < 2 {
			return nil, fmt.Errorf("can't read %q", part)
		}
		days, err := parseDays(fields[0])
		if err != nil {
			return nil, err
		}
		for _, t := range strings.Split(strings.Join(fields[1:], ""), ",") {
			m := spanRe.FindStringSubmatch(t)
			if m == nil {
				return nil, fmt.Errorf("can't read time %q", t)
			}
			a, _ := strconv.Atoi(m[1])
			b, _ := strconv.Atoi(m[2])
			c, _ := strconv.Atoi(m[3])
			d, _ := strconv.Atoi(m[4])
			from, to := a*60+b, c*60+d
			for _, day := range days {
				if to <= from { // past midnight: split across two days
					h.Days[day] = append(h.Days[day], Span{from, 1440})
					if to > 0 {
						h.Days[(day+1)%7] = append(h.Days[(day+1)%7], Span{0, to})
					}
				} else {
					h.Days[day] = append(h.Days[day], Span{from, to})
				}
			}
		}
	}
	h.Text = describe(s)
	return h, nil
}

func MustHours(s string) *Hours {
	h, err := ParseHours(s)
	if err != nil {
		panic(err)
	}
	return h
}

func parseDays(s string) ([]int, error) {
	s = strings.ToLower(s)
	if s == "daily" || s == "mon-sun" {
		return []int{0, 1, 2, 3, 4, 5, 6}, nil
	}
	var out []int
	for _, part := range strings.Split(s, ",") {
		ends := strings.Split(part, "-")
		a, ok := dayIndex[ends[0]]
		if !ok {
			return nil, fmt.Errorf("unknown day %q", ends[0])
		}
		b := a
		if len(ends) == 2 {
			if b, ok = dayIndex[ends[1]]; !ok {
				return nil, fmt.Errorf("unknown day %q", ends[1])
			}
		}
		for d := a; ; d = (d + 1) % 7 {
			out = append(out, d)
			if d == b {
				break
			}
		}
	}
	return out, nil
}

// describe turns "Mon-Sun 08:00-22:00" into "Every day, 8am–10pm".
func describe(s string) string {
	parts := strings.Split(s, ";")
	var out []string
	for _, p := range parts {
		f := strings.Fields(strings.TrimSpace(p))
		if len(f) < 2 {
			continue
		}
		days := strings.ToLower(f[0])
		label := map[string]string{"mon-sun": "Every day", "daily": "Every day", "mon-fri": "Weekdays", "sat-sun": "Weekends"}[days]
		if label == "" {
			var ds []string
			for _, d := range strings.Split(days, "-") {
				if d != "" {
					ds = append(ds, strings.ToUpper(d[:1])+d[1:])
				}
			}
			label = strings.Join(ds, "–")
		}
		var times []string
		for _, t := range strings.Split(strings.Join(f[1:], ""), ",") {
			if m := spanRe.FindStringSubmatch(t); m != nil {
				times = append(times, clock(m[1], m[2])+"–"+clock(m[3], m[4]))
			}
		}
		out = append(out, label+" "+strings.Join(times, ", "))
	}
	return strings.Join(out, "; ")
}

func clock(hs, ms string) string {
	h, _ := strconv.Atoi(hs)
	m, _ := strconv.Atoi(ms)
	suffix := "am"
	switch {
	case h == 0 || h == 24:
		if m == 0 {
			return "midnight"
		}
		h = 12
	case h == 12:
		suffix = "pm"
	case h > 12:
		h -= 12
		suffix = "pm"
	}
	if m == 0 {
		return fmt.Sprintf("%d%s", h, suffix)
	}
	return fmt.Sprintf("%d:%02d%s", h, m, suffix)
}
