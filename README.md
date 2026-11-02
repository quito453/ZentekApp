# Zentek

Field-service app for lawn care companies: a tablet app for crews and a web app for owners and dispatchers. English and Spanish, phone- and tablet-first, built to work with no signal. Canada first; rules for chemicals, texting and overtime are set per province or state.

The clickable demo of every screen is in [`demo/index.html`](demo/index.html) (open it in a browser). The real app is being built from it, stage by stage.

## What's here

| Folder | What it is | Runs on |
| --- | --- | --- |
| `apps/office` | Owner and dispatcher web app (React + Vite) | Netlify |
| `apps/crew` | Technician app (React + Vite, wrapped with Capacitor) | Android phones and tablets |
| `apps/desktop` | Desktop window around the office site (Electron) | Windows, Mac |
| `packages/shared` | Code both apps use: EN/ES text, the Done rules, the offline outbox | both apps |
| `supabase/migrations` | Database tables and row-level security (who can see what) | Supabase |
| `supabase/tests` | Tests that run the real migrations and check every role's access | CI |
| `supabase/functions` | Server code that needs secrets: `admin-users`, `set-password` (and later Twilio, nightly jobs) | Supabase Edge Functions |
| `demo` | The clickable demo | Netlify (optional second site) |

## Accounts

- **Only the app owner creates logins and sets licences.** You (a platform admin) use the **App owner** tab in the office app: create a company with a licence count, add crews, and create logins (technician, dispatcher or owner) with a username and temporary password. Each login uses one licence; the database refuses more than the company has.
- **Owners and dispatchers cannot add or remove people.** They can only **set a new password**: dispatchers for technicians, owners for technicians and dispatchers.
- **Technicians sign in with a username and password.** "Forgot password" sends a request to the dispatcher's *Needs you* list, where they set a new password and tell the technician. No email is involved.
- Supabase Auth needs an email for each login, so a username becomes `<username>@<LOGIN_EMAIL_DOMAIN>`. Use a subdomain you own with no mailbox, e.g. `users.zentekapp.com`.

### Make yourself the app owner (once)

1. In Supabase Studio > Authentication, add your user (email + password).
2. In the SQL editor: `insert into app.platform_admins (user_id) values ('<your user id>');`
3. Sign in to the office app; the **App owner** tab appears.

## Live updates

The office app listens to Supabase Realtime: when a technician taps a button, a dispatcher closes an item or a password request comes in, every open office screen updates within about a second, with no refresh. It also reloads when the window regains focus, so a laptop that slept catches up. Row-level security still applies to every update.

## Who can see what

Every row belongs to a company. Row-level security in Postgres enforces it on every request, so a bug in an app can't leak another company's data.

| Role | Can do |
| --- | --- |
| Owner | Everything in their company, including fuel costs and prices |
| Dispatcher | Schedule, crews, properties, records. No fuel or plan prices |
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

Edge Functions need three secrets: `npx supabase secrets set LOGIN_EMAIL_DOMAIN=users.zentekapp.com ALLOWED_ORIGINS=https://office.zentekapp.com,http://127.0.0.1:5173` (the service role key is provided by Supabase). Deploy them with `npx supabase functions deploy admin-users set-password`.

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

Right now it saves to localStorage. Before the pilot, the tablet store moves to SQLite or PowerSync, because photos and a day of GPS points need more room.

## Status

Stage 1 of the build plan: foundation, accounts and live updates. Next: owner/dispatcher screens on real data (Stage 2) and the full crew flow with photos, GPS and shifts (Stage 3).

## Ownership

Proprietary. All rights reserved.
