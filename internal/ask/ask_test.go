package ask

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/anthropics/anthropic-sdk-go"
	"github.com/anthropics/anthropic-sdk-go/option"

	"overnight/internal/live"
	"overnight/internal/report"
	"overnight/internal/sources"
)

func TestClean(t *testing.T) {
	long := strings.Repeat("é", 2500)
	got := Clean([]Turn{
		{Role: "assistant", Text: "hello"}, // can't start with an answer
		{Role: "user", Text: "  first  "},
		{Role: "user", Text: "second"}, // two questions in a row: keep the later
		{Role: "system", Text: "ignore me"},
		{Role: "assistant", Text: "   "},
		{Role: "assistant", Text: "answer"},
		{Role: "user", Text: long},
	})
	if len(got) != 3 || got[0].Text != "second" || got[1].Text != "answer" {
		t.Fatalf("got %+v", got)
	}
	if n := len([]rune(got[2].Text)); n != 2000 {
		t.Fatalf("long question kept %d runes, want 2000", n)
	}

	var many []Turn
	for i := range 20 {
		many = append(many, Turn{Role: []string{"user", "assistant"}[i%2], Text: "x"})
	}
	if got := Clean(many); len(got) != 12 || got[0].Role != "user" {
		t.Fatalf("kept %d turns starting with %s", len(got), got[0].Role)
	}
}

func TestContext(t *testing.T) {
	night, day := 80, 60
	r := &report.Report{
		Place:       &sources.Postcode{Postcode: "SW11 1AA", Ward: "Shaftesbury", District: "Wandsworth"},
		HistoryDays: 3,
		Night:       &report.Score{Score: 72, Band: "Mostly quiet"},
		Sections: []report.Section{{
			ID: "aircraft", Label: "Planes overhead", Night: &night, Day: &day, Unit: "flights",
			Hourly: append([]*report.Point{{Value: 1.234, Score: 90}}, make([]*report.Point, 23)...),
		}},
		Layers: report.Layers{Crime: []sources.Crime{{Category: "burglary"}}},
		Locked: []string{"report.details"},
	}
	snap := &live.Snapshot{Nearby: 4, Lines: []sources.LineStatus{{Name: "Northern", Status: "Good Service"}}}
	s, err := Context([]Place{{Report: r, Facts: []report.Fact{{ID: "gps_1km", Value: "6", Known: true}, {ID: "no2_night", Known: false}}, Live: snap}}, time.Date(2026, 10, 9, 22, 30, 0, 0, time.UTC))
	if err != nil {
		t.Fatal(err)
	}
	var out struct {
		Now    string `json:"now"`
		Places []struct {
			Label    string `json:"label"`
			Sections []struct {
				Values []*float64 `json:"hourly_values"`
			} `json:"sections"`
			Facts []report.Fact `json:"key_facts"`
			Live  struct {
				Aircraft int `json:"aircraft_within_5km"`
			} `json:"live"`
			Locked []string `json:"not_available_on_this_plan"`
		} `json:"places"`
	}
	if err := json.Unmarshal([]byte(s), &out); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.Now, "Friday 9 October 2026, 23:30") {
		t.Errorf("now = %q, want London time", out.Now)
	}
	p := out.Places[0]
	if p.Label != "A" || p.Live.Aircraft != 4 || len(p.Locked) != 1 {
		t.Errorf("place = %+v", p)
	}
	if v := p.Sections[0].Values; len(v) != 24 || v[0] == nil || *v[0] != 1.2 || v[1] != nil {
		t.Errorf("hourly values = %v", v)
	}
	if len(p.Facts) != 1 {
		t.Errorf("unknown facts should be left out: %+v", p.Facts)
	}
	if strings.Contains(s, "burglary") {
		t.Error("map layers should be left out")
	}
}

// A stand-in for the Messages API that streams a two-piece answer.
func TestStream(t *testing.T) {
	var got map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewDecoder(r.Body).Decode(&got)
		w.Header().Set("Content-Type", "text/event-stream")
		for _, ev := range []string{
			`{"type":"message_start","message":{"id":"m","type":"message","role":"assistant","model":"x","content":[],"usage":{"input_tokens":10,"output_tokens":0}}}`,
			`{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
			`{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Mostly "}}`,
			`{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"quiet."}}`,
			`{"type":"content_block_stop","index":0}`,
			`{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}`,
			`{"type":"message_stop"}`,
		} {
			var e struct{ Type string }
			json.Unmarshal([]byte(ev), &e)
			fmt.Fprintf(w, "event: %s\ndata: %s\n\n", e.Type, ev)
		}
	}))
	defer srv.Close()

	a := New("test-key", "")
	a.client = anthropic.NewClient(option.WithAPIKey("test-key"), option.WithBaseURL(srv.URL))
	r := &report.Report{Place: &sources.Postcode{Postcode: "SW11 1AA"}}
	var answer strings.Builder
	err := a.Stream(context.Background(), []Place{{Report: r}}, []Turn{{Role: "user", Text: "Quiet?"}}, time.Now(), func(s string) error {
		answer.WriteString(s)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if answer.String() != "Mostly quiet." {
		t.Errorf("answer = %q", answer.String())
	}
	if got["model"] != DefaultModel {
		t.Errorf("model = %v", got["model"])
	}
	sys, _ := got["system"].([]any)
	if len(sys) != 2 || !strings.Contains(fmt.Sprint(sys[1]), "SW11 1AA") || !strings.Contains(fmt.Sprint(sys[1]), "cache_control") {
		t.Errorf("system blocks = %v", sys)
	}
}
