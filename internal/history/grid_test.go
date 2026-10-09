package history

import (
	"testing"
	"time"
)

func TestDecodeLegacySeed(t *testing.T) {
	rows, seen, err := Decode(Seed())
	if err != nil || len(rows) == 0 || len(seen) == 0 {
		t.Fatalf("legacy seed: %d rows, %d hours, %v", len(rows), len(seen), err)
	}
	g := NewGrid()
	if err := g.Merge(Seed()); err != nil {
		t.Fatal(err)
	}
	// Re-encoding in the new format and decoding again keeps the totals.
	data, _ := g.Encode()
	again, seen2, _ := Decode(data)
	if len(seen2) != len(seen) || sum(again) != sum(rows) {
		t.Fatalf("round trip changed totals: %v vs %v", sum(again), sum(rows))
	}
}

func sum(rows []Row) (s float64) {
	for _, r := range rows {
		s += r.Passes
	}
	return
}

func TestPendingAndReplace(t *testing.T) {
	g := NewGrid()
	g.Track()
	rec := g.NewRecorder()
	at := time.Date(2026, 10, 9, 3, 15, 0, 0, London) // a Friday, 3am
	rec.Add(Observation{Hex: "a", At: at, Lat: 51.47, Lon: -0.37, AltFt: 2000, Kind: "plane"})
	rec.Add(Observation{Hex: "a", At: at.Add(time.Minute), Lat: 51.47, Lon: -0.37, AltFt: 1900, Kind: "plane"}) // same aircraft, same cell: not counted again
	rows, seen := g.TakePending()
	if len(rows) != 1 || rows[0].Passes != 1 || rows[0].Low != 1 || rows[0].Dow != 4 || rows[0].Hour != 3 || len(seen) != 1 {
		t.Fatalf("pending: %+v %v", rows, seen)
	}
	if r2, _ := g.TakePending(); len(r2) != 0 {
		t.Fatal("pending not cleared")
	}
	// Something recorded after the save survives a reload from the database.
	rec.Add(Observation{Hex: "b", At: at, Lat: 51.47, Lon: -0.37, AltFt: 9000, Kind: "plane"})
	g.Replace(rows, seen)
	if p := g.At(51.47, -0.37); p.Passes[3] != 2 {
		t.Fatalf("after replace, 3am passes = %v, want 2", p.Passes[3])
	}
	// Skipped hours are ignored entirely (already recorded elsewhere).
	g2 := NewGrid()
	g2.Skip([]string{"2026-10-09T03"})
	g2.NewRecorder().Add(Observation{Hex: "c", At: at, Lat: 51.47, Lon: -0.37, AltFt: 2000, Kind: "plane"})
	if r, s := g2.Rows(); len(r) != 0 || len(s) != 0 {
		t.Fatalf("skip ignored: %v %v", r, s)
	}
}
