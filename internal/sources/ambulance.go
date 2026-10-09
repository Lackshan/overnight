package sources

import (
	_ "embed"
	"encoding/json"
)

// AmbulanceStats are response times for one ambulance service, from NHS
// England's Ambulance Quality Indicators (AmbSYS). They're published monthly
// as spreadsheets, not an API, so we keep the latest figures in ambulance.json.
type AmbulanceStats struct {
	Service     string `json:"service"`
	Period      string `json:"period"`
	Source      string `json:"source"`
	Sample      bool   `json:"sample"` // true until real AmbSYS figures are pasted in
	Cat1MeanSec int    `json:"cat1_mean_sec"`
	Cat2MeanSec int    `json:"cat2_mean_sec"`
	// National standards: category 1 mean 7 minutes, category 2 mean 18 minutes.
	Cat1TargetSec int `json:"cat1_target_sec"`
	Cat2TargetSec int `json:"cat2_target_sec"`
}

//go:embed ambulance.json
var ambulanceJSON []byte

// LondonAmbulance returns the London Ambulance Service figures. London is one
// service area, so every London postcode gets the same numbers.
func LondonAmbulance() AmbulanceStats {
	var s AmbulanceStats
	if err := json.Unmarshal(ambulanceJSON, &s); err != nil {
		panic("ambulance.json: " + err.Error())
	}
	return s
}
