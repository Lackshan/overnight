-- Applied on every API start; safe to re-run.
create table if not exists public.user_plans (
  user_id uuid primary key references auth.users (id) on delete cascade,
  plan text not null default 'free',
  stripe_customer_id text unique,
  stripe_subscription_id text,
  updated_at timestamptz not null default now()
);

-- The Go API connects as the postgres role and bypasses RLS. These policies
-- only matter if the browser ever reads the table directly with supabase-js.
alter table public.user_plans enable row level security;
drop policy if exists "Users can read their own plan" on public.user_plans;
create policy "Users can read their own plan" on public.user_plans
  for select using ((select auth.uid()) = user_id);

-- Small binary snapshots written by the API (e.g. recorded flight history).
create table if not exists public.blobs (
  key text primary key,
  data bytea not null,
  updated_at timestamptz not null default now()
);
alter table public.blobs enable row level security;

-- Each signed-in user's recent postcode searches.
create table if not exists public.recent_searches (
  user_id uuid not null references auth.users (id) on delete cascade,
  postcode text not null,
  area text not null default '',
  lat double precision not null,
  lon double precision not null,
  night_score integer,
  searched_at timestamptz not null default now(),
  primary key (user_id, postcode)
);
create index if not exists recent_searches_user_time on public.recent_searches (user_id, searched_at desc);
alter table public.recent_searches enable row level security;
drop policy if exists "Users can read their own recent searches" on public.recent_searches;
create policy "Users can read their own recent searches" on public.recent_searches
  for select using ((select auth.uid()) = user_id);

-- Flight history: totals per ~1 km grid cell, day of the week (Monday = 0)
-- and local hour. Servers only ever add to these, so several can share them.
create table if not exists public.flight_counts (
  cell integer not null,
  dow smallint not null check (dow between 0 and 6),
  hour smallint not null check (hour between 0 and 23),
  passes double precision not null default 0,
  low double precision not null default 0,
  helis double precision not null default 0,
  police_sec double precision not null default 0,
  amb_sec double precision not null default 0,
  primary key (cell, dow, hour)
);
-- Local date-hours with data ('2026-10-08T03'), so quiet hours count as zero.
create table if not exists public.flight_hours (
  date_hour text primary key
);
-- adsb.lol archive days already imported by cmd/backfill.
create table if not exists public.flight_backfills (
  day date primary key,
  added_at timestamptz not null default now()
);
alter table public.flight_counts enable row level security;
alter table public.flight_hours enable row level security;
alter table public.flight_backfills enable row level security;
