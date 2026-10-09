# Overnight

**What your London street is like at 3am.** You viewed the flat on a Saturday afternoon. Overnight shows the hours you didn't see: planes overhead, police and air ambulance helicopters, night buses, air quality and crime, hour by hour, from measured and live data.

- **Backend:** Go (`cmd/api`), one binary that also serves the built frontend
- **Frontend:** Vite + React + MapLibre GL on MapTiler raster tiles (`web/`)
- **Accounts:** Supabase Auth in the browser; the Go API verifies the token
- **Payments:** Stripe Checkout, test mode
- **Hosting:** Railway (Dockerfile)

## What's measured and what's estimated

| Section | Source | How |
|---|---|---|
| Planes overhead | adsb.lol ADS-B | **Measured.** Distinct aircraft below 10,000 ft within ~1.5 km, by hour, from archived days plus everything recorded live |
| Helicopters | adsb.lol ADS-B and MLAT | **Measured.** Minutes police (NPAS) and air ambulance helicopters spend overhead, by hour |
| Getting home | TfL Unified API | Night buses within 500 m, Night Tube lines (Fri and Sat), stations by day |
| Air | London Air Quality Network | **Measured.** Nearest monitor's average for each hour over the last 14 days |
| Safety after dark | data.police.uk | **Estimated** by hour: the police publish no times, so each crime is spread over the hours its type usually happens |
| Emergency help | NHS AmbSYS | **Sample figures** in `internal/sources/ambulance.json`. Paste in the latest London Ambulance Service numbers. |

Scores are heuristics in `internal/report/report.go`.

## Flight history

`internal/history` keeps a ~1 km grid over London with counts per hour of day.

- `go run ./cmd/backfill -days 2026-10-07,2026-10-08` streams adsb.lol's daily archive (~4 GB a day, nothing stored but the result) and writes `internal/history/seed.json.gz`, which is embedded in the binary. Each day takes about 10 minutes. More days means steadier averages.
- The running server records every position it sees and saves the grid every 10 minutes (to Supabase if `DATABASE_URL` is set, otherwise `./data`).

## Live aircraft

The server polls adsb.lol for everything within 40 nautical miles of London (every 5 s, backing off when rate-limited) and the browser polls the server every 2 s for whatever is in view. `web/src/motion.ts` draws each aircraft a few seconds in the past, where its next position is already known, along a curve that respects speed and heading at both ends. The delay grows and shrinks with the gap between updates, and any correction fades in rather than snapping. `npm --prefix web test` simulates noisy, rate-limited data and fails if anything jumps, stalls or snaps round.

**Police helicopters** are shown live, like other public trackers. `POLICE_DELAY` (e.g. `2m`) can hold their positions back if you want.

**Rate limits:** adsb.lol's free API rate-limits busy users. For production, feed them data (feeders get higher limits) or ask them about access.

## Who sees what: `features.yaml`

Every gated feature and limit lives in [features.yaml](features.yaml). There are three plans: `anonymous` (signed out), `free` (signed in) and `pro` (paying). The API strips anything a plan can't see, and the UI reads `GET /api/session` to show locks and pick "Sign up free" or "Go Pro". Edit the file and restart. Typos fail at startup.

| Feature | Guest | Free | Pro |
|---|---|---|---|
| Night and day scores, section summaries, live aircraft | ✓ | ✓ | ✓ |
| Section details, night flight paths map, live "happening nearby" feed | | ✓ | ✓ |
| Every hour of the night (timeline), crime by category | | | ✓ |

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
1. Product catalogue → add "Overnight Pro" with a recurring £4.99/month price. Copy the price ID to `STRIPE_PRICE_PRO`. For a one-off price instead, set `checkout_mode: payment` in `features.yaml`.
2. Developers → API keys → secret key to `STRIPE_SECRET_KEY`.
3. Developers → Webhooks → add endpoint `https://YOUR-APP/api/stripe/webhook` with events `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `customer.subscription.updated` and `customer.subscription.deleted`. Copy the signing secret to `STRIPE_WEBHOOK_SECRET`.
4. Optional: Settings → Billing → Customer portal → activate it so "Manage billing" works.
5. Pay with test card `4242 4242 4242 4242`, any future date, any CVC.

Locally, forward webhooks with the Stripe CLI: `stripe listen --forward-to localhost:8080/api/stripe/webhook`. Users are also upgraded the moment they land back on the app, so this is a backup.

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
| `POST /api/billing/checkout` | Start Stripe Checkout |
| `POST /api/billing/confirm` | Confirm a finished checkout (instant upgrade) |
| `POST /api/billing/portal` | Stripe customer portal |
| `POST /api/stripe/webhook` | Stripe events |

## Licence

See [LICENSE](LICENSE).
