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
