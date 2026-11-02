-- Schedule the owners' email reports. Run once in the Supabase SQL editor after deploying the
-- finance-report function (needs the pg_cron and pg_net extensions: Database > Extensions).
-- Not a migration because it contains your project's address and secret.
--
-- Runs every day at 12:00 UTC (7–8 am Eastern). The function sends only the reports that are due
-- that day in each company's time zone: weekly on the owner's chosen weekday, monthly on the 1st.

select cron.schedule(
  'finance-reports',
  '0 12 * * *',
  $$
  select net.http_post(
    url := 'https://<your-project-ref>.supabase.co/functions/v1/finance-report',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', '<same value as the CRON_SECRET secret>'),
    body := '{}'::jsonb
  );
  $$
);
