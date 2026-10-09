package sources

import (
	"context"
	"errors"
	"net/url"
	"strings"
	"time"
)

type Postcode struct {
	Postcode string  `json:"postcode"`
	Lat      float64 `json:"lat"`
	Lon      float64 `json:"lon"`
	Ward     string  `json:"ward"`
	District string  `json:"district"`
	Region   string  `json:"region"`
}

var ErrPostcodeNotFound = errors.New("postcode not found")

var postcodeCache = NewCache[*Postcode](24 * time.Hour)

// NormalisePostcode uppercases and strips spaces: "e1 6an" -> "E16AN".
func NormalisePostcode(pc string) string {
	return strings.ToUpper(strings.ReplaceAll(strings.TrimSpace(pc), " ", ""))
}

// LookupPostcode resolves a UK postcode with postcodes.io.
func LookupPostcode(ctx context.Context, pc string) (*Postcode, error) {
	pc = NormalisePostcode(pc)
	return postcodeCache.Get(ctx, pc, func(ctx context.Context) (*Postcode, error) {
		var res struct {
			Result struct {
				Postcode      string   `json:"postcode"`
				Latitude      *float64 `json:"latitude"`
				Longitude     *float64 `json:"longitude"`
				AdminWard     string   `json:"admin_ward"`
				AdminDistrict string   `json:"admin_district"`
				Region        string   `json:"region"`
			} `json:"result"`
		}
		err := getJSON(ctx, "https://api.postcodes.io/postcodes/"+url.PathEscape(pc), &res)
		var se *StatusError
		if errors.As(err, &se) && se.Code == 404 {
			return nil, ErrPostcodeNotFound
		}
		if err != nil {
			return nil, err
		}
		r := res.Result
		if r.Latitude == nil || r.Longitude == nil {
			return nil, ErrPostcodeNotFound
		}
		return &Postcode{
			Postcode: r.Postcode, Lat: *r.Latitude, Lon: *r.Longitude,
			Ward: r.AdminWard, District: r.AdminDistrict, Region: r.Region,
		}, nil
	})
}
