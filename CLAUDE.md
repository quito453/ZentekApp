# Working in this repository

- npm workspaces: `apps/office`, `apps/crew`, `packages/shared`. Run everything from the root.
- Before finishing a change: `npm run typecheck`, `npm test`, `npm run build`.
- Database changes go in a new file in `supabase/migrations/` (never edit one that has been pushed). Every new table gets `company_id`, RLS enabled, and policies for owner, dispatcher and crew; add a case to `supabase/tests/rls.test.ts`.
- Crew-facing text goes in both `packages/shared/src/i18n/en.json` and `es.json` (the i18n test fails if a Spanish key is missing). Keep crew text short and plain; buttons are big because crews use tablets outdoors.
- Anything the crew app changes is saved on the tablet first, then sent through the outbox. Never call Supabase directly from a crew button.
- Business rules shared by both apps (Done checks, next service) live in `packages/shared`, with tests.
- Never commit `.env` files or keys. The apps only ever use the Supabase anon key.
- `demo/index.html` is the clickable reference for how each screen should behave.
