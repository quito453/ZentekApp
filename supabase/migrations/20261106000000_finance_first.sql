-- Finance first: Cutting Cost sits on top of the field software a company already uses.
--
-- What changes:
--   • Costs follow the variable / fixed split owners use:
--       variable (per job): crew pay, fuel for trucks and mowers, materials, maintenance
--         (a set amount per km driven and per mower hour)
--       fixed (per month): the owner's list (insurance, rent, software…) plus depreciation of
--         trucks and mowers, shared across jobs by what each job earns
--   • Mowers and other engines get costs: litres per hour, value, years, and how much of the time on
--     site the engine runs. Owner-only, like truck costs.
--   • Crews' arrivals and departures can come from the tablet's GPS (geofence). Visits get
--     departed_at and how the arrival was recorded.
--   • Trips (drive from one stop to the next), GPS vs odometer, profit per customer and area,
--     payroll split into on site / driving / other.
--   • Regular routes per crew and weekday; tomorrow's order stays in visits.route_order.
--   • Jobs can come in from a spreadsheet or from other software through an API key (Zapier).
--   • Season (default April–November) for the screens and the season email report.

-- ───────────────────────────── company settings ─────────────────────────────
alter table public.companies add column mode text not null default 'finance' check (mode in ('finance', 'full'));
alter table public.companies add column maint_cents_per_km int not null default 15 check (maint_cents_per_km >= 0);
alter table public.companies add column maint_cents_per_mower_hour int not null default 150 check (maint_cents_per_mower_hour >= 0);
alter table public.companies add column season_start_month smallint not null default 4 check (season_start_month between 1 and 12);
alter table public.companies add column season_end_month smallint not null default 11 check (season_end_month between 1 and 12);
alter table public.report_settings add column season boolean not null default false;
alter table public.report_settings add column last_season_sent date;

-- ───────────────────────────── properties, visits, outside ids ─────────────────────────────
alter table public.properties add column area text;            -- neighbourhood or route area, for profit by area
alter table public.visits add column departed_at timestamptz;   -- when the truck left the property
alter table public.visits add column arrival_source text check (arrival_source in ('geofence', 'manual', 'import'));
alter table public.customers add column external_source text;
alter table public.customers add column external_id text;
alter table public.properties add column external_source text;
alter table public.properties add column external_id text;
alter table public.visits add column external_source text;
alter table public.visits add column external_id text;
create unique index customers_external on public.customers (company_id, external_source, external_id) where external_id is not null;
create unique index properties_external on public.properties (company_id, external_source, external_id) where external_id is not null;
create unique index visits_external on public.visits (company_id, external_source, external_id) where external_id is not null;

-- ───────────────────────────── mowers and other engines ─────────────────────────────
alter table public.equipment add column kind text not null default 'mower' check (kind in ('mower', 'trimmer', 'blower', 'other'));

create table public.equipment_costs (
  equipment_id uuid primary key references public.equipment (id) on delete cascade,
  company_id uuid not null references public.companies (id) on delete cascade,
  l_per_hour numeric(4, 2) not null default 0 check (l_per_hour >= 0),
  use_share numeric(3, 2) not null default 0.6 check (use_share between 0 and 1), -- share of time on site the engine runs
  value_cents int not null default 0 check (value_cents >= 0),
  life_years numeric(4, 1) not null default 5 check (life_years > 0)
);

-- ───────────────────────────── regular routes ─────────────────────────────
create table public.route_plans (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  crew_id uuid not null references public.crews (id) on delete cascade,
  weekday smallint not null check (weekday between 0 and 6),   -- 0 Monday … 6 Sunday
  property_ids uuid[] not null default '{}',                   -- in driving order
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (company_id, crew_id, weekday)
);

-- ───────────────────────────── imports and API keys ─────────────────────────────
create table public.imports (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  source text not null,              -- 'spreadsheet', 'zapier', 'api'
  file_name text,
  rows_in int not null default 0,
  rows_added int not null default 0,
  rows_skipped int not null default 0,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);

-- Keys for Zapier and other software. Only a hash is stored; the key is shown once.
create table public.api_keys (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 60),
  prefix text not null,
  key_hash text not null unique,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

alter table public.equipment_costs enable row level security;
alter table public.route_plans enable row level security;
alter table public.imports enable row level security;
alter table public.api_keys enable row level security;
grant select, insert, update, delete on public.equipment_costs, public.route_plans to authenticated;
grant select on public.imports, public.api_keys to authenticated;
grant update (revoked_at) on public.api_keys to authenticated;

-- Equipment costs, imports and keys: owner only. Dispatchers and crews get no policy.
create policy equipment_costs_owner on public.equipment_costs for all to authenticated
  using (app.is_owner(company_id)) with check (app.is_owner(company_id));
create policy imports_owner_read on public.imports for select to authenticated using (app.is_owner(company_id));
create policy api_keys_owner_read on public.api_keys for select to authenticated using (app.is_owner(company_id));
create policy api_keys_owner_revoke on public.api_keys for update to authenticated
  using (app.is_owner(company_id)) with check (app.is_owner(company_id));
-- Regular routes: the office plans them; a crew can read its own.
create policy route_plans_office on public.route_plans for all to authenticated
  using (app.is_office(company_id)) with check (app.is_office(company_id));
create policy route_plans_crew_read on public.route_plans for select to authenticated
  using (crew_id = app.my_crew(company_id));

-- A new API key. Returns the key once; only its hash is kept.
create or replace function public.create_api_key(p_company uuid, p_name text)
returns text language plpgsql volatile security definer set search_path = '' as $$
declare
  k text;
begin
  if not app.is_owner(p_company) then
    raise exception 'owner only' using errcode = '42501';
  end if;
  k := 'cc_live_' || replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  insert into public.api_keys (company_id, name, prefix, key_hash, created_by)
  values (p_company, trim(p_name), left(k, 12), encode(sha256(convert_to(k, 'UTF8')), 'hex'), auth.uid());
  return k;
end;
$$;
revoke all on function public.create_api_key(uuid, text) from public, anon;
grant execute on function public.create_api_key(uuid, text) to authenticated;

-- ───────────────────────────── helpers ─────────────────────────────
-- Kilometres a crew drove between two moments, with the same filters as app.crew_day_km.
create or replace function app.gps_km(p_crew uuid, p_from timestamptz, p_to timestamptz)
returns numeric language sql stable security definer set search_path = '' as $$
  with pts as (
    select g.recorded_at, g.lat, g.lng, lag(g.lat) over w as plat, lag(g.lng) over w as plng, lag(g.recorded_at) over w as pat
    from public.gps_points g
    where g.crew_id = p_crew and g.recorded_at > p_from and g.recorded_at <= p_to
      and (g.accuracy_m is null or g.accuracy_m <= 50)
    window w as (order by g.recorded_at)
  ), seg as (
    select app.km_between(plat, plng, lat, lng) as km, extract(epoch from recorded_at - pat) / 3600.0 as h
    from pts where plat is not null
  )
  select round(coalesce(sum(km) filter (where h > 0 and km / h <= 150), 0)::numeric, 2) from seg;
$$;

-- Fixed costs for a period: the owner's monthly list plus depreciation of trucks and engines.
create or replace function app.fixed_cents_for(p_company uuid, p_from date, p_to date)
returns int language sql stable security definer set search_path = '' as $$
  select round((
      coalesce((select sum(f.monthly_cents) from public.fixed_costs f where f.company_id = p_company), 0)
    + coalesce((select sum(tc.value_cents::numeric / tc.life_years / 12) from public.truck_costs tc where tc.company_id = p_company), 0)
    + coalesce((select sum(ec.value_cents::numeric / ec.life_years / 12) from public.equipment_costs ec where ec.company_id = p_company), 0)
  ) * 12 / 365.25 * (p_to - p_from + 1))::int;
$$;

create or replace function app.depreciation_cents_for(p_company uuid, p_from date, p_to date)
returns int language sql stable security definer set search_path = '' as $$
  select round((
      coalesce((select sum(tc.value_cents::numeric / tc.life_years / 12) from public.truck_costs tc where tc.company_id = p_company), 0)
    + coalesce((select sum(ec.value_cents::numeric / ec.life_years / 12) from public.equipment_costs ec where ec.company_id = p_company), 0)
  ) * 12 / 365.25 * (p_to - p_from + 1))::int;
$$;

-- ───────────────────────────── profit per job ─────────────────────────────
-- Truck wear per hour is gone (depreciation is fixed now); maintenance per km and per mower hour
-- and mower fuel are added.
drop function public.finance_summary(uuid, date, date);
drop function public.job_profit(uuid, date, date);
create function public.job_profit(p_company uuid, p_from date, p_to date)
returns table (
  visit_id uuid, day date, address text, area text, customer_id uuid, customer text, property_id uuid, crew_id uuid, crew text, source app.visit_source,
  revenue_cents int, labour_cents int, fuel_cents int, materials_cents int, maintenance_cents int,
  profit_cents int, minutes int, complaint boolean, fixed_share_cents int, net_cents int, km numeric
)
language plpgsql stable security definer set search_path = '' as $$
declare
  tz text;
  fuel_price numeric;
  fixed_total int;
  m_km int;
  m_hr int;
begin
  perform app.assert_finance_access(p_company);
  select c.timezone, c.maint_cents_per_km, c.maint_cents_per_mower_hour into tz, m_km, m_hr from public.companies c where c.id = p_company;
  fuel_price := app.fuel_price_for(p_company, p_from, p_to, tz);
  fixed_total := app.fixed_cents_for(p_company, p_from, p_to);

  return query
  with v as (
    select vv.id, vv.crew_id, vv.property_id, vv.source, vv.price_cents,
           (vv.done_at at time zone tz)::date as d,
           greatest(1, round(extract(epoch from coalesce(vv.departed_at, vv.done_at) - coalesce(vv.arrived_at, vv.done_at - make_interval(mins => vv.est_minutes))) / 60))::int as mins
    from public.visits vv
    where vv.company_id = p_company and vv.status = 'done' and vv.done_at is not null
      and (vv.done_at at time zone tz)::date between p_from and p_to
  ),
  total_rev as (select coalesce(sum(v.price_cents), 0)::numeric as cents from v),
  day_mins as (select v.crew_id, v.d, sum(v.mins) as total, count(*) as n from v group by v.crew_id, v.d),
  lunch as (
    select sp.shift_id, sum(extract(epoch from coalesce(sp.ended_at, now()) - sp.started_at) / 60) as m
    from public.shift_pauses sp where sp.company_id = p_company and sp.kind = 'lunch' group by sp.shift_id
  ),
  paid as (
    select s.crew_id, (s.clock_in_at at time zone tz)::date as d,
           sum(extract(epoch from coalesce(s.clock_out_at, now()) - s.clock_in_at) / 60 - coalesce(l.m, 0)) as m
    from public.shifts s left join lunch l on l.shift_id = s.id
    where s.company_id = p_company and (s.clock_in_at at time zone tz)::date between p_from and p_to
    group by s.crew_id, (s.clock_in_at at time zone tz)::date
  ),
  rate as (
    select cm.crew_id, sum(lr.hourly_cost_cents)::numeric as cph
    from public.crew_members cm join public.labour_rates lr on lr.crew_member_id = cm.id
    where cm.company_id = p_company and cm.active group by cm.crew_id
  ),
  truck as (
    select distinct on (t.crew_id) t.crew_id, coalesce(t.l_per_100km, 0) as l100
    from public.trucks t where t.company_id = p_company and t.crew_id is not null
    order by t.crew_id, t.name
  ),
  engines as (   -- per crew: litres per hour on site and engine-hours per hour on site
    select e.crew_id, sum(ec.l_per_hour * ec.use_share) as lph, sum(ec.use_share) as ehph
    from public.equipment e join public.equipment_costs ec on ec.equipment_id = e.id
    where e.company_id = p_company and e.crew_id is not null group by e.crew_id
  ),
  km as (select * from app.crew_day_km(p_company, p_from, p_to, tz)),
  mat as (
    select ma.visit_id, sum(ma.amount * mp.cost_per_unit_cents) as cents
    from public.material_applications ma
    join public.material_prices mp on mp.company_id = ma.company_id and lower(mp.product) = lower(ma.product) and mp.unit = ma.unit
    where ma.company_id = p_company group by ma.visit_id
  ),
  comp as (
    select distinct oi.visit_id from public.office_items oi
    where oi.company_id = p_company and oi.kind = 'complaint' and oi.visit_id is not null
  ),
  x as (
    select v.id, v.d, p.address, p.area, cu.id as cust_id, cu.full_name, p.id as prop_id, v.crew_id, cr.name as crew_name, v.source, v.price_cents, v.mins,
           (coalesce(pd.m, dm.total) * v.mins / nullif(dm.total, 0)) as paid_mins,
           r.cph as rate_cph, tr.l100, coalesce(k.km, 0) / nullif(dm.n, 0) as job_km, m.cents as mat_cents,
           coalesce(en.lph, 0) as lph, coalesce(en.ehph, 0) as ehph,
           (c.visit_id is not null) as is_complaint
    from v
    join day_mins dm on dm.crew_id is not distinct from v.crew_id and dm.d = v.d
    join public.properties p on p.id = v.property_id
    join public.customers cu on cu.id = p.customer_id
    left join public.crews cr on cr.id = v.crew_id
    left join paid pd on pd.crew_id = v.crew_id and pd.d = v.d
    left join rate r on r.crew_id = v.crew_id
    left join truck tr on tr.crew_id = v.crew_id
    left join engines en on en.crew_id = v.crew_id
    left join km k on k.crew_id = v.crew_id and k.day = v.d
    left join mat m on m.visit_id = v.id
    left join comp c on c.visit_id = v.id
  ),
  y as (
    select x.*,
           round(coalesce(x.rate_cph, 0) * coalesce(x.paid_mins, 0) / 60)::int as labour,
           round((coalesce(x.job_km, 0) * coalesce(x.l100, 0) / 100 + x.mins / 60.0 * x.lph) * fuel_price * 100)::int as fuel,
           round(coalesce(x.mat_cents, 0))::int as materials,
           round(coalesce(x.job_km, 0) * m_km + x.mins / 60.0 * x.ehph * m_hr)::int as maint,
           coalesce(round(fixed_total::numeric * x.price_cents / nullif((select cents from total_rev), 0)), 0)::int as fixed_share
    from x
  )
  select y.id, y.d, y.address, y.area, y.cust_id, y.full_name, y.prop_id, y.crew_id, y.crew_name, y.source, y.price_cents,
         y.labour, y.fuel, y.materials, y.maint,
         y.price_cents - y.labour - y.fuel - y.materials - y.maint,
         y.mins, y.is_complaint, y.fixed_share,
         y.price_cents - y.labour - y.fuel - y.materials - y.maint - y.fixed_share,
         round(coalesce(y.job_km, 0), 2)
  from y
  order by y.d, y.crew_name, y.address;
end;
$$;
revoke all on function public.job_profit(uuid, date, date) from public, anon;
grant execute on function public.job_profit(uuid, date, date) to authenticated;

-- ───────────────────────────── business summary ─────────────────────────────
create function public.finance_summary(p_company uuid, p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  result jsonb;
  tz text;
  fixed_total int;
  has_receipts boolean;
begin
  perform app.assert_finance_access(p_company);
  select c.timezone into tz from public.companies c where c.id = p_company;
  fixed_total := app.fixed_cents_for(p_company, p_from, p_to);
  select exists (select 1 from public.fuel_receipts r where r.company_id = p_company and r.litres > 0
                 and (r.bought_at at time zone tz)::date between p_from and p_to) into has_receipts;

  with j as (select * from public.job_profit(p_company, p_from, p_to)),
  co as (select c.monthly_revenue_target_cents as target, c.fuel_price_source from public.companies c where c.id = p_company),
  leads as (
    select l.crew_id, count(*) as created, count(*) filter (where l.status = 'won') as won,
           count(*) filter (where l.status in ('new', 'quoted')) as open
    from public.leads l
    where l.company_id = p_company and (l.created_at at time zone tz)::date between p_from and p_to
    group by l.crew_id
  ),
  crews as (select cr.id, cr.name from public.crews cr where cr.company_id = p_company),
  per_crew as (
    select c.id, c.name,
           coalesce(sum(j.revenue_cents), 0) as revenue, coalesce(sum(j.profit_cents), 0) as profit,
           count(j.visit_id) as jobs, coalesce(sum(j.minutes), 0) as minutes,
           count(*) filter (where j.complaint) as complaints, count(distinct j.day) as days
    from crews c left join j on j.crew_id = c.id
    group by c.id, c.name
  )
  select jsonb_build_object(
    'from', p_from, 'to', p_to,
    'jobs', (select count(*) from j),
    'revenue_cents', (select coalesce(sum(revenue_cents), 0) from j),
    'labour_cents', (select coalesce(sum(labour_cents), 0) from j),
    'fuel_cents', (select coalesce(sum(fuel_cents), 0) from j),
    'materials_cents', (select coalesce(sum(materials_cents), 0) from j),
    'maintenance_cents', (select coalesce(sum(maintenance_cents), 0) from j),
    'profit_cents', (select coalesce(sum(profit_cents), 0) from j),
    'fixed_cents', fixed_total,
    'depreciation_cents', app.depreciation_cents_for(p_company, p_from, p_to),
    'net_profit_cents', (select coalesce(sum(profit_cents), 0) from j) - fixed_total,
    'fuel_price_per_l', round(app.fuel_price_for(p_company, p_from, p_to, tz), 3),
    'fuel_price_from', case when has_receipts then 'receipts' else coalesce((select fuel_price_source from co), 'manual') end,
    'losing_jobs', (select count(*) from j where profit_cents < 0),
    'complaint_jobs', (select count(*) from j where complaint),
    'mix', jsonb_build_object(
      'regular_cents', (select coalesce(sum(revenue_cents), 0) from j where source = 'plan'),
      'new_customer_cents', (select coalesce(sum(revenue_cents), 0) from j where source = 'new_customer'),
      'upsell_cents', (select coalesce(sum(revenue_cents), 0) from j where source in ('lead_won', 'crew_recommended')),
      'other_cents', (select coalesce(sum(revenue_cents), 0) from j where source in ('redo', 'rescheduled'))
    ),
    'leads', jsonb_build_object(
      'created', (select coalesce(sum(created), 0) from leads),
      'won', (select coalesce(sum(won), 0) from leads),
      'open', (select coalesce(sum(open), 0) from leads)
    ),
    'monthly_target_cents', (select target from co),
    'crews', coalesce((
      select jsonb_agg(jsonb_build_object(
        'crew_id', pc.id, 'name', pc.name, 'revenue_cents', pc.revenue, 'profit_cents', pc.profit,
        'jobs', pc.jobs, 'minutes', pc.minutes, 'complaints', pc.complaints, 'days', pc.days,
        'leads_created', coalesce(l.created, 0), 'leads_won', coalesce(l.won, 0)
      ) order by pc.profit desc)
      from per_crew pc left join leads l on l.crew_id = pc.id
    ), '[]'::jsonb)
  ) into result;
  return result;
end;
$$;
revoke all on function public.finance_summary(uuid, date, date) from public, anon;
grant execute on function public.finance_summary(uuid, date, date) to authenticated;

-- ───────────────────────────── trips: from one stop to the next ─────────────────────────────
-- For each visit with an arrival: where the truck came from (the previous stop's departure, or the
-- start of the shift), how long the drive took, the GPS kilometres, the fuel to get there and the time
-- at the client.
create or replace function public.crew_trips(p_company uuid, p_from date, p_to date)
returns table (
  crew_id uuid, crew text, day date, visit_id uuid, from_address text, to_address text, customer text,
  left_at timestamptz, arrived_at timestamptz, departed_at timestamptz, drive_minutes int, km numeric,
  fuel_cents int, site_minutes int, arrival_source text
)
language plpgsql stable security definer set search_path = '' as $$
declare
  tz text;
  fuel_price numeric;
begin
  perform app.assert_finance_access(p_company);
  select c.timezone into tz from public.companies c where c.id = p_company;
  fuel_price := app.fuel_price_for(p_company, p_from, p_to, tz);
  return query
  with v as (
    select vv.id, vv.crew_id, (vv.arrived_at at time zone tz)::date as d, vv.arrived_at, coalesce(vv.departed_at, vv.done_at) as left_site,
           p.address, cu.full_name, vv.arrival_source
    from public.visits vv
    join public.properties p on p.id = vv.property_id
    join public.customers cu on cu.id = p.customer_id
    where vv.company_id = p_company and vv.arrived_at is not null and vv.crew_id is not null
      and (vv.arrived_at at time zone tz)::date between p_from and p_to
  ),
  o as (
    select v.*, lag(v.left_site) over w as prev_left, lag(v.address) over w as prev_addr
    from v window w as (partition by v.crew_id, v.d order by v.arrived_at)
  ),
  s as (
    select sh.crew_id, (sh.clock_in_at at time zone tz)::date as d, min(sh.clock_in_at) as start_at
    from public.shifts sh where sh.company_id = p_company group by sh.crew_id, (sh.clock_in_at at time zone tz)::date
  ),
  t as (
    select o.*, coalesce(o.prev_left, s.start_at) as from_at, tr.l100
    from o left join s on s.crew_id = o.crew_id and s.d = o.d
    left join lateral (select coalesce(t2.l_per_100km, 0) as l100 from public.trucks t2 where t2.crew_id = o.crew_id order by t2.name limit 1) tr on true
  )
  select t.crew_id, cr.name, t.d, t.id, coalesce(t.prev_addr, 'Start of shift'), t.address, t.full_name,
         t.from_at, t.arrived_at, t.left_site,
         case when t.from_at is null then null else greatest(0, round(extract(epoch from t.arrived_at - t.from_at) / 60))::int end,
         case when t.from_at is null then null else app.gps_km(t.crew_id, t.from_at, t.arrived_at) end,
         case when t.from_at is null then null else round(app.gps_km(t.crew_id, t.from_at, t.arrived_at) * coalesce(t.l100, 0) / 100 * fuel_price * 100)::int end,
         case when t.left_site is null then null else greatest(0, round(extract(epoch from t.left_site - t.arrived_at) / 60))::int end,
         t.arrival_source
  from t left join public.crews cr on cr.id = t.crew_id
  order by t.d, cr.name, t.arrived_at;
end;
$$;
revoke all on function public.crew_trips(uuid, date, date) from public, anon;
grant execute on function public.crew_trips(uuid, date, date) to authenticated;

-- ───────────────────────────── GPS compared with the odometer ─────────────────────────────
-- Per truck per day with at least two odometer readings. A gap over 10% usually means the truck moved
-- with the tablet off, or the tablet was left behind.
create or replace function public.gps_vs_odometer(p_company uuid, p_from date, p_to date)
returns table (truck_id uuid, truck text, crew text, day date, start_km int, end_km int, odometer_km int, gps_km numeric, gap_pct numeric)
language plpgsql stable security definer set search_path = '' as $$
declare
  tz text;
begin
  perform app.assert_finance_access(p_company);
  select c.timezone into tz from public.companies c where c.id = p_company;
  return query
  with r as (
    select o.truck_id, (o.read_at at time zone tz)::date as d, min(o.reading_km) as a, max(o.reading_km) as b, count(*) as n
    from public.odometer_readings o
    where o.company_id = p_company and (o.read_at at time zone tz)::date between p_from and p_to
    group by o.truck_id, (o.read_at at time zone tz)::date
  ),
  g as (select * from app.crew_day_km(p_company, p_from, p_to, tz))
  select r.truck_id, t.name, cr.name, r.d, r.a, case when r.n > 1 then r.b end, case when r.n > 1 then r.b - r.a end,
         coalesce(g.km, 0),
         case when r.n > 1 and r.b > r.a then round((r.b - r.a - coalesce(g.km, 0)) / (r.b - r.a) * 100, 1) end
  from r join public.trucks t on t.id = r.truck_id
  left join public.crews cr on cr.id = t.crew_id
  left join g on g.crew_id = t.crew_id and g.day = r.d
  order by r.d, t.name;
end;
$$;
revoke all on function public.gps_vs_odometer(uuid, date, date) from public, anon;
grant execute on function public.gps_vs_odometer(uuid, date, date) to authenticated;

-- ───────────────────────────── profit per customer ─────────────────────────────
create or replace function public.customer_profit(p_company uuid, p_from date, p_to date)
returns table (
  customer_id uuid, customer text, property_id uuid, address text, area text, crew text,
  visits int, revenue_cents int, costs_cents int, profit_cents int, fixed_share_cents int, net_cents int,
  site_minutes int, drive_minutes int
)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.assert_finance_access(p_company);
  return query
  with j as (select * from public.job_profit(p_company, p_from, p_to)),
  tr as (select ct.visit_id, ct.drive_minutes from public.crew_trips(p_company, p_from, p_to) ct)
  select j.customer_id, j.customer, j.property_id, j.address, j.area, string_agg(distinct j.crew, ', '),
         count(*)::int, sum(j.revenue_cents)::int,
         sum(j.labour_cents + j.fuel_cents + j.materials_cents + j.maintenance_cents)::int,
         sum(j.profit_cents)::int, sum(j.fixed_share_cents)::int, sum(j.net_cents)::int,
         sum(j.minutes)::int, coalesce(sum(tr.drive_minutes), 0)::int
  from j left join tr on tr.visit_id = j.visit_id
  group by j.customer_id, j.customer, j.property_id, j.address, j.area
  order by sum(j.net_cents);
end;
$$;
revoke all on function public.customer_profit(uuid, date, date) from public, anon;
grant execute on function public.customer_profit(uuid, date, date) to authenticated;

-- ───────────────────────────── payroll, split by where the time went ─────────────────────────────
drop function public.payroll(uuid, date, date);
create function public.payroll(p_company uuid, p_from date, p_to date)
returns table (
  crew_member_id uuid, full_name text, crew text, week_start date,
  paid_hours numeric, regular_hours numeric, overtime_hours numeric,
  on_site_hours numeric, driving_hours numeric, other_hours numeric,
  hourly_cost_cents int, cost_cents int
)
language plpgsql stable security definer set search_path = '' as $$
declare
  tz text;
  ot_after numeric;
  ot_mult numeric;
begin
  perform app.assert_finance_access(p_company);
  select c.timezone, c.overtime_after_hours, c.overtime_multiplier into tz, ot_after, ot_mult
  from public.companies c where c.id = p_company;

  return query
  with lunch as (
    select sp.shift_id, sum(extract(epoch from coalesce(sp.ended_at, sp.started_at) - sp.started_at) / 3600) as h
    from public.shift_pauses sp where sp.company_id = p_company and sp.kind = 'lunch' group by sp.shift_id
  ),
  shift_hours as (
    select s.crew_id, date_trunc('week', (s.clock_in_at at time zone tz))::date as wk,
           sum(extract(epoch from s.clock_out_at - s.clock_in_at) / 3600 - coalesce(l.h, 0)) as h
    from public.shifts s left join lunch l on l.shift_id = s.id
    where s.company_id = p_company and s.clock_out_at is not null
      and (s.clock_in_at at time zone tz)::date between p_from and p_to
    group by s.crew_id, date_trunc('week', (s.clock_in_at at time zone tz))::date
  ),
  site as (
    select vv.crew_id, date_trunc('week', (vv.arrived_at at time zone tz))::date as wk,
           sum(extract(epoch from coalesce(vv.departed_at, vv.done_at) - vv.arrived_at) / 3600) as h
    from public.visits vv
    where vv.company_id = p_company and vv.arrived_at is not null and coalesce(vv.departed_at, vv.done_at) is not null
      and (vv.arrived_at at time zone tz)::date between p_from and p_to
    group by vv.crew_id, date_trunc('week', (vv.arrived_at at time zone tz))::date
  ),
  drive as (
    select ct.crew_id, date_trunc('week', ct.day)::date as wk, sum(coalesce(ct.drive_minutes, 0)) / 60.0 as h
    from public.crew_trips(p_company, p_from, p_to) ct group by ct.crew_id, date_trunc('week', ct.day)::date
  )
  select cm.id, cm.full_name, cr.name, sh.wk,
         round(sh.h::numeric, 2),
         round(least(sh.h, ot_after)::numeric, 2),
         round(greatest(sh.h - ot_after, 0)::numeric, 2),
         round(coalesce(si.h, 0)::numeric, 2),
         round(coalesce(dr.h, 0)::numeric, 2),
         round(greatest(sh.h - coalesce(si.h, 0) - coalesce(dr.h, 0), 0)::numeric, 2),
         coalesce(lr.hourly_cost_cents, 0),
         round(coalesce(lr.hourly_cost_cents, 0) * (least(sh.h, ot_after) + greatest(sh.h - ot_after, 0) * ot_mult))::int
  from shift_hours sh
  join public.crew_members cm on cm.crew_id = sh.crew_id and cm.company_id = p_company and cm.active
  left join public.crews cr on cr.id = sh.crew_id
  left join public.labour_rates lr on lr.crew_member_id = cm.id
  left join site si on si.crew_id = sh.crew_id and si.wk = sh.wk
  left join drive dr on dr.crew_id = sh.crew_id and dr.wk = sh.wk
  order by sh.wk, cr.name, cm.full_name;
end;
$$;
revoke all on function public.payroll(uuid, date, date) from public, anon;
grant execute on function public.payroll(uuid, date, date) to authenticated;

-- ───────────────────────────── bringing jobs in ─────────────────────────────
-- Jobs arrive as JSON objects in the shape packages/shared/src/importJobs.ts reads them:
--   { date, customer, address, service, priceCents, crew, minutes, area, externalId }
-- Customers are matched by name and properties by address; crews by name (left unassigned if no
-- match). A job with an externalId that came in before is updated, not added twice. Past jobs come in
-- as done; today's and future jobs as scheduled, so they show on the crew's tablet.
create or replace function app.import_rows(p_company uuid, p_source text, p_jobs jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  j jsonb;
  tz text;
  today date;
  n_added int := 0;
  n_updated int := 0;
  n_skipped int := 0;
  d date;
  cust uuid;
  prop uuid;
  crew uuid;
  svc uuid;
  svc_name text;
  mins int;
  ext text;
  existing uuid;
begin
  if jsonb_typeof(p_jobs) <> 'array' or jsonb_array_length(p_jobs) > 5000 then
    raise exception 'send up to 5000 jobs at a time' using errcode = '22023';
  end if;
  select c.timezone into tz from public.companies c where c.id = p_company;
  today := (now() at time zone tz)::date;

  for j in select * from jsonb_array_elements(p_jobs) loop
    begin
      d := (j->>'date')::date;
    exception when others then
      d := null;
    end;
    if d is null or coalesce(trim(j->>'customer'), '') = '' or coalesce(trim(j->>'address'), '') = ''
       or jsonb_typeof(j->'priceCents') <> 'number' or (j->>'priceCents')::numeric < 0 then
      n_skipped := n_skipped + 1;
      continue;
    end if;
    mins := case when jsonb_typeof(j->'minutes') = 'number' then greatest(1, least(1440, (j->>'minutes')::numeric::int)) end;
    ext := nullif(trim(j->>'externalId'), '');

    select cu.id into cust from public.customers cu
    where cu.company_id = p_company and lower(cu.full_name) = lower(trim(j->>'customer')) limit 1;
    if cust is null then
      insert into public.customers (company_id, full_name, external_source) values (p_company, left(trim(j->>'customer'), 120), p_source)
      returning id into cust;
    end if;

    select p.id into prop from public.properties p
    where p.company_id = p_company and lower(p.address) = lower(trim(j->>'address')) limit 1;
    if prop is null then
      insert into public.properties (company_id, customer_id, address, area, external_source)
      values (p_company, cust, left(trim(j->>'address'), 200), nullif(trim(j->>'area'), ''), p_source)
      returning id into prop;
    elsif nullif(trim(j->>'area'), '') is not null then
      update public.properties set area = trim(j->>'area') where id = prop;
    end if;

    crew := null;
    if nullif(trim(j->>'crew'), '') is not null then
      select cr.id into crew from public.crews cr
      where cr.company_id = p_company and cr.active and lower(cr.name) = lower(trim(j->>'crew')) limit 1;
    end if;

    svc_name := coalesce(nullif(trim(j->>'service'), ''), 'Imported job');
    select s.id into svc from public.services s where s.company_id = p_company and lower(s.name_en) = lower(svc_name) limit 1;
    if svc is null then
      insert into public.services (company_id, key, name_en)
      values (p_company, 'imp-' || left(regexp_replace(lower(svc_name), '[^a-z0-9]+', '-', 'g'), 40) || '-' || left(md5(lower(svc_name)), 6), left(svc_name, 120))
      on conflict (company_id, key) do update set name_en = excluded.name_en
      returning id into svc;
    end if;

    existing := null;
    if ext is not null then
      select v.id into existing from public.visits v
      where v.company_id = p_company and v.external_source = p_source and v.external_id = ext;
    end if;

    if existing is not null then
      update public.visits set
        property_id = prop, service_id = svc, scheduled_on = d, crew_id = coalesce(crew, crew_id),
        price_cents = round((j->>'priceCents')::numeric)::int, est_minutes = coalesce(mins, est_minutes),
        done_at = case when status = 'done' and d < today then ((d + time '17:00') at time zone tz) else done_at end,
        updated_at = now()
      where id = existing;
      n_updated := n_updated + 1;
    else
      insert into public.visits (company_id, property_id, service_id, source, scheduled_on, crew_id, est_minutes, price_cents,
                                 status, done_at, arrival_source, external_source, external_id)
      values (p_company, prop, svc, 'plan', d, crew, coalesce(mins, 30), round((j->>'priceCents')::numeric)::int,
              case when d < today then 'done'::app.visit_status else 'scheduled'::app.visit_status end,
              case when d < today then ((d + time '17:00') at time zone tz) end,
              'import', p_source, ext);
      n_added := n_added + 1;
    end if;
  end loop;
  return jsonb_build_object('added', n_added, 'updated', n_updated, 'skipped', n_skipped);
end;
$$;
revoke all on function app.import_rows(uuid, text, jsonb) from public, anon, authenticated;

-- A spreadsheet from the owner's computer (read in the browser, sent as rows).
create or replace function public.import_jobs(p_company uuid, p_file_name text, p_jobs jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  r jsonb;
begin
  if not app.is_owner(p_company) then
    raise exception 'owner only' using errcode = '42501';
  end if;
  r := app.import_rows(p_company, 'spreadsheet', p_jobs);
  insert into public.imports (company_id, source, file_name, rows_in, rows_added, rows_skipped, created_by)
  values (p_company, 'spreadsheet', left(p_file_name, 200), jsonb_array_length(p_jobs), (r->>'added')::int + (r->>'updated')::int, (r->>'skipped')::int, auth.uid());
  return r;
end;
$$;
revoke all on function public.import_jobs(uuid, text, jsonb) from public, anon;
grant execute on function public.import_jobs(uuid, text, jsonb) to authenticated;

-- Jobs from Zapier or other software, through the ingest Edge Function (server only).
create or replace function public.ingest_jobs(p_key text, p_source text, p_jobs jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  k public.api_keys;
  src text := coalesce(nullif(left(regexp_replace(lower(p_source), '[^a-z0-9_-]', '', 'g'), 30), ''), 'api');
  r jsonb;
begin
  select * into k from public.api_keys a where a.key_hash = encode(sha256(convert_to(p_key, 'UTF8')), 'hex') and a.revoked_at is null;
  if k.id is null then
    raise exception 'unknown or revoked key' using errcode = '28000';
  end if;
  update public.api_keys set last_used_at = now() where id = k.id;
  r := app.import_rows(k.company_id, src, p_jobs);
  insert into public.imports (company_id, source, file_name, rows_in, rows_added, rows_skipped)
  values (k.company_id, src, k.name, jsonb_array_length(p_jobs), (r->>'added')::int + (r->>'updated')::int, (r->>'skipped')::int);
  return r;
end;
$$;
-- Not for signed-in users or visitors: only the server (service role) calls this.
revoke all on function public.ingest_jobs(text, text, jsonb) from public, anon, authenticated;
