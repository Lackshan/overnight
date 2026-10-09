package sources

import "testing"

func TestClassify(t *testing.T) {
	cases := []struct {
		a        Aircraft
		category string
		want     string
	}{
		{Aircraft{Reg: "G-MPSC", Callsign: "GMPSC", Type: "EC45"}, "", "police"}, // Met/NPAS London, no category
		{Aircraft{Reg: "G-POLH", Callsign: "GPOLH", Type: "EC35"}, "", "police"},
		{Aircraft{Reg: "G-POLX", Type: "P68"}, "A1", "police"}, // NPAS fixed-wing
		{Aircraft{Callsign: "NPAS15"}, "A7", "police"},
		{Aircraft{Reg: "G-DAAS", Callsign: "HLE70", Type: "EC45"}, "A7", "air_ambulance"},
		{Aircraft{Reg: "G-LNDN", Callsign: "HLE27", Type: "EXPL"}, "A7", "air_ambulance"},
		{Aircraft{Reg: "G-CHPR", Type: "EC35"}, "", "helicopter"}, // no category, known heli type
		{Aircraft{Reg: "G-EUYA", Callsign: "BAW123", Type: "A320"}, "A3", "plane"},
	}
	for _, c := range cases {
		if got := Classify(c.a, c.category); got != c.want {
			t.Errorf("Classify(%s %s %s) = %s, want %s", c.a.Reg, c.a.Callsign, c.a.Type, got, c.want)
		}
	}
}
