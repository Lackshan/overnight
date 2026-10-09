// Package config loads features.yaml, which decides what each plan can see.
package config

import (
	"fmt"
	"os"
	"slices"
	"sort"

	"gopkg.in/yaml.v3"
)

// Plan names. These are fixed because the code needs to know who is signed in
// and who is paying; everything else about a plan lives in features.yaml.
const (
	PlanAnonymous = "anonymous"
	PlanFree      = "free"
	PlanPro       = "pro"
)

// Feature keys the code checks. Startup fails if features.yaml is missing any.
const (
	ReportScore     = "report.score"
	ReportSections  = "report.sections"
	ReportDetails   = "report.details"
	SafetyBreakdown = "safety.breakdown"
	ReportTimeline  = "report.timeline"
	MapCrime        = "map.crime"
	MapAir          = "map.air"
	MapTransport    = "map.transport"
	MapAircraft     = "map.aircraft"
	MapOverflights  = "map.overflights"
	LiveFeed        = "live.feed"

	LimitLookupsPerDay = "report.lookups_per_day"
	LimitFeedItems     = "live.feed_items"
)

var requiredFeatures = []string{
	ReportScore, ReportSections, ReportDetails, ReportTimeline, SafetyBreakdown,
	MapCrime, MapAir, MapTransport, MapAircraft, MapOverflights, LiveFeed,
}

var requiredLimits = []string{LimitLookupsPerDay, LimitFeedItems}

type Plan struct {
	Name           string `yaml:"name" json:"name"`
	PriceLabel     string `yaml:"price_label" json:"price_label,omitempty"`
	CheckoutMode   string `yaml:"checkout_mode" json:"checkout_mode,omitempty"`
	StripePriceEnv string `yaml:"stripe_price_env" json:"-"`
}

type Feature struct {
	Label string   `yaml:"label" json:"label"`
	Plans []string `yaml:"plans" json:"plans"`
}

type Features struct {
	Plans        map[string]Plan           `yaml:"plans"`
	UpgradeOrder []string                  `yaml:"upgrade_order"`
	Features     map[string]Feature        `yaml:"features"`
	Limits       map[string]map[string]int `yaml:"limits"`
}

func Load(path string) (*Features, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var f Features
	if err := yaml.Unmarshal(raw, &f); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	if err := f.validate(); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	return &f, nil
}

func (f *Features) validate() error {
	for _, p := range []string{PlanAnonymous, PlanFree, PlanPro} {
		if _, ok := f.Plans[p]; !ok {
			return fmt.Errorf("plans: missing %q", p)
		}
	}
	for _, p := range f.UpgradeOrder {
		if _, ok := f.Plans[p]; !ok {
			return fmt.Errorf("upgrade_order: unknown plan %q", p)
		}
	}
	for _, key := range requiredFeatures {
		if _, ok := f.Features[key]; !ok {
			return fmt.Errorf("features: missing %q", key)
		}
	}
	for key, feat := range f.Features {
		if !slices.Contains(requiredFeatures, key) {
			return fmt.Errorf("features: %q isn't used by the app (typo?)", key)
		}
		for _, p := range feat.Plans {
			if _, ok := f.Plans[p]; !ok {
				return fmt.Errorf("features.%s: unknown plan %q", key, p)
			}
		}
	}
	for _, key := range requiredLimits {
		if _, ok := f.Limits[key]; !ok {
			return fmt.Errorf("limits: missing %q", key)
		}
	}
	for key, per := range f.Limits {
		for p := range per {
			if _, ok := f.Plans[p]; !ok {
				return fmt.Errorf("limits.%s: unknown plan %q", key, p)
			}
		}
	}
	return nil
}

// Can reports whether plan can see feature.
func (f *Features) Can(plan, feature string) bool {
	feat, ok := f.Features[feature]
	return ok && slices.Contains(feat.Plans, plan)
}

// Limit returns the plan's limit for key. 0 means unlimited.
func (f *Features) Limit(plan, key string) int {
	return f.Limits[key][plan]
}

// NextPlan returns the cheapest plan above current that unlocks feature, or "".
func (f *Features) NextPlan(current, feature string) string {
	i := slices.Index(f.UpgradeOrder, current)
	for _, p := range f.UpgradeOrder[i+1:] {
		if f.Can(p, feature) {
			return p
		}
	}
	return ""
}

// FeatureState is what the UI needs to render one feature.
type FeatureState struct {
	Label     string `json:"label"`
	Allowed   bool   `json:"allowed"`
	UnlocksOn string `json:"unlocks_on,omitempty"` // next plan that unlocks it
}

// StateFor describes every feature and limit from plan's point of view.
func (f *Features) StateFor(plan string) (map[string]FeatureState, map[string]int) {
	feats := make(map[string]FeatureState, len(f.Features))
	keys := make([]string, 0, len(f.Features))
	for k := range f.Features {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		s := FeatureState{Label: f.Features[k].Label, Allowed: f.Can(plan, k)}
		if !s.Allowed {
			s.UnlocksOn = f.NextPlan(plan, k)
		}
		feats[k] = s
	}
	limits := make(map[string]int, len(f.Limits))
	for k := range f.Limits {
		limits[k] = f.Limit(plan, k)
	}
	return feats, limits
}
