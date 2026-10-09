package sources

import "testing"

func TestParseHours(t *testing.T) {
	h := MustHours("Mon-Fri 08:00-20:00; Sat-Sun 09:00-17:00")
	cases := []struct {
		day, min int
		want     bool
	}{{0, 8 * 60, true}, {0, 7*60 + 59, false}, {4, 19*60 + 59, true}, {4, 20 * 60, false}, {5, 9 * 60, true}, {6, 17 * 60, false}}
	for _, c := range cases {
		if got := h.OpenAt(c.day, c.min); got != c.want {
			t.Errorf("OpenAt(%d, %d) = %v, want %v", c.day, c.min, got, c.want)
		}
	}
	if h.Text != "Weekdays 8am–8pm; Weekends 9am–5pm" {
		t.Errorf("Text = %q", h.Text)
	}
	// Past midnight spills into the next day.
	late := MustHours("Mon-Sun 08:00-00:00")
	if !late.OpenAt(2, 23*60+59) || late.OpenAt(3, 0) {
		t.Error("08:00-00:00 should close exactly at midnight")
	}
	night := MustHours("Fri 20:00-02:00")
	if !night.OpenAt(5, 60) || night.OpenAt(5, 2*60) {
		t.Error("Fri 20:00-02:00 should run to 2am Saturday")
	}
	if !MustHours("24/7").OpenAt(3, 3*60) {
		t.Error("24/7 should always be open")
	}
	if _, err := ParseHours("Monday 9-5"); err == nil {
		t.Error("expected an error for unparseable hours")
	}
}

func TestNearestGPs(t *testing.T) {
	g := NearestGPs(51.5189, -0.0785, 3) // E1 6AN
	if len(g) != 3 || g[0].Distance > 1500 || g[0].Distance > g[1].Distance {
		t.Errorf("unexpected nearest GPs: %+v", g)
	}
}
