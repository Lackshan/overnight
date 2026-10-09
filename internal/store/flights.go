package store

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"overnight/internal/history"
)

// LoadFlights reads every flight total and observed date-hour.
func (p *Postgres) LoadFlights(ctx context.Context) ([]history.Row, []string, error) {
	rows, err := p.pool.Query(ctx, `select cell, dow, hour, passes, low, helis, police_sec, amb_sec from public.flight_counts`)
	if err != nil {
		return nil, nil, err
	}
	var out []history.Row
	for rows.Next() {
		var r history.Row
		var cell int32
		var dow, hour int16
		if err := rows.Scan(&cell, &dow, &hour, &r.Passes, &r.Low, &r.Helis, &r.PoliceSec, &r.AmbSec); err != nil {
			rows.Close()
			return nil, nil, err
		}
		r.Key = history.Key{Cell: history.Cell(cell), Dow: int8(dow), Hour: int8(hour)}
		out = append(out, r)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}
	var seen []string
	hrs, err := p.pool.Query(ctx, `select date_hour from public.flight_hours`)
	if err != nil {
		return nil, nil, err
	}
	defer hrs.Close()
	for hrs.Next() {
		var dh string
		if err := hrs.Scan(&dh); err != nil {
			return nil, nil, err
		}
		seen = append(seen, dh)
	}
	return out, seen, hrs.Err()
}

// FlightHours returns the date-hours already recorded.
func (p *Postgres) FlightHours(ctx context.Context) ([]string, error) {
	rows, err := p.pool.Query(ctx, `select date_hour from public.flight_hours`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var seen []string
	for rows.Next() {
		var dh string
		if err := rows.Scan(&dh); err != nil {
			return nil, err
		}
		seen = append(seen, dh)
	}
	return seen, rows.Err()
}

// AddFlights adds counts to the stored totals and records date-hours, in one
// transaction. backfillDay, if set, is recorded as imported in the same
// transaction, so a day can never be imported twice.
func (p *Postgres) AddFlights(ctx context.Context, rows []history.Row, seen []string, backfillDay *time.Time) error {
	return pgx.BeginFunc(ctx, p.pool, func(tx pgx.Tx) error {
		if backfillDay != nil {
			tag, err := tx.Exec(ctx, `insert into public.flight_backfills (day) values ($1) on conflict do nothing`, *backfillDay)
			if err != nil {
				return err
			}
			if tag.RowsAffected() == 0 {
				return ErrAlreadyBackfilled
			}
		}
		// Send in chunks to keep each statement a sensible size.
		for start := 0; start < len(rows); start += 5000 {
			chunk := rows[start:min(start+5000, len(rows))]
			cells := make([]int32, len(chunk))
			dows := make([]int16, len(chunk))
			hours := make([]int16, len(chunk))
			passes := make([]float64, len(chunk))
			low := make([]float64, len(chunk))
			helis := make([]float64, len(chunk))
			police := make([]float64, len(chunk))
			amb := make([]float64, len(chunk))
			for i, r := range chunk {
				cells[i], dows[i], hours[i] = int32(r.Cell), int16(r.Dow), int16(r.Hour)
				passes[i], low[i], helis[i], police[i], amb[i] = r.Passes, r.Low, r.Helis, r.PoliceSec, r.AmbSec
			}
			if _, err := tx.Exec(ctx, `
				insert into public.flight_counts as f (cell, dow, hour, passes, low, helis, police_sec, amb_sec)
				select * from unnest($1::int[], $2::smallint[], $3::smallint[], $4::float8[], $5::float8[], $6::float8[], $7::float8[], $8::float8[])
				on conflict (cell, dow, hour) do update set
					passes = f.passes + excluded.passes,
					low = f.low + excluded.low,
					helis = f.helis + excluded.helis,
					police_sec = f.police_sec + excluded.police_sec,
					amb_sec = f.amb_sec + excluded.amb_sec`,
				cells, dows, hours, passes, low, helis, police, amb); err != nil {
				return err
			}
		}
		if len(seen) > 0 {
			if _, err := tx.Exec(ctx, `insert into public.flight_hours (date_hour) select unnest($1::text[]) on conflict do nothing`, seen); err != nil {
				return err
			}
		}
		return nil
	})
}

var ErrAlreadyBackfilled = errors.New("that day has already been imported")

// BackfilledDays lists archive days already imported.
func (p *Postgres) BackfilledDays(ctx context.Context) (map[string]bool, error) {
	rows, err := p.pool.Query(ctx, `select to_char(day, 'YYYY-MM-DD') from public.flight_backfills`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]bool{}
	for rows.Next() {
		var d string
		if err := rows.Scan(&d); err != nil {
			return nil, err
		}
		out[d] = true
	}
	return out, rows.Err()
}
