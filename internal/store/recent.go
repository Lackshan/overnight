package store

import (
	"context"
	"sort"
	"time"

	"github.com/jackc/pgx/v5"
)

// Recent is a postcode a signed-in user looked up.
type Recent struct {
	Postcode   string    `json:"postcode"`
	Area       string    `json:"area"`
	Lat        float64   `json:"lat"`
	Lon        float64   `json:"lon"`
	NightScore *int      `json:"night_score,omitempty"` // the overnight score when they searched
	At         time.Time `json:"at"`
}

// Recents keeps each user's latest searches.
type Recents interface {
	Recent(ctx context.Context, userID string, limit int) ([]Recent, error)
	// AddRecent records a search (moving a repeat to the top) and keeps only
	// the newest `keep`.
	AddRecent(ctx context.Context, userID string, r Recent, keep int) error
	// DeleteRecent removes one postcode, or all of them when postcode is "".
	DeleteRecent(ctx context.Context, userID, postcode string) error
}

func (p *Postgres) Recent(ctx context.Context, userID string, limit int) ([]Recent, error) {
	rows, err := p.pool.Query(ctx, `
		select postcode, area, lat, lon, night_score, searched_at from public.recent_searches
		where user_id = $1 order by searched_at desc limit $2`, userID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Recent{}
	for rows.Next() {
		var r Recent
		if err := rows.Scan(&r.Postcode, &r.Area, &r.Lat, &r.Lon, &r.NightScore, &r.At); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func (p *Postgres) AddRecent(ctx context.Context, userID string, r Recent, keep int) error {
	return pgx.BeginFunc(ctx, p.pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `
			insert into public.recent_searches (user_id, postcode, area, lat, lon, night_score, searched_at)
			values ($1, $2, $3, $4, $5, $6, $7)
			on conflict (user_id, postcode) do update set
				area = excluded.area, lat = excluded.lat, lon = excluded.lon,
				night_score = coalesce(excluded.night_score, recent_searches.night_score),
				searched_at = excluded.searched_at`,
			userID, r.Postcode, r.Area, r.Lat, r.Lon, r.NightScore, r.At); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `
			delete from public.recent_searches where user_id = $1 and postcode in (
				select postcode from public.recent_searches where user_id = $1
				order by searched_at desc offset $2
			)`, userID, keep)
		return err
	})
}

func (p *Postgres) DeleteRecent(ctx context.Context, userID, postcode string) error {
	_, err := p.pool.Exec(ctx, `delete from public.recent_searches where user_id = $1 and ($2 = '' or postcode = $2)`, userID, postcode)
	return err
}

func (s *Memory) Recent(_ context.Context, userID string, limit int) ([]Recent, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := append([]Recent{}, s.recents[userID]...)
	sort.Slice(out, func(i, j int) bool { return out[i].At.After(out[j].At) })
	if len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

func (s *Memory) AddRecent(_ context.Context, userID string, r Recent, keep int) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	list := []Recent{r}
	for _, x := range s.recents[userID] {
		if x.Postcode != r.Postcode {
			list = append(list, x)
		} else if r.NightScore == nil {
			list[0].NightScore = x.NightScore
		}
	}
	sort.Slice(list, func(i, j int) bool { return list[i].At.After(list[j].At) })
	if len(list) > keep {
		list = list[:keep]
	}
	s.recents[userID] = list
	return nil
}

func (s *Memory) DeleteRecent(_ context.Context, userID, postcode string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if postcode == "" {
		delete(s.recents, userID)
		return nil
	}
	var keep []Recent
	for _, x := range s.recents[userID] {
		if x.Postcode != postcode {
			keep = append(keep, x)
		}
	}
	s.recents[userID] = keep
	return nil
}
