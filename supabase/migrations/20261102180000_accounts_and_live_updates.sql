-- Accounts, licences and live updates
--
-- Who creates logins: only the app owner (a platform admin). Company owners and dispatchers
-- cannot create users or change licence counts; they can only set a new password for the
-- technicians in their company (and owners for their dispatchers), through the set-password
-- Edge Function.
--
-- Technicians sign in with a username and password. A technician who forgets the password
-- taps "Forgot password": that opens a request in the dispatcher's "Needs you" list.

-- ───────────────────────────── app owner (platform admin) ─────────────────────────────
create table app.platform_admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);
-- No grants: only the database owner and the service role can read or change this table.
revoke all on app.platform_admins from public, authenticated, anon;

create or replace function app.is_platform_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from app.platform_admins a where a.user_id = auth.uid());
$$;

-- Callable through the API (the apps and Edge Functions ask "am I the app owner?").
create or replace function public.is_platform_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select app.is_platform_admin();
$$;
revoke all on function public.is_platform_admin() from public, anon;
grant execute on function public.is_platform_admin() to authenticated;

-- ───────────────────────────── licences ─────────────────────────────
alter table public.companies add column seat_limit int not null default 0 check (seat_limit >= 0);
alter table public.companies add column active boolean not null default true;

-- Company owners may still edit their company's details, but not its licences or status.
create or replace function app.guard_company_update() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or app.is_platform_admin() then
    return new;
  end if;
  if new.seat_limit is distinct from old.seat_limit or new.active is distinct from old.active then
    raise exception 'only the app owner can change licences' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger companies_guard before update on public.companies
  for each row execute function app.guard_company_update();

-- Every login in a company uses one licence. Enforced for everyone, including server code.
create or replace function app.enforce_seat_limit() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  used int;
  lim int;
begin
  select c.seat_limit into lim from public.companies c where c.id = new.company_id;
  select count(*) into used from public.memberships m where m.company_id = new.company_id;
  if used > coalesce(lim, 0) then
    raise exception 'licence limit reached for this company (% of %)', used, lim using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger memberships_seat_limit after insert on public.memberships
  for each row execute function app.enforce_seat_limit();

-- ───────────────────────────── usernames ─────────────────────────────
create table public.profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  company_id uuid not null references public.companies (id) on delete cascade,
  username text not null unique check (username ~ '^[a-z0-9][a-z0-9._-]{2,31}$'),
  full_name text not null,
  crew_member_id uuid references public.crew_members (id) on delete set null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
alter table public.profiles enable row level security;
grant select, insert, update, delete on public.profiles to authenticated;

create policy profiles_self on public.profiles for select to authenticated
  using (user_id = auth.uid());
create policy profiles_office_read on public.profiles for select to authenticated
  using (app.is_office(company_id));
create policy profiles_admin on public.profiles for all to authenticated
  using (app.is_platform_admin()) with check (app.is_platform_admin());

-- ───────────────────────────── who manages logins ─────────────────────────────
-- Owners used to manage memberships; now only the app owner does.
drop policy memberships_owner_write on public.memberships;
drop policy memberships_self on public.memberships;
create policy memberships_read on public.memberships for select to authenticated
  using (user_id = auth.uid() or app.is_office(company_id));
create policy memberships_admin on public.memberships for all to authenticated
  using (app.is_platform_admin()) with check (app.is_platform_admin());

create policy companies_admin on public.companies for all to authenticated
  using (app.is_platform_admin()) with check (app.is_platform_admin());
create policy crews_admin on public.crews for all to authenticated
  using (app.is_platform_admin()) with check (app.is_platform_admin());

-- Can the signed-in user set a new password for this login?
--   app owner: anyone
--   company owner: technicians and dispatchers in their company
--   dispatcher: technicians in their company
-- Nobody resets their own password this way, and nobody reaches another company.
create or replace function public.can_reset_password(p_target uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select app.is_platform_admin() or exists (
    select 1
    from public.memberships t
    join public.memberships me on me.company_id = t.company_id and me.user_id = auth.uid()
    where t.user_id = p_target
      and t.user_id <> auth.uid()
      and (
        (me.role in ('owner', 'dispatcher') and t.role = 'crew')
        or (me.role = 'owner' and t.role = 'dispatcher')
      )
  );
$$;
revoke all on function public.can_reset_password(uuid) from public, anon;
grant execute on function public.can_reset_password(uuid) to authenticated;

-- ───────────────────────────── forgot password ─────────────────────────────
alter table public.office_items add column subject_user_id uuid references auth.users (id) on delete cascade;

-- Called from the sign-in screen, before anyone is signed in. It always returns nothing, so it
-- never reveals whether a username exists. One open request per person at a time.
create or replace function public.request_password_reset(p_username text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  p public.profiles;
  crew uuid;
begin
  if p_username is null or length(p_username) > 64 then
    return;
  end if;
  select * into p from public.profiles where username = lower(trim(p_username)) and active;
  if not found then
    return;
  end if;
  if exists (
    select 1 from public.office_items i
    where i.subject_user_id = p.user_id and i.kind = 'password_reset' and i.status = 'open'
  ) then
    return;
  end if;
  select m.crew_id into crew from public.memberships m where m.user_id = p.user_id and m.company_id = p.company_id;
  insert into public.office_items (company_id, kind, crew_id, title, body, subject_user_id, created_by)
  values (p.company_id, 'password_reset', crew, 'Password reset: ' || p.full_name, p.username, p.user_id, null);
end;
$$;
revoke all on function public.request_password_reset(text) from public;
grant execute on function public.request_password_reset(text) to anon, authenticated;

-- ───────────────────────────── live updates ─────────────────────────────
-- Supabase Realtime sends row changes to the office app as they happen. RLS still applies:
-- each screen only receives rows its login is allowed to read.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table
      public.visits, public.office_items, public.shifts, public.shift_pauses,
      public.leads, public.property_notes, public.gps_points;
  end if;
end;
$$;
