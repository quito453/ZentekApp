-- Local development seed. Runs after migrations on `npx supabase db reset`.
-- Users are created through Supabase Auth (Studio > Authentication), then linked here, e.g.:
--
-- insert into public.companies (id, name, region) values ('00000000-0000-0000-0000-000000000001', 'Green Ridge Lawn & Snow', 'ON');
-- insert into public.crews (id, company_id, name) values ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-000000000001', 'Crew 2');
-- insert into public.memberships (user_id, company_id, role) values ('<owner auth user id>', '00000000-0000-0000-0000-000000000001', 'owner');
-- insert into public.memberships (user_id, company_id, role, crew_id) values ('<tablet auth user id>', '00000000-0000-0000-0000-000000000001', 'crew', '00000000-0000-0000-0000-0000000000c2');
select 1;
