// Command gpdata downloads NHS England's list of GP practices (ODS
// "epraccur"), keeps active London practices, geocodes them with
// postcodes.io and writes internal/sources/gps.json, embedded in the API.
//
//	go run ./cmd/gpdata
package main

import (
	"bytes"
	"encoding/csv"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"regexp"
	"sort"
	"strings"
	"time"
)

const epraccur = "https://www.odsdatasearchandexport.nhs.uk/api/getReport?report=epraccur"

// Column positions in epraccur.csv (ODS reference data catalogue).
const (
	colCode     = 0
	colName     = 1
	colRegion   = 2 // national grouping: Y56 is London
	colAddr1    = 4
	colAddr4    = 7
	colPostcode = 9
	colStatus   = 12
	colPhone    = 17
	colRole     = 25 // RO76 is a GP practice
)

type Practice struct {
	Code     string  `json:"code"`
	Name     string  `json:"name"`
	Address  string  `json:"address"`
	Postcode string  `json:"postcode"`
	Phone    string  `json:"phone,omitempty"`
	Lat      float64 `json:"lat"`
	Lon      float64 `json:"lon"`
}

func main() {
	out := flag.String("out", "internal/sources/gps.json", "output file")
	flag.Parse()

	res, err := http.Get(epraccur)
	if err != nil {
		log.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		log.Fatalf("%s: %s", epraccur, res.Status)
	}
	r := csv.NewReader(res.Body)
	r.FieldsPerRecord = -1
	var practices []Practice
	for {
		rec, err := r.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			log.Fatal(err)
		}
		if len(rec) <= colRole || rec[colStatus] != "ACTIVE" || rec[colRole] != "RO76" || rec[colRegion] != "Y56" {
			continue
		}
		var addr []string
		for _, a := range rec[colAddr1 : colAddr4+1] {
			if a = strings.TrimSpace(a); a != "" {
				addr = append(addr, titleCase(a))
			}
		}
		practices = append(practices, Practice{
			Code: rec[colCode], Name: titleCase(rec[colName]), Address: strings.Join(addr, ", "),
			Postcode: rec[colPostcode], Phone: strings.TrimSpace(rec[colPhone]),
		})
	}
	log.Printf("%d active London GP practices", len(practices))

	geo := geocode(practices)
	kept := practices[:0]
	for _, p := range practices {
		if g, ok := geo[p.Postcode]; ok {
			p.Lat, p.Lon = g[0], g[1]
			kept = append(kept, p)
		}
	}
	sort.Slice(kept, func(i, j int) bool { return kept[i].Code < kept[j].Code })
	data, err := json.Marshal(map[string]any{
		"source":    "NHS England Organisation Data Service (epraccur), geocoded with postcodes.io",
		"retrieved": time.Now().Format(time.DateOnly),
		"practices": kept,
	})
	if err != nil {
		log.Fatal(err)
	}
	if err := os.WriteFile(*out, data, 0o644); err != nil {
		log.Fatal(err)
	}
	log.Printf("wrote %s: %d practices (%d without a known postcode), %d KB", *out, len(kept), len(practices)-len(kept), len(data)/1024)
}

// geocode looks postcodes up 100 at a time.
func geocode(ps []Practice) map[string][2]float64 {
	seen := map[string]bool{}
	var pcs []string
	for _, p := range ps {
		if !seen[p.Postcode] {
			seen[p.Postcode] = true
			pcs = append(pcs, p.Postcode)
		}
	}
	out := map[string][2]float64{}
	for i := 0; i < len(pcs); i += 100 {
		batch := pcs[i:min(i+100, len(pcs))]
		body, _ := json.Marshal(map[string][]string{"postcodes": batch})
		res, err := http.Post("https://api.postcodes.io/postcodes", "application/json", bytes.NewReader(body))
		if err != nil {
			log.Fatal(err)
		}
		var r struct {
			Result []struct {
				Query  string `json:"query"`
				Result *struct {
					Lat float64 `json:"latitude"`
					Lon float64 `json:"longitude"`
				} `json:"result"`
			} `json:"result"`
		}
		err = json.NewDecoder(res.Body).Decode(&r)
		res.Body.Close()
		if err != nil {
			log.Fatal(err)
		}
		for _, x := range r.Result {
			if x.Result != nil {
				out[x.Query] = [2]float64{round5(x.Result.Lat), round5(x.Result.Lon)}
			}
		}
		time.Sleep(200 * time.Millisecond)
	}
	return out
}

func round5(v float64) float64 { return float64(int64(v*1e5+0.5*sign(v))) / 1e5 }

func sign(v float64) float64 {
	if v < 0 {
		return -1
	}
	return 1
}

var keepUpper = regexp.MustCompile(`^(NHS|GP|UK|PCN|HC|NW\d*|SE\d*|SW\d*|EC\d*|WC\d*|E\d+|N\d+|W\d+)$`)

// "THE SURGERY (BROOKE ROAD)" -> "The Surgery (Brooke Road)".
func titleCase(s string) string {
	words := strings.Fields(strings.ToLower(s))
	for i, w := range words {
		lead := ""
		for len(w) > 0 && strings.ContainsAny(w[:1], "(\"'") {
			lead, w = lead+w[:1], w[1:]
		}
		switch {
		case w == "":
		case keepUpper.MatchString(strings.ToUpper(w)):
			w = strings.ToUpper(w)
		case i > 0 && (w == "and" || w == "of" || w == "the" || w == "on" || w == "at"):
		default:
			w = strings.ToUpper(w[:1]) + w[1:]
		}
		words[i] = lead + w
	}
	return fmt.Sprint(strings.Join(words, " "))
}
