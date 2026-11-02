-- Zentek initial schema
-- Multi-company: every business row carries company_id, and row-level security (RLS)
-- limits each signed-in user to their own company and role.
--
-- Roles
--   owner       everything in their company, including money (fuel, prices, revenue)
--   dispatcher  schedule, crews, properties, records; no fuel/finance tables
--   crew        a crew tablet login, tied to one crew: its own visits and the
--               properties on them, and it can record work, photos, GPS and shifts

create schema if not exists app;

-- ───────────────────────────── types ─────────────────────────────
create type app.role as enum ('owner', 'dispatcher', 'crew');
create type app.plan_frequency as enum ('weekly', 'biweekly', 'seasonal', 'one_time');
create type app.visit_status as enum ('scheduled', 'en_route', 'on_site', 'done', 'blocked', 'moved', 'skipped');
create type app.visit_source as enum ('plan', 'new_customer', 'lead_won', 'redo', 'rescheduled', 'crew_recommended');
create type app.note_kind as enum ('gate', 'pet', 'parking', 'sprinkler', 'other');
create type app.photo_kind as enum ('before', 'after', 'lead', 'receipt', 'odometer', 'issue');
create type app.pause_kind as enum ('break', 'lunch');
create type app.item_status as enum ('open', 'closed');
create type app.text_status as enum ('queued', 'sent', 'held_quiet_hours', 'not_sent_no_consent', 'not_sent_too_late', 'failed');

-- ───────────────────────────── companies and people ─────────────────────────────
create table public.companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  country text not null default 'CA',
  region text not null,                      -- province or state, e.g. 'ON'; drives compliance rules
  timezone text not null default 'America/Toronto',
  units text not null default 'metric' check (units in ('metric', 'imperial')),
  fuel_price_per_l numeric(6, 3),
  created_at timestamptz not null default now()
);

create table public.crews (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  name text not null,
  color text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- A login's role in a company. Crew logins are tablets: one per crew.
create table public.memberships (
  user_id uuid not null references auth.users (id) on delete cascade,
  company_id uuid not null references public.companies (id) on delete cascade,
  role app.role not null,
  crew_id uuid references public.crews (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (user_id, company_id),
  check ((role = 'crew') = (crew_id is not null))
);

-- People on a crew (not logins). Used for hours, licences and "done by".
create table public.crew_members (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  crew_id uuid references public.crews (id) on delete set null,
  full_name text not null,
  phone text,
  language text not null default 'en' check (language in ('en', 'es', 'fr')),
  applicator_licence text,                   -- pesticide applicator licence number, if any
  licence_expires_on date,
  active boolean not null default true
);

create table public.trucks (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  crew_id uuid references public.crews (id) on delete set null,
  name text not null,
  l_per_100km numeric(5, 2),
  idle_l_per_h numeric(4, 2)
);

-- ───────────────────────────── customers and properties ─────────────────────────────
create table public.customers (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  full_name text not null,
  phone text,
  email text,
  language text not null default 'en' check (language in ('en', 'es', 'fr')),
  text_consent boolean not null default false,
  text_consent_at timestamptz,
  text_consent_source text,                  -- how consent was given, in the customer's own words where possible
  opted_out_at timestamptz,                  -- STOP received; never text again
  created_at timestamptz not null default now()
);

create table public.properties (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  customer_id uuid not null references public.customers (id) on delete cascade,
  address text not null,
  lat double precision,
  lng double precision,
  customer_since date,
  created_at timestamptz not null default now()
);

-- Gate codes, pets, parking, sprinklers. Stored in each language so crews read their own.
create table public.property_notes (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  property_id uuid not null references public.properties (id) on delete cascade,
  kind app.note_kind not null,
  text_en text not null,
  text_es text,
  short_label text,
  created_by uuid references auth.users (id) default auth.uid(),
  created_at timestamptz not null default now()
);

create table public.services (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  key text not null,                         -- 'regular', 'leaf_cleanup', 'aeration', ...
  name_en text not null,
  name_es text,
  tasks text[] not null default '{}',        -- checklist items, e.g. {mow,edge,trim,blow}
  default_minutes int not null default 30,
  needs_materials boolean not null default false,
  unique (company_id, key)
);

create table public.plans (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  property_id uuid not null references public.properties (id) on delete cascade,
  service_id uuid not null references public.services (id),
  frequency app.plan_frequency not null,
  price_cents int not null check (price_cents >= 0),
  default_crew_id uuid references public.crews (id) on delete set null,
  starts_on date not null,
  ends_on date,
  active boolean not null default true
);

-- ───────────────────────────── visits (jobs) ─────────────────────────────
create table public.visits (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  property_id uuid not null references public.properties (id) on delete cascade,
  plan_id uuid references public.plans (id) on delete set null,
  service_id uuid not null references public.services (id),
  source app.visit_source not null default 'plan',
  scheduled_on date not null,
  crew_id uuid references public.crews (id) on delete set null,
  route_order int,
  est_minutes int not null default 30,
  price_cents int not null default 0,
  status app.visit_status not null default 'scheduled',
  en_route_at timestamptz,
  arrived_at timestamptz,
  done_at timestamptz,
  blocked_reason text,
  next_service_key text,                     -- crew's recommendation at Done
  next_service_on date,
  next_service_note text,
  office_note text,
  updated_at timestamptz not null default now()
);
create index visits_company_day on public.visits (company_id, scheduled_on);
create index visits_crew_day on public.visits (crew_id, scheduled_on);

create table public.visit_checks (
  visit_id uuid not null references public.visits (id) on delete cascade,
  company_id uuid not null references public.companies (id) on delete cascade,
  task text not null,
  done_at timestamptz not null default now(),
  primary key (visit_id, task)
);

create table public.photos (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  crew_id uuid references public.crews (id) on delete set null,
  visit_id uuid references public.visits (id) on delete cascade,
  kind app.photo_kind not null,
  storage_path text not null,                -- path in the private 'photos' storage bucket
  taken_at timestamptz not null,
  lat double precision,
  lng double precision
);

create table public.material_applications (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  visit_id uuid not null references public.visits (id) on delete cascade,
  crew_id uuid references public.crews (id) on delete set null,
  product text not null,
  registration_no text,
  amount numeric(10, 3) not null,
  unit text not null check (unit in ('kg', 'g', 'L', 'mL', 'lb', 'oz', 'gal')),
  area_m2 numeric(10, 1),
  weather text,
  applicator_member_id uuid references public.crew_members (id),
  applied_at timestamptz not null default now()
);

-- ───────────────────────────── shifts, GPS, fuel ─────────────────────────────
create table public.shifts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  crew_id uuid not null references public.crews (id) on delete cascade,
  clock_in_at timestamptz not null,
  clock_out_at timestamptz,
  checklist jsonb not null default '{}'::jsonb,   -- start-of-shift checklist answers
  check (clock_out_at is null or clock_out_at >= clock_in_at)
);

create table public.shift_pauses (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  shift_id uuid not null references public.shifts (id) on delete cascade,
  crew_id uuid not null references public.crews (id) on delete cascade,
  kind app.pause_kind not null,
  started_at timestamptz not null,
  ended_at timestamptz,
  check (ended_at is null or ended_at >= started_at)
);

-- Raw points are deleted after 90 days by a scheduled job; daily totals are kept.
create table public.gps_points (
  id bigint generated always as identity primary key,
  company_id uuid not null references public.companies (id) on delete cascade,
  crew_id uuid not null references public.crews (id) on delete cascade,
  shift_id uuid references public.shifts (id) on delete set null,
  recorded_at timestamptz not null,
  lat double precision not null,
  lng double precision not null,
  accuracy_m real,
  speed_mps real
);
create index gps_points_crew_time on public.gps_points (crew_id, recorded_at);

create table public.fuel_receipts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  truck_id uuid references public.trucks (id) on delete set null,
  crew_id uuid references public.crews (id) on delete set null,
  litres numeric(7, 2) not null,
  amount_cents int not null,
  photo_id uuid references public.photos (id) on delete set null,
  bought_at timestamptz not null default now()
);

create table public.odometer_readings (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  truck_id uuid not null references public.trucks (id) on delete cascade,
  crew_id uuid references public.crews (id) on delete set null,
  reading_km int not null,
  photo_id uuid references public.photos (id) on delete set null,
  read_at timestamptz not null default now()
);

-- ───────────────────────────── office items, leads, equipment, texts ─────────────────────────────
-- "Needs you": can't-finish tasks, skip requests, complaints, missed clock-outs, equipment problems.
create table public.office_items (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  kind text not null,
  visit_id uuid references public.visits (id) on delete set null,
  crew_id uuid references public.crews (id) on delete set null,
  title text not null,
  body text,
  status app.item_status not null default 'open',
  created_by uuid references auth.users (id) default auth.uid(),
  created_at timestamptz not null default now(),
  closed_at timestamptz
);

create table public.leads (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  property_id uuid not null references public.properties (id) on delete cascade,
  visit_id uuid references public.visits (id) on delete set null,
  crew_id uuid references public.crews (id) on delete set null,
  kind text not null,                        -- 'aeration', 'dead_shrub', ...
  note text,
  photo_id uuid references public.photos (id) on delete set null,
  status text not null default 'new' check (status in ('new', 'quoted', 'won', 'lost', 'not_now')),
  created_at timestamptz not null default now()
);

create table public.equipment (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  crew_id uuid references public.crews (id) on delete set null,
  name text not null,
  engine_hours numeric(8, 1),
  service_due_hours numeric(8, 1)
);

create table public.texts_log (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  customer_id uuid references public.customers (id) on delete set null,
  visit_id uuid references public.visits (id) on delete set null,
  kind text not null check (kind in ('on_my_way', 'done', 'rain_day', 'other')),
  status app.text_status not null default 'queued',
  body text not null,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

-- ───────────────────────────── helper functions for RLS ─────────────────────────────
-- security definer so policies can read memberships without recursing into its own RLS.
create or replace function app.has_role(p_company uuid, variadic p_roles app.role[])
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.memberships m
    where m.user_id = auth.uid() and m.company_id = p_company and m.role = any (p_roles)
  );
$$;

create or replace function app.is_office(p_company uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select app.has_role(p_company, 'owner', 'dispatcher');
$$;

create or replace function app.is_owner(p_company uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select app.has_role(p_company, 'owner');
$$;

-- The crew a tablet login belongs to in this company (null for office users).
create or replace function app.my_crew(p_company uuid)
returns uuid language sql stable security definer set search_path = '' as $$
  select m.crew_id from public.memberships m
  where m.user_id = auth.uid() and m.company_id = p_company and m.role = 'crew';
$$;

-- True when a property has a visit on the caller's crew within a week either side of today.
create or replace function app.crew_can_see_property(p_company uuid, p_property uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.visits v
    where v.company_id = p_company and v.property_id = p_property
      and v.crew_id = app.my_crew(p_company)
      and v.scheduled_on between current_date - 7 and current_date + 7
  );
$$;

-- ───────────────────────────── row-level security ─────────────────────────────
alter table public.companies enable row level security;
alter table public.memberships enable row level security;
alter table public.crews enable row level security;
alter table public.crew_members enable row level security;
alter table public.trucks enable row level security;
alter table public.customers enable row level security;
alter table public.properties enable row level security;
alter table public.property_notes enable row level security;
alter table public.services enable row level security;
alter table public.plans enable row level security;
alter table public.visits enable row level security;
alter table public.visit_checks enable row level security;
alter table public.photos enable row level security;
alter table public.material_applications enable row level security;
alter table public.shifts enable row level security;
alter table public.shift_pauses enable row level security;
alter table public.gps_points enable row level security;
alter table public.fuel_receipts enable row level security;
alter table public.odometer_readings enable row level security;
alter table public.office_items enable row level security;
alter table public.leads enable row level security;
alter table public.equipment enable row level security;
alter table public.texts_log enable row level security;

-- companies: members read their company; owners edit it.
create policy companies_read on public.companies for select to authenticated
  using (app.has_role(id, 'owner', 'dispatcher', 'crew'));
create policy companies_owner_update on public.companies for update to authenticated
  using (app.is_owner(id)) with check (app.is_owner(id));

-- memberships: see your own; owners manage everyone in their company.
create policy memberships_self on public.memberships for select to authenticated
  using (user_id = auth.uid() or app.is_owner(company_id));
create policy memberships_owner_write on public.memberships for all to authenticated
  using (app.is_owner(company_id)) with check (app.is_owner(company_id));

-- Office tables: owner and dispatcher read and write. Crews read what their day needs.
create policy crews_office on public.crews for all to authenticated
  using (app.is_office(company_id)) with check (app.is_office(company_id));
create policy crews_crew_read on public.crews for select to authenticated
  using (id = app.my_crew(company_id));

create policy crew_members_office on public.crew_members for all to authenticated
  using (app.is_office(company_id)) with check (app.is_office(company_id));
create policy crew_members_crew_read on public.crew_members for select to authenticated
  using (crew_id = app.my_crew(company_id));

create policy trucks_office on public.trucks for all to authenticated
  using (app.is_office(company_id)) with check (app.is_office(company_id));
create policy trucks_crew_read on public.trucks for select to authenticated
  using (crew_id = app.my_crew(company_id));

create policy services_office on public.services for all to authenticated
  using (app.is_office(company_id)) with check (app.is_office(company_id));
create policy services_crew_read on public.services for select to authenticated
  using (app.my_crew(company_id) is not null);

create policy customers_office on public.customers for all to authenticated
  using (app.is_office(company_id)) with check (app.is_office(company_id));
create policy customers_crew_read on public.customers for select to authenticated
  using (exists (select 1 from public.properties p
                 where p.customer_id = customers.id and app.crew_can_see_property(p.company_id, p.id)));

create policy properties_office on public.properties for all to authenticated
  using (app.is_office(company_id)) with check (app.is_office(company_id));
create policy properties_crew_read on public.properties for select to authenticated
  using (app.crew_can_see_property(company_id, id));

create policy property_notes_office on public.property_notes for all to authenticated
  using (app.is_office(company_id)) with check (app.is_office(company_id));
create policy property_notes_crew_read on public.property_notes for select to authenticated
  using (app.crew_can_see_property(company_id, property_id));

-- Plans hold prices: office only.
create policy plans_office on public.plans for all to authenticated
  using (app.is_office(company_id)) with check (app.is_office(company_id));

-- Visits: office does everything; a crew reads and updates its own visits but cannot
-- create, delete or move them to another crew (the with check keeps crew_id fixed).
create policy visits_office on public.visits for all to authenticated
  using (app.is_office(company_id)) with check (app.is_office(company_id));
create policy visits_crew_read on public.visits for select to authenticated
  using (crew_id = app.my_crew(company_id));
create policy visits_crew_update on public.visits for update to authenticated
  using (crew_id = app.my_crew(company_id))
  with check (crew_id = app.my_crew(company_id));

-- Work the crew records on its own visits.
create policy visit_checks_office on public.visit_checks for all to authenticated
  using (app.is_office(company_id)) with check (app.is_office(company_id));
create policy visit_checks_crew on public.visit_checks for all to authenticated
  using (exists (select 1 from public.visits v where v.id = visit_id and v.crew_id = app.my_crew(v.company_id)))
  with check (exists (select 1 from public.visits v where v.id = visit_id and v.company_id = visit_checks.company_id and v.crew_id = app.my_crew(v.company_id)));

create policy material_applications_office on public.material_applications for all to authenticated
  using (app.is_office(company_id)) with check (app.is_office(company_id));
create policy material_applications_crew on public.material_applications for all to authenticated
  using (crew_id = app.my_crew(company_id))
  with check (crew_id = app.my_crew(company_id)
              and exists (select 1 from public.visits v where v.id = visit_id and v.crew_id = app.my_crew(v.company_id)));

-- Photos, shifts, pauses, GPS, odometer: the crew inserts and reads its own rows.
create policy photos_office on public.photos for all to authenticated
  using (app.is_office(company_id)) with check (app.is_office(company_id));
create policy photos_crew on public.photos for all to authenticated
  using (crew_id = app.my_crew(company_id)) with check (crew_id = app.my_crew(company_id));

create policy shifts_office on public.shifts for all to authenticated
  using (app.is_office(company_id)) with check (app.is_office(company_id));
create policy shifts_crew on public.shifts for all to authenticated
  using (crew_id = app.my_crew(company_id)) with check (crew_id = app.my_crew(company_id));

create policy shift_pauses_office on public.shift_pauses for all to authenticated
  using (app.is_office(company_id)) with check (app.is_office(company_id));
create policy shift_pauses_crew on public.shift_pauses for all to authenticated
  using (crew_id = app.my_crew(company_id)) with check (crew_id = app.my_crew(company_id));

create policy gps_points_office_read on public.gps_points for select to authenticated
  using (app.is_office(company_id));
create policy gps_points_crew_insert on public.gps_points for insert to authenticated
  with check (crew_id = app.my_crew(company_id));
create policy gps_points_crew_read on public.gps_points for select to authenticated
  using (crew_id = app.my_crew(company_id));

-- Money: fuel receipts and odometer are owner-only to read; crews can add their own.
create policy fuel_receipts_owner on public.fuel_receipts for all to authenticated
  using (app.is_owner(company_id)) with check (app.is_owner(company_id));
create policy fuel_receipts_crew_insert on public.fuel_receipts for insert to authenticated
  with check (crew_id = app.my_crew(company_id));

create policy odometer_owner on public.odometer_readings for all to authenticated
  using (app.is_owner(company_id)) with check (app.is_owner(company_id));
create policy odometer_crew_insert on public.odometer_readings for insert to authenticated
  with check (crew_id = app.my_crew(company_id));

-- Office items and leads: office manages; crews can create them (Can't finish, Spotted work).
create policy office_items_office on public.office_items for all to authenticated
  using (app.is_office(company_id)) with check (app.is_office(company_id));
create policy office_items_crew_insert on public.office_items for insert to authenticated
  with check (crew_id = app.my_crew(company_id));

create policy leads_office on public.leads for all to authenticated
  using (app.is_office(company_id)) with check (app.is_office(company_id));
create policy leads_crew_insert on public.leads for insert to authenticated
  with check (crew_id = app.my_crew(company_id) and app.crew_can_see_property(company_id, property_id));

create policy equipment_office on public.equipment for all to authenticated
  using (app.is_office(company_id)) with check (app.is_office(company_id));
create policy equipment_crew_read on public.equipment for select to authenticated
  using (crew_id = app.my_crew(company_id));

-- Texts are written by server functions (service role); the office reads the log.
create policy texts_log_office_read on public.texts_log for select to authenticated
  using (app.is_office(company_id));

-- ───────────────────────────── grants ─────────────────────────────
grant usage on schema app to authenticated;
grant execute on all functions in schema app to authenticated;
grant usage on all sequences in schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
-- RLS above decides which rows; anonymous visitors get nothing.
revoke all on all tables in schema public from anon;

-- Keep visits.updated_at current for offline sync conflict checks.
create or replace function app.touch_updated_at() returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
create trigger visits_touch before update on public.visits
  for each row execute function app.touch_updated_at();

-- A crew tablet may move its visit along (status, times, blocked reason, next service),
-- but not change what the office set: property, service, day, crew, order, price, notes.
create or replace function app.guard_crew_visit_update() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or app.is_office(old.company_id) then
    return new;
  end if;
  if new.company_id is distinct from old.company_id
     or new.property_id is distinct from old.property_id
     or new.plan_id is distinct from old.plan_id
     or new.service_id is distinct from old.service_id
     or new.source is distinct from old.source
     or new.scheduled_on is distinct from old.scheduled_on
     or new.crew_id is distinct from old.crew_id
     or new.route_order is distinct from old.route_order
     or new.est_minutes is distinct from old.est_minutes
     or new.price_cents is distinct from old.price_cents
     or new.office_note is distinct from old.office_note then
    raise exception 'crew can only update progress fields on a visit' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger visits_guard_crew before update on public.visits
  for each row execute function app.guard_crew_visit_update();
