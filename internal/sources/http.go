// Package sources talks to the public APIs. Every call is cached in memory so
// repeat lookups are instant and a flaky upstream doesn't break the demo.
package sources

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sync"
	"time"

	"golang.org/x/sync/singleflight"
)

var client = &http.Client{Timeout: 12 * time.Second}

func getJSON(ctx context.Context, url string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "overnight/0.1 (hackathon)")
	req.Header.Set("Accept", "application/json")
	res, err := client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(res.Body, 200))
		return &StatusError{Code: res.StatusCode, URL: url, Body: string(body)}
	}
	return json.NewDecoder(res.Body).Decode(out)
}

type StatusError struct {
	Code int
	URL  string
	Body string
}

func (e *StatusError) Error() string { return fmt.Sprintf("GET %s: %d %s", e.URL, e.Code, e.Body) }

// Cache is a TTL cache that collapses concurrent fetches of the same key and
// serves the last good value if a refresh fails.
type Cache[T any] struct {
	ttl   time.Duration
	mu    sync.Mutex
	items map[string]cached[T]
	group singleflight.Group
}

type cached[T any] struct {
	val T
	at  time.Time
}

func NewCache[T any](ttl time.Duration) *Cache[T] {
	return &Cache[T]{ttl: ttl, items: map[string]cached[T]{}}
}

func (c *Cache[T]) Get(ctx context.Context, key string, fetch func(context.Context) (T, error)) (T, error) {
	c.mu.Lock()
	item, ok := c.items[key]
	c.mu.Unlock()
	if ok && time.Since(item.at) < c.ttl {
		return item.val, nil
	}
	v, err, _ := c.group.Do(key, func() (any, error) {
		// Detach from the caller so one cancelled request doesn't fail the others.
		fctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 15*time.Second)
		defer cancel()
		return fetch(fctx)
	})
	if err != nil {
		if ok {
			return item.val, nil // stale beats nothing
		}
		var zero T
		return zero, err
	}
	val := v.(T)
	c.mu.Lock()
	c.items[key] = cached[T]{val: val, at: time.Now()}
	c.mu.Unlock()
	return val, nil
}
