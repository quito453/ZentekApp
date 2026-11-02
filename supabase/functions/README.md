# Edge Functions

Server code that needs secrets or runs on a schedule lives here (Deno/TypeScript, deployed with `npx supabase functions deploy`). Planned, in build-plan order:

| Function | What it does | Stage |
| --- | --- | --- |
| `generate-visits` | Nightly: turns active plans into dated visits | 1 |
| `send-text` | Sends On my way / Done / rain-day texts through Twilio, applying consent, quiet hours and STOP | 4 |
| `gps-daily` | Turns GPS points into trips, km and arrivals; deletes points older than 90 days | 3 |
| `invite` | Owner invites a dispatcher, or creates a crew tablet login | 2 |

Secrets (Twilio, maps) are set with `npx supabase secrets set` and never committed.
