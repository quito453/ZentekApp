# Cutting Cost

Field-service app for lawn care companies: a tablet app for crews and a web app for owners and dispatchers. English and Spanish, phone- and tablet-first, built to work with no signal. Canada first; rules for chemicals, texting and overtime are set per province or state.

The clickable demo of every screen is in [`demo/index.html`](demo/index.html) (open it in a browser). The real app is being built from it, stage by stage.

A separate finance-only concept, for companies that keep their CRM (Jobber, Yardbook…) and add Cutting Cost for the money side, is in [`demo/finance/index.html`](demo/finance/index.html). It has a Simple view and a Go deeper view, with sample data. It doesn't change the main demo.

A snow clearing version is in [`demo/snowplow/index.html`](demo/snowplow/index.html): storms instead of weekly visits, seasonal, per-push and hourly contracts, overtime in long storms, salt, the snowfall at which each seasonal contract breaks even, and cash through the salt pre-buy and the summer. Sample data for a made-up Ottawa-area company.

## What's here

| Folder | What it is | Runs on |
| --- | --- | --- |
| `apps/office` | Owner and dispatcher web app (React + Vite) | Netlify |
| `apps/crew` | Technician app (React + Vite, wrapped with Capacitor) | Android phones and tablets |
| `apps/desktop` | Desktop window around the office site (Electron) | Windows, Mac |
| `packages/shared` | Code both apps use: EN/ES text, the Done rules, the offline outbox, report periods, GPS arrival detection, route order, spreadsheet reading | both apps |
| `supabase/migrations` | Database tables and row-level security (who can see what) | Supabase |
| `supabase/tests` | Tests that run the real migrations and check every role's access | CI |
| `supabase/functions` | Server code that needs secrets: `admin-users`, `set-password`, `finance-report`, `fuel-prices`, `ingest` (and later Twilio, nightly jobs) | Supabase Edge Functions |
| `demo` | The clickable demo | Netlify (optional second site) |

## Accounts

- **Only the app owner creates logins and sets licences.** You (a platform admin) use the **App owner** tab in the office app: create a company with a licence count, add crews, and create logins (technician, dispatcher or owner) with a username and temporary password. Each login uses one licence; the database refuses more than the company has.
- **Owners and dispatchers cannot add or remove people.** They can only **set a new password**: dispatchers for technicians, owners for technicians and dispatchers.
- **Technicians sign in with a username and password.** "Forgot password" sends a request to the dispatcher's *Needs you* list, where they set a new password and tell the technician. No email is involved.
- Supabase Auth needs an email for each login, so a username becomes `<username>@<LOGIN_EMAIL_DOMAIN>`. Use a subdomain you own with no mailbox, e.g. `users.yourdomain.com`.

### Make yourself the app owner (once)

1. In Supabase Studio > Authentication, add your user (email + password).
2. In the SQL editor: `insert into app.platform_admins (user_id) values ('<your user id>');`
3. Sign in to the office app; the **App owner** tab appears.

## Finance (owners only)

Cutting Cost is finance-first: it can sit on top of the software a company already uses (Jobber, Yardbook, a spreadsheet) and work out what every job, customer, crew and kilometre really earns. Owners open the office app on **Today**; **Routes** and **Finance** come next. Dispatchers and technicians can't see any of the money, including pay rates (`supabase/tests/finance.test.ts` checks this).

**Costs are split the way owners think about them** (Costs tab):

| Variable (grows with every job) | Fixed (paid every month anyway) |
| --- | --- |
| Crew pay (paid time incl. driving × hourly cost) | Insurance, subscriptions, marketing, licences, rent… (owner's list) |
| Truck fuel (GPS km × L/100 km × fuel price) | Depreciation of trucks and mowers (value ÷ years ÷ 12) |
| Mower fuel (hours on site × share running × L/h × fuel price) | |
| Maintenance (per km driven + per mower engine hour) | |
| Materials | |

Fixed costs are prorated to the period and shared across jobs **in proportion to what each job earns**.

- **True profit by default.** Overview shows profit after every bill, with "Jobs made $X → $Y left after bills" under it. A folded panel lets owners try counting only part of the fixed costs.
- **Customers use profit from the job**, before rent and other bills: those don't drop when a customer leaves, so a lawn that covers its own crew time, fuel and wear is still helping pay them. The screen says so, and the CSV includes each customer's share of bills and profit after bills.
- **Overview** for a day, week, month or **season** (season months are set under Costs; default April–November): profit in one plain sentence, revenue, costs, profit per hour on site, "Needs a look", where the money went, where revenue came from, crews, "What if…" sliders and every job (CSV).
- **Customers:** by customer or by area — visits, revenue, time on site, drive time, profit, profit per visit and per hour. Rows under 85% of the company's average per hour are flagged; tap a customer for their visit history and the price per visit that would bring them to the average.
- **Payroll:** paid, regular and overtime hours per person, split into **on site / driving / other**, grouped under each crew. CSV for Excel or a payroll service.
- **Fuel & km:** every drive from one stop to the next per crew (left, arrived, minutes, GPS km, fuel to get there, time at the client), daily and per-trip CSV, and **GPS vs odometer** per truck per day (flagged when they differ by more than 10%).
- **Trucks and mowers:** give each crew its truck and mowers; L/100 km, L/hour and how much of the time on site a mower runs, value and years.
- **Fuel price:** automatic area averages from Statistics Canada (monthly, by city) or the U.S. EIA (weekly, by state or region) via the `fuel-prices` Edge Function; crews' fuel receipts override them.
- **Email reports:** weekly, monthly and **season** (the month after the season ends), plus "Email me … now", sent by `finance-report` through [Resend](https://resend.com). Secrets: `RESEND_API_KEY`, `REPORT_FROM`, `CRON_SECRET`, `OFFICE_URL`; schedule with `supabase/cron.example.sql`.

The SQL lives in `supabase/migrations/20261106000000_finance_first.sql` (`job_profit`, `finance_summary`, `customer_profit`, `crew_trips`, `gps_vs_odometer`, `payroll`), with a worked example you can check by hand in the test.

## Connections

Under Finance → Connections:

- **Mode.** *Finance only* (default): jobs live in other software; crews just sign in, type the odometer and keep location on. *Everything*: the full crew app with the truck checklist and Done buttons.
- **Spreadsheet import.** Any CSV with a date, customer, address and price (Jobber visits report, Yardbook jobs report, QuickBooks, Excel). Columns are guessed and can be changed; the preview shows which rows will be skipped and why. Past jobs come in as done; today's and future ones go on the crew's route. Customers are matched by name and properties by address. Reading the file happens in the browser (`packages/shared/src/importJobs.ts`); the insert is `public.import_jobs` (owner only).
- **Zapier / any software.** The owner makes an API key (only its hash is stored). Zapier (e.g. Yardbook → Job Completed) POSTs each job to the `ingest` Edge Function with `Authorization: Bearer cc_live_…`. Field names are matched loosely; the same job number twice updates the job. See `supabase/functions/README.md`.
- **Jobber direct** (GraphQL API with OAuth) needs a Jobber developer account and app approval; until then use Zapier or the visits report.

## Routes

Owners and dispatchers plan **tomorrow** or a crew's **regular weekday**: pick a crew, then drag the list (or use ↑ ↓), tap the stops on the map in driving order, or press **Shortest order** (nearest stop then 2-opt, `packages/shared/src/geo.ts`). Tap another crew's pin or use *Move to* to hand a stop over; add extras by address or skip stops. The panel shows km, drive time and fuel, and how much the new order saves. Tomorrow saves into `visits.route_order`; regular days into `route_plans`. Each crew's day has a short code like `C2-THU`.

The map uses Leaflet with OpenStreetMap tiles by default. For daily use set `VITE_MAP_TILES` (and `VITE_MAP_ATTRIBUTION`) to a tile provider you have an account with.

## Crew app: location, odometer, automatic arrivals

1. Sign in once.
2. **Location must be on.** Without it the app shows a blocking screen with the steps to turn it on.
3. **Start my day:** the truck's odometer (and, in Everything mode, the truck checklist).
4. **Today's stops:** GPS points are sent every minute through the outbox, and the tablet detects arriving at (2 minutes within 60 m) and leaving (2 minutes beyond 90 m) each property (`GeofenceDetector` in `packages/shared/src/geo.ts`). In Finance-only mode leaving the property finishes the job. Big *I'm here* / *Done* buttons are a backup.
5. **End my day:** the odometer again (it must not be lower than the morning's), then clock out.

**Background GPS.** On the Android app, `apps/crew/src/location.ts` uses `@capacitor-community/background-geolocation`: Android shows a "Cutting Cost is recording your route" notification and keeps recording with the screen off. The plugin adds its own location and foreground-service permissions to the manifest. `capacitor.config.ts` turns on the legacy bridge (so updates don't stop after 5 minutes in the background) and native HTTP (so points keep uploading). On Android 13 and later, allow notifications for the app so the notification shows. Points are kept every 15 s or 25 m, sent every 30 s through the outbox, and stored once each (`gps_points.client_id`). Mock-location apps are ignored. The plugin's docs list Capacitor up to 7 and this app uses 8, so test on a real tablet before rolling out.

**Live map (office).** **Live map** shows each truck at its last position, in plain words what each crew is doing (at a stop and for how long, driving to the next stop with an estimate, on a break, no signal for 5+ minutes, not clocked in), progress through the day's stops and km so far. Tap a crew for its trail and numbered stops. Positions arrive through Supabase Realtime; `public.live_crews` and `public.crew_trail` are office-only (tested in `supabase/tests/live.test.ts`). Positions are only recorded while a crew is clocked in.

## Live updates

The office app listens to Supabase Realtime: when a technician taps a button, a dispatcher closes an item or a password request comes in, every open office screen updates within about a second, with no refresh. It also reloads when the window regains focus, so a laptop that slept catches up. Row-level security still applies to every update.

## Who can see what

Every row belongs to a company. Row-level security in Postgres enforces it on every request, so a bug in an app can't leak another company's data.

| Role | Can do |
| --- | --- |
| Owner | Everything in their company, including Finance: profit, pay rates, payroll and email reports |
| Dispatcher | Schedule, crews, properties, records. No Finance, pay rates, fuel costs or plan prices |
| Technician | Its own crew's visits, and the properties and notes on them. Records progress, checklist, photos, GPS, shifts. Can't change prices, dates or which crew a job belongs to |
| App owner (you) | Creates companies, licences and logins; can set any password |

`supabase/tests/rls.test.ts` and `supabase/tests/accounts.test.ts` check each of these rules.

## Get started

You need Node 22 and a Supabase project (Canada Central region).

```bash
npm install
npm test                 # shared rules, offline outbox, database security rules
npm run dev:office       # http://127.0.0.1:5173
npm run dev:crew         # second port
```

Connect to Supabase:

1. Copy `apps/office/.env.example` to `apps/office/.env.local` (and the same for `apps/crew`). Fill in the project URL, the **anon** key (Project Settings > API) and `VITE_LOGIN_EMAIL_DOMAIN`. Never commit these files or use the service_role key in an app.
2. Apply the database: `npx supabase link --project-ref <your-ref>` then `npx supabase db push`.
3. Make yourself the app owner (below), then create the company and its logins from the **App owner** tab.

Sign-up is off (`supabase/config.toml`): only the app owner creates logins.

Edge Functions need three secrets: `npx supabase secrets set LOGIN_EMAIL_DOMAIN=users.yourdomain.com ALLOWED_ORIGINS=https://office.yourdomain.com,http://127.0.0.1:5173` (the service role key is provided by Supabase). Deploy them with `npx supabase functions deploy admin-users set-password finance-report fuel-prices`. For automatic U.S. fuel prices also set `EIA_API_KEY` (free from eia.gov/opendata).

## Deploy

- **Office app:** connect this repository in Netlify. `netlify.toml` builds `apps/office`. Add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` under Site configuration > Environment variables.
- **Demo (optional):** a second Netlify site from the same repository with base directory `demo`.
- **Office desktop app:** see `apps/desktop/README.md`. It opens the live office site in its own window, so Netlify updates reach desktop users immediately.
- **Technician app:** `npm run android -w @zentek/crew` builds the app and opens Android Studio (first time: `npx cap add android` in `apps/crew`). Install on tablets through Google Play or your device management.
- **Database:** `npx supabase db push` after a migration is merged to `main`. Use a separate staging project before production.

## Offline mode

The crew app updates the screen and the tablet's own storage first, then queues the change in the outbox (`packages/shared/src/outbox.ts`). The outbox:

- sends in the order things happened, and stops at a failure so nothing jumps the queue
- waits longer after each failed try (2 s, 4 s, 8 s … up to 5 minutes)
- drops items that are no longer useful, like an On my way text after the crew has arrived
- survives the app being closed

GPS points, odometer readings, clock in and clock out go through the same outbox. Right now it saves to localStorage. Before the pilot, the tablet store moves to SQLite or PowerSync, because photos and a day of GPS points need more room.

## Status

Stage 1 of the build plan: foundation, accounts and live updates. Next: owner/dispatcher screens on real data (Stage 2) and the full crew flow with photos, GPS and shifts (Stage 3).

## Ownership

Proprietary. All rights reserved.
