// Package store remembers which plan each user is on. It uses Supabase
// Postgres when DATABASE_URL is set and an in-memory map otherwise (local dev).
package store

import (
	"context"
	_ "embed"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Account struct {
	UserID         string
	Plan           string
	CustomerID     string
	SubscriptionID string
}

type Store interface {
	// Get returns the user's account, or nil if they've never paid.
	Get(ctx context.Context, userID string) (*Account, error)
	Put(ctx context.Context, a Account) error
	ByCustomer(ctx context.Context, customerID string) (*Account, error)
	// Blobs hold small binary snapshots, like the recorded flight history.
	GetBlob(ctx context.Context, key string) ([]byte, error)
	PutBlob(ctx context.Context, key string, data []byte) error
}

//go:embed schema.sql
var schema string

type Postgres struct{ pool *pgxpool.Pool }

func NewPostgres(ctx context.Context, url string) (*Postgres, error) {
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		return nil, err
	}
	// Supabase's transaction pooler doesn't support prepared statements.
	cfg.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeSimpleProtocol
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if _, err := pool.Exec(ctx, schema); err != nil {
		pool.Close()
		return nil, err
	}
	return &Postgres{pool: pool}, nil
}

const cols = `user_id::text, plan, coalesce(stripe_customer_id,''), coalesce(stripe_subscription_id,'')`

func scan(row pgx.Row) (*Account, error) {
	var a Account
	err := row.Scan(&a.UserID, &a.Plan, &a.CustomerID, &a.SubscriptionID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &a, nil
}

func (p *Postgres) Get(ctx context.Context, userID string) (*Account, error) {
	return scan(p.pool.QueryRow(ctx, `select `+cols+` from public.user_plans where user_id = $1`, userID))
}

func (p *Postgres) ByCustomer(ctx context.Context, customerID string) (*Account, error) {
	return scan(p.pool.QueryRow(ctx, `select `+cols+` from public.user_plans where stripe_customer_id = $1`, customerID))
}

func (p *Postgres) Put(ctx context.Context, a Account) error {
	_, err := p.pool.Exec(ctx, `
		insert into public.user_plans (user_id, plan, stripe_customer_id, stripe_subscription_id, updated_at)
		values ($1, $2, nullif($3,''), nullif($4,''), now())
		on conflict (user_id) do update set
			plan = excluded.plan,
			stripe_customer_id = coalesce(excluded.stripe_customer_id, user_plans.stripe_customer_id),
			stripe_subscription_id = coalesce(excluded.stripe_subscription_id, user_plans.stripe_subscription_id),
			updated_at = now()`,
		a.UserID, a.Plan, a.CustomerID, a.SubscriptionID)
	return err
}

func (p *Postgres) GetBlob(ctx context.Context, key string) ([]byte, error) {
	var data []byte
	err := p.pool.QueryRow(ctx, `select data from public.blobs where key = $1`, key).Scan(&data)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	return data, err
}

func (p *Postgres) PutBlob(ctx context.Context, key string, data []byte) error {
	_, err := p.pool.Exec(ctx, `
		insert into public.blobs (key, data, updated_at) values ($1, $2, now())
		on conflict (key) do update set data = excluded.data, updated_at = now()`, key, data)
	return err
}

// Memory keeps plans in memory and blobs in files under dir, for local dev.
type Memory struct {
	dir string
	mu  sync.Mutex
	m   map[string]Account
}

func NewMemory(dir string) *Memory { return &Memory{dir: dir, m: map[string]Account{}} }

func (s *Memory) GetBlob(_ context.Context, key string) ([]byte, error) {
	data, err := os.ReadFile(filepath.Join(s.dir, key))
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	return data, err
}

func (s *Memory) PutBlob(_ context.Context, key string, data []byte) error {
	if err := os.MkdirAll(s.dir, 0o755); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(s.dir, key), data, 0o644)
}

func (s *Memory) Get(_ context.Context, userID string) (*Account, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if a, ok := s.m[userID]; ok {
		return &a, nil
	}
	return nil, nil
}

func (s *Memory) ByCustomer(_ context.Context, customerID string) (*Account, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, a := range s.m {
		if a.CustomerID == customerID {
			return &a, nil
		}
	}
	return nil, nil
}

func (s *Memory) Put(_ context.Context, a Account) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if old, ok := s.m[a.UserID]; ok {
		if a.CustomerID == "" {
			a.CustomerID = old.CustomerID
		}
		if a.SubscriptionID == "" {
			a.SubscriptionID = old.SubscriptionID
		}
	}
	s.m[a.UserID] = a
	return nil
}
