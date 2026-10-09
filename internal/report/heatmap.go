package report

import (
	"fmt"
	"math"

	"overnight/internal/sources"
)

// Heatmap is a 7×24 grid (Monday first) of relative activity, 0 to 1.
//
// The police API doesn't publish times, so this is an estimate: each local
// crime is spread across the week using a typical time profile for its
// category. Swap in measured data (e.g. helicopter history) when available.
type Heatmap struct {
	Estimated bool           `json:"estimated"`
	Grid      [7][24]float64 `json:"grid"`
	Peak      string         `json:"peak"`
}

var dayNames = [7]string{"Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays", "Sundays"}

type profile struct {
	hours [24]float64
	days  [7]float64
}

// bump is a bell curve around peak hour that wraps past midnight.
func bump(h, peak, width float64) float64 {
	d := math.Abs(h - peak)
	d = math.Min(d, 24-d)
	return math.Exp(-d * d / (2 * width * width))
}

func makeProfile(peaks [][2]float64, base float64, days [7]float64) profile {
	var p profile
	for h := 0; h < 24; h++ {
		v := base
		for _, pk := range peaks {
			v += bump(float64(h), pk[0], pk[1])
		}
		p.hours[h] = v
	}
	p.days = days
	return p
}

var (
	weekendNights = [7]float64{.8, .8, .9, 1, 1.4, 1.6, 1.1}
	weekdays      = [7]float64{1.1, 1.1, 1.1, 1.1, 1.1, .9, .7}
	flat          = [7]float64{1, 1, 1, 1, 1, 1, 1}

	nightLife = makeProfile([][2]float64{{23, 2.5}}, .15, weekendNights)
	evening   = makeProfile([][2]float64{{20, 3}}, .15, weekendNights)
	daytime   = makeProfile([][2]float64{{14, 3.5}}, .1, weekdays)
	commute   = makeProfile([][2]float64{{8.5, 1.5}, {18, 2}, {23, 2}}, .1, flat)
	overnight = makeProfile([][2]float64{{2, 3}}, .2, flat)
	general   = makeProfile([][2]float64{{17, 5}}, .3, flat)
)

var profiles = map[string]profile{
	"violent-crime":         nightLife,
	"public-order":          nightLife,
	"drugs":                 evening,
	"anti-social-behaviour": evening,
	"robbery":               evening,
	"possession-of-weapons": evening,
	"shoplifting":           daytime,
	"burglary":              daytime,
	"bicycle-theft":         daytime,
	"other-theft":           daytime,
	"theft-from-the-person": commute,
	"vehicle-crime":         overnight,
	"criminal-damage-arson": overnight,
}

func estimateHeatmap(crimes []sources.Crime) *Heatmap {
	if len(crimes) == 0 {
		return nil
	}
	h := &Heatmap{Estimated: true}
	counts := map[string]int{}
	for _, c := range crimes {
		counts[c.Category]++
	}
	for cat, n := range counts {
		p, ok := profiles[cat]
		if !ok {
			p = general
		}
		var total float64
		for d := 0; d < 7; d++ {
			for hr := 0; hr < 24; hr++ {
				total += p.days[d] * p.hours[hr]
			}
		}
		for d := 0; d < 7; d++ {
			for hr := 0; hr < 24; hr++ {
				h.Grid[d][hr] += float64(n) * p.days[d] * p.hours[hr] / total
			}
		}
	}
	var peak float64
	pd, ph := 0, 0
	for d := 0; d < 7; d++ {
		for hr := 0; hr < 24; hr++ {
			if h.Grid[d][hr] > peak {
				peak, pd, ph = h.Grid[d][hr], d, hr
			}
		}
	}
	for d := 0; d < 7; d++ {
		for hr := 0; hr < 24; hr++ {
			h.Grid[d][hr] = math.Round(h.Grid[d][hr]/peak*100) / 100
		}
	}
	h.Peak = fmt.Sprintf("%s around %s", dayNames[pd], hourName(ph))
	return h
}

func hourName(h int) string {
	switch {
	case h == 0:
		return "midnight"
	case h == 12:
		return "midday"
	case h < 12:
		return fmt.Sprintf("%dam", h)
	default:
		return fmt.Sprintf("%dpm", h-12)
	}
}

// hourShare is the estimated share of crimes happening in each hour of the
// day (sums to 1), from the same per-category profiles.
func hourShare(crimes []sources.Crime) [24]float64 {
	var out [24]float64
	h := estimateHeatmap(crimes)
	if h == nil {
		return out
	}
	var total float64
	for d := 0; d < 7; d++ {
		for hr := 0; hr < 24; hr++ {
			out[hr] += h.Grid[d][hr]
			total += h.Grid[d][hr]
		}
	}
	for hr := range out {
		out[hr] /= total
	}
	return out
}
