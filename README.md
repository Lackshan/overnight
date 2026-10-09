# Overnight

**What your London street is like at 3am.** You viewed the flat on a Saturday afternoon. Overnight shows the hours you didn't see: planes overhead, police and air ambulance helicopters, night buses, air quality and crime, hour by hour, from measured and live data.

- **Backend:** Go (`cmd/api`), one binary that also serves the built frontend
- **Frontend:** Vite + React + MapLibre GL on MapTiler raster tiles (`web/`)
- **Accounts:** Supabase Auth in the browser; the Go API verifies the token
- **Payments:** Stripe Checkout, test mode
- **Ask Overnight:** Claude (Anthropic API) answers questions from the report's own data
- **Hosting:** Railway (Dockerfile)

## What's measured and what's estimated

| Section | Source | How |
|---|---|---|
| Planes overhead | adsb.lol ADS-B | **Measured.** Distinct aircraft below 10,000 ft within ~1.5 km, by hour, from archived days plus everything recorded live |
| Helicopters | adsb.lol ADS-B and MLAT | **Measured.** Minutes police (NPAS) and air ambulance helicopters spend overhead, by hour |
| Getting home | TfL Unified API | Night Tube stations from TfL night routes (Fri and Sat); all-night and 24-hour buses from real timetables, night by night; last weeknight buses |
| Air | London Air Quality Network | **Measured.** Nearest monitor's average for each hour over the last 14 days |
| Safety after dark | data.police.uk | **Estimated** by hour: the police publish no times, so each crime is spread over the hours its type usually happens |
| Emergency help | London Fire Brigade incident records, NHS England AmbSYS, A&E list | **Measured.** First fire engine arrival in your ward at night and by day (Jan 2024 to Jul 2026, via `cmd/firedata`); nearest 24-hour A&Es (`internal/sources/hospitals.json`); London Ambulance Service response times, fetched monthly from NHS England |
| Medical help | NHS England ODS, NHS trust pages | Nearest GP surgeries (all 1,142 active London practices, `cmd/gpdata`) with standard core hours, since practices don't publish theirs openly; 36 urgent treatment centres with their hours (`internal/sources/utcs.json`, compiled October 2026, shorter hours used where sources conflict); nearest A&E. Scored by what's open at each hour |

Scores are heuristics in `internal/report/report.go`.

## Flight history

Totals per ~1 km grid cell, day of the week and local hour, in three Supabase tables (created on startup from `internal/store/schema.sql`):

| Table | Holds |
|---|---|
| `flight_counts` | Aircraft passing, low passes, helicopters, police and air ambulance seconds, per cell × day of week × hour |
| `flight_hours` | Which local date-hours have data, so quiet hours count as zero rather than missing |
| `flight_backfills` | Archive days already imported, so none is imported twice |

- The server loads the totals into memory at startup and reloads them every 5 minutes, so pages stay instant.
- **Only one server records.** It adds its new counts every 5 minutes as "add these to the totals", never overwriting. Set `RECORD_HISTORY=false` everywhere else (for example on your laptop when the hosted app is running), or the same aircraft get counted twice.
- Backfill more archive days straight into the database: `go run ./cmd/backfill -days 2026-10-06,2026-10-07` (about 4 GB and 10 minutes a day; hours a live server already recorded are skipped).
- Without `DATABASE_URL`, the bundled `internal/history/seed.json.gz` is used and recordings go to `./data`. `go run ./cmd/backfill -file -days ...` rebuilds the seed.

## Refreshing the fire data

Download "LFB Incident data from 2024 onwards.xlsx" from the [London Datastore](https://data.london.gov.uk/dataset/london-fire-brigade-incident-records), then run `go run ./cmd/firedata path/to/file.xlsx`. It rewrites `internal/sources/lfb_wards.json` (about 140 KB), which is embedded in the API.

## Refreshing GP surgeries and urgent care

- GP practices: `go run ./cmd/gpdata` downloads NHS England's ODS list and geocodes it into `internal/sources/gps.json`.
- Urgent treatment centres: edit `internal/sources/utcs.json`. Hours look like `24/7` or `Mon-Fri 08:00-20:00; Sat-Sun 09:00-17:00`; a closing time past midnight (e.g. `08:00-02:00`) runs into the next day. The API refuses to start if any hours don't parse.

## Live aircraft

The server polls adsb.lol for everything within 40 nautical miles of London (every 5 s, backing off when rate-limited) and the browser polls the server every 2 s for whatever is in view. `web/src/motion.ts` draws each aircraft a few seconds in the past, where its next position is already known, along a curve that respects speed and heading at both ends. The delay grows and shrinks with the gap between updates, and any correction fades in rather than snapping. `npm --prefix web test` simulates noisy, rate-limited data and fails if anything jumps, stalls or snaps round.

**Police helicopters** are shown live, like other public trackers. `POLICE_DELAY` (e.g. `2m`) can hold their positions back if you want.

**Rate limits:** adsb.lol's free API rate-limits busy users. For production, feed them data (feeders get higher limits) or ask them about access.

## Who sees what: `features.yaml`

Every gated feature and limit lives in [features.yaml](features.yaml). There are three plans: `anonymous` (signed out), `free` (signed in) and `pro`, shown as "Supporter" (made the optional one-off payment). The API strips anything a plan can't see, and the UI reads `GET /api/session` to show locks and pick "Sign up free" or "Support". Edit the file and restart. Typos fail at startup.

| Feature | Guest | Free | Pro |
|---|---|---|---|
| Night and day scores, every hour of the night, crime by category, live aircraft, map layers | ✓ | ✓ | ✓ |
| Section details, flight paths map, night transport and medical cards, live feed, saved recent searches | | ✓ | ✓ |
| Ask Overnight: questions about a postcode, answered by Claude (10 a day free, 50 for supporters; supporters can also ask about a comparison) | | ✓ | ✓ |
| Compare up to 4 postcodes side by side: scores, hour by hour, sections and key facts, with lettered map pins and a shareable `/compare?pc=` link | | | ✓ |

## Run locally

Needs Go 1.27+ and Node 24+.

```bash
cp .env.example .env
cd web && npm install && npm run build && cd ..
set -a; . ./.env; set +a; go run ./cmd/api
```

Open http://localhost:8080. With `DEV_MODE=true` there's a **View as** switcher to try each plan without signing in or paying. Add `?debug` to the URL to get the map as `window.overnightMap` in the console.

For frontend hot reload, also run `cd web && npm run dev` and open http://localhost:5173 (it proxies `/api` to the Go server).

Without keys: no Supabase means everyone is a guest, no Stripe means the upgrade button explains payments aren't set up, and no MapTiler key falls back to OpenStreetMap tiles (fine for dev, not for production traffic).

## Set up the services

### Supabase
1. Create a project in **London (eu-west-2)**.
2. Project Settings → API: copy the URL and anon key into `SUPABASE_URL`, `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.
3. Connect → **Session pooler** connection string → `DATABASE_URL`. The API creates its tables on startup.
4. For the demo: Authentication → Providers → Email → turn off "Confirm email" so sign-up logs straight in.

### Stripe (test mode)
Overnight is free; supporters make an optional one-off payment (£2.49) and get postcode comparisons.

1. Product catalogue → add "Overnight supporter" with a **one-off** £2.49 price. Copy the price ID (`price_...`) to `STRIPE_PRICE_PRO`.
2. Developers → API keys → secret key (`sk_test_...`) to `STRIPE_SECRET_KEY`.
3. Developers → Webhooks → add endpoint `https://YOUR-APP/api/stripe/webhook` with events `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `charge.refunded` and `charge.dispute.created`. Copy the signing secret to `STRIPE_WEBHOOK_SECRET`. A full refund or a dispute takes supporter status away again.
4. Pay with test card `4242 4242 4242 4242`, any future date, any CVC.

Locally, forward webhooks with the Stripe CLI: `stripe listen --forward-to localhost:8080/api/stripe/webhook --events checkout.session.completed,checkout.session.async_payment_succeeded,charge.refunded,charge.dispute.created`. Supporters are also upgraded the moment they land back on the app, so this is a backup. To switch to a subscription instead, set `checkout_mode: subscription` in `features.yaml` and add the `customer.subscription.updated` and `customer.subscription.deleted` events.

### Claude (Ask Overnight)
Create a key at console.anthropic.com and set `ANTHROPIC_API_KEY`. Without it the Ask box doesn't appear. The model defaults to `claude-sonnet-5-5`; set `ANTHROPIC_MODEL` to change it.

Claude gets the report exactly as the caller's plan sees it (scores, hourly values, sections, details, key facts and what's live right now, but no map layers), so it can't reveal anything locked. That's about 3,000 tokens per postcode. It's sent as a cached system block, so follow-up questions are cheaper. Each answer logs its token use. The daily cap is `ask.questions_per_day` in `features.yaml`, counted in memory per account (or IP), and a failed answer doesn't count.

### MapTiler
Create a key, restrict it to your Railway domain (and localhost), and set `VITE_MAPTILER_KEY`. The map uses the `dataviz` and `dataviz-dark` styles.

### Railway
1. New project → Deploy from GitHub repo (or `railway up`). It builds with the `Dockerfile`.
2. Settings → Region: **EU West (Amsterdam)**, the closest to London.
3. Variables: everything from `.env.example`, with `APP_URL` set to the Railway domain and `DEV_MODE` unset.
4. Networking → Generate domain, then use it for the Stripe webhook and MapTiler key restriction.

## API

| Endpoint | Purpose |
|---|---|
| `GET /api/session` | Your plan, what each feature looks like for you, limits, prices |
| `GET /api/report/{postcode}` | The hour-by-hour report, stripped to your plan |
| `GET /api/live?lat=&lon=&lines=` | Aircraft (with timestamps), nearby events and line status |
| `POST /api/ask` | `{"postcodes":["SW111AA"],"messages":[{"role":"user","text":"..."}]}`; streams the answer as lines of JSON: `{"left":n}`, `{"text":"..."}` pieces, then `{"done":true}` or `{"error":"..."}` |
| `GET /api/compare?pc=E16AN,SW111AA` | Supporters: scores, hourly line, section scores and key facts for up to `compare.postcodes` postcodes (the app asks for one at a time so each column fills in as soon as it's ready) |
| `POST /api/billing/checkout` | Start Stripe Checkout |
| `POST /api/billing/confirm` | Confirm a finished checkout (instant upgrade) |
| `POST /api/billing/portal` | Stripe customer portal |
| `POST /api/stripe/webhook` | Stripe events |

## Licence

See [LICENSE](LICENSE).
