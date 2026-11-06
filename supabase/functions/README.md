# Edge Functions

Server code that needs secrets or runs on a schedule lives here (Deno/TypeScript, deployed with `npx supabase functions deploy`). Planned, in build-plan order:

| Function | What it does | Stage |
| --- | --- | --- |
| `generate-visits` | Nightly: turns active plans into dated visits | 1 |
| `send-text` | Sends On my way / Done / rain-day texts through Twilio, applying consent, quiet hours and STOP | 4 |
| `gps-daily` | Turns GPS points into trips, km and arrivals; deletes points older than 90 days | 3 |
| `invite` | Owner invites a dispatcher, or creates a crew tablet login | 2 |

Built so far: `admin-users`, `set-password`, `finance-report`, `fuel-prices` and `ingest`.

`ingest` takes jobs from Zapier (Yardbook, Jobber, Google Sheets) or any software that can send a web request, using an API key the owner makes in Settings → Connections. Deploy it with `--no-verify-jwt` (set in `config.toml`). Send one job or `{ "jobs": [...] }`; field names are matched loosely (date, customer, address, price, service, crew, minutes, area, job number). The same job number sent twice updates the job. Spreadsheet imports don't need a function: the office app reads the file in the browser and calls `import_jobs`.

`fuel-prices` looks up the area's average fuel price once a day for companies that turned on automatic prices, and when an owner taps "Check the price now":

- Canada: Statistics Canada table 18-10-0001-01 (monthly, by city, self-serve). No key needed.
- United States: EIA weekly retail prices (your state where EIA publishes one, otherwise your region). Needs `EIA_API_KEY`, free from https://www.eia.gov/opendata/register.php.
- Other countries: the owner types the price.

Fuel receipts that crews log always take priority over the area average for that period.

Secrets (Twilio, maps) are set with `npx supabase secrets set` and never committed.
