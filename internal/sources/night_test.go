package sources

import (
	"reflect"
	"testing"
)

func TestNightsOf(t *testing.T) {
	cases := map[string][]int{
		"Mo-Th Nights/Tu-Fr Morning":    {0, 1, 2, 3},
		"Friday Night/Saturday Morning": {4},
		"Saturday Night/Sunday Morning": {5},
		"Sunday Night/Monday Morning":   {6},
		"Monday to Thursday":            {0, 1, 2, 3},
		"Monday - Friday":               {0, 1, 2, 3, 4},
		"Friday":                        {4},
		"Saturday":                      {5},
		"Sunday":                        {6},
		"Saturday and Sunday":           {5, 6},
	}
	for name, want := range cases {
		if got := nightsOf(name); !reflect.DeepEqual(got, want) {
			t.Errorf("nightsOf(%q) = %v, want %v", name, got, want)
		}
	}
}
