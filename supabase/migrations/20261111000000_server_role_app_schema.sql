-- The Edge Functions (service role) write rows through Supabase's data API, which names each column's
-- type, e.g. memberships.role is app.role. Without USAGE on the app schema, creating a login failed
-- with "permission denied for schema app". The service role already bypasses row-level security;
-- this only lets it use the app schema's types and helper functions.
grant usage on schema app to service_role;
grant execute on all functions in schema app to service_role;
alter default privileges in schema app grant execute on functions to service_role;

-- Pin the search path on the two helpers the Supabase security check flagged.
alter function app.touch_updated_at() set search_path = '';
alter function app.km_between(float8, float8, float8, float8) set search_path = '';
