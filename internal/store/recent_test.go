package store

import (
	"context"
	"testing"
	"time"
)

func TestMemoryRecents(t *testing.T) {
	ctx := context.Background()
	s := NewMemory(t.TempDir())
	score := 61
	t0 := time.Date(2026, 10, 9, 22, 0, 0, 0, time.UTC)
	for i, pc := range []string{"E1 6AN", "SE15 4QL", "TW3 3AD"} {
		r := Recent{Postcode: pc, At: t0.Add(time.Duration(i) * time.Minute)}
		if pc == "E1 6AN" {
			r.NightScore = &score
		}
		s.AddRecent(ctx, "u", r, 3)
	}
	// Repeating a search moves it to the top and keeps its earlier score.
	s.AddRecent(ctx, "u", Recent{Postcode: "E1 6AN", At: t0.Add(time.Hour)}, 3)
	got, _ := s.Recent(ctx, "u", 10)
	if len(got) != 3 || got[0].Postcode != "E1 6AN" || got[0].NightScore == nil || *got[0].NightScore != 61 {
		t.Fatalf("after repeat: %+v", got)
	}
	// Over the limit, the oldest drops off.
	s.AddRecent(ctx, "u", Recent{Postcode: "N12 9LU", At: t0.Add(2 * time.Hour)}, 3)
	got, _ = s.Recent(ctx, "u", 10)
	if len(got) != 3 || got[0].Postcode != "N12 9LU" || got[2].Postcode != "TW3 3AD" {
		t.Fatalf("after limit: %+v", got)
	}
	s.DeleteRecent(ctx, "u", "TW3 3AD")
	if got, _ = s.Recent(ctx, "u", 10); len(got) != 2 {
		t.Fatalf("after delete: %+v", got)
	}
	s.DeleteRecent(ctx, "u", "")
	if got, _ = s.Recent(ctx, "u", 10); len(got) != 0 {
		t.Fatalf("after clear: %+v", got)
	}
}
