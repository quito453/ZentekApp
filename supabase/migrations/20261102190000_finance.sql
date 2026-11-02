-- Finance for owners
--
-- Owners enter what things cost once (people per hour, trucks, materials, fuel). The database
-- then works out, for every finished job: revenue − labour − fuel − materials − truck wear = profit.
-- Everything here is owner-only: dispatchers and technicians cannot read pay rates or costs.
--
-- How each cost is worked out per job
--   labour     the crew's paid time that day (shift minus unpaid lunch) × the sum of its members'
--              hourly costs, shared across the day's jobs by minutes on site. Driving and
--              waiting time is paid too, so it is spread over the jobs.
--   truck wear truck value ÷ years of use ÷ working hours per year, shared the same way
--   fuel       the crew's km that day (from GPS) × the truck's L/100 km × fuel price, split evenly
--   materials  each product applied × its price per unit

-- ───────────────────────────── settings ─────────────────────────────
alter table public.companies add column overtime_after_hours numeric(5, 2) not null default 44; -- Ontario: 44 h/week
alter table public.companies add column overtime_multiplier numeric(3, 2) not null default 1.5;
alter table public.companies add column monthly_revenue_target_cents int check (monthly_revenue_target_cents >= 0);

create table public.labour_rates (
  crew_member_id uuid primary key references public.crew_members (id) on delete cascade,
  company_id uuid not null references public.companies (id) on delete cascade,
  hourly_cost_cents int not null check (hourly_cost_cents >= 0), -- wage plus what the owner pays on top
  updated_at timestamptz not null default now()
);

create table public.truck_costs (
  truck_id uuid primary key references public.trucks (id) on delete cascade,
  company_id uuid not null references public.companies (id) on delete cascade,
  value_cents bigint not null check (value_cents >= 0),
  life_years numeric(4, 1) not null check (life_years > 0),
  work_hours_per_year int not null default 1800 check (work_hours_per_year > 0)
);

create table public.material_prices (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  product text not null,
  unit text not null check (unit in ('kg', 'g', 'L', 'mL', 'lb', 'oz', 'gal')),
  cost_per_unit_cents int not null check (cost_per_unit_cents >= 0),
  unique (company_id, product, unit)
);

create table public.report_settings (
  company_id uuid primary key references public.companies (id) on delete cascade,
  weekly boolean not null default false,
  weekly_day int not null default 1 check (weekly_day between 0 and 6), -- 0 Sunday … 6 Saturday
  monthly boolean not null default true,
  recipients text[] not null default '{}',
  last_weekly_sent date,
  last_monthly_sent date
);

alter table public.labour_rates enable row level security;
alter table public.truck_costs enable row level security;
alter table public.material_prices enable row level security;
alter table public.report_settings enable row level security;
grant select, insert, update, delete on public.labour_rates, public.truck_costs, public.material_prices, public.report_settings to authenticated;

create policy labour_rates_owner on public.labour_rates for all to authenticated
  using (app.is_owner(company_id)) with check (app.is_owner(company_id));
create policy truck_costs_owner on public.truck_costs for all to authenticated
  using (app.is_owner(company_id)) with check (app.is_owner(company_id));
create policy material_prices_owner on public.material_prices for all to authenticated
  using (app.is_owner(company_id)) with check (app.is_owner(company_id));
create policy report_settings_owner on public.report_settings for all to authenticated
  using (app.is_owner(company_id)) with check (app.is_owner(company_id));

-- Owner, the app owner, or server code (no signed-in user, e.g. the scheduled report).
create or replace function app.assert_finance_access(p_company uuid) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if not (auth.uid() is null or app.is_owner(p_company) or app.is_platform_admin()) then
    raise exception 'finance is owner-only' using errcode = '42501';
  end if;
end;
$$;

-- ───────────────────────────── distance from GPS ─────────────────────────────
create or replace function app.km_between(lat1 float8, lng1 float8, lat2 float8, lng2 float8)
returns float8 language sql immutable as $$
  select 2 * 6371 * asin(sqrt(
    power(sin(radians(lat2 - lat1) / 2), 2)
    + cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2)));
$$;

-- km per crew per day. Skips poor fixes (> 50 m accuracy) and jumps faster than 150 km/h.
create or replace function app.crew_day_km(p_company uuid, p_from date, p_to date, p_tz text)
returns table (crew_id uuid, day date, km numeric)
language sql stable security definer set search_path = '' as $$
  with pts as (
    select g.crew_id, (g.recorded_at at time zone p_tz)::date as day, g.recorded_at, g.lat, g.lng,
           lag(g.lat) over w as plat, lag(g.lng) over w as plng, lag(g.recorded_at) over w as pat
    from public.gps_points g
    where g.company_id = p_company
      and (g.accuracy_m is null or g.accuracy_m <= 50)
      and (g.recorded_at at time zone p_tz)::date between p_from and p_to
    window w as (partition by g.crew_id, (g.recorded_at at time zone p_tz)::date order by g.recorded_at)
  ), seg as (
    select crew_id, day, app.km_between(plat, plng, lat, lng) as km,
           extract(epoch from recorded_at - pat) / 3600.0 as h
    from pts where plat is not null
  )
  select crew_id, day, round(coalesce(sum(km) filter (where h > 0 and km / h <= 150), 0)::numeric, 2)
  from seg group by crew_id, day;
$$;

-- ───────────────────────────── profit per job ─────────────────────────────
create or replace function public.job_profit(p_company uuid, p_from date, p_to date)
returns table (
  visit_id uuid, day date, address text, customer text, crew_id uuid, crew text, source app.visit_source,
  revenue_cents int, labour_cents int, fuel_cents int, materials_cents int, truck_cents int,
  profit_cents int, minutes int, complaint boolean
)
language plpgsql stable security definer set search_path = '' as $$
declare
  tz text;
  fuel_price numeric;
begin
  perform app.assert_finance_access(p_company);
  select c.timezone, coalesce(c.fuel_price_per_l, 0) into tz, fuel_price from public.companies c where c.id = p_company;

  return query
  with v as (
    select vv.id, vv.crew_id, vv.property_id, vv.source, vv.price_cents,
           (vv.done_at at time zone tz)::date as d,
           greatest(1, round(extract(epoch from vv.done_at - coalesce(vv.arrived_at, vv.done_at - make_interval(mins => vv.est_minutes))) / 60))::int as mins
    from public.visits vv
    where vv.company_id = p_company and vv.status = 'done' and vv.done_at is not null
      and (vv.done_at at time zone tz)::date between p_from and p_to
  ),
  day_mins as (select v.crew_id, v.d, sum(v.mins) as total, count(*) as n from v group by v.crew_id, v.d),
  lunch as (
    select sp.shift_id, sum(extract(epoch from coalesce(sp.ended_at, now()) - sp.started_at) / 60) as m
    from public.shift_pauses sp where sp.company_id = p_company and sp.kind = 'lunch' group by sp.shift_id
  ),
  paid as ( -- paid minutes per crew per day: shift length minus unpaid lunch
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
    select distinct on (t.crew_id) t.crew_id, coalesce(t.l_per_100km, 0) as l100,
           coalesce(tc.value_cents::numeric / tc.life_years / tc.work_hours_per_year, 0) as cph
    from public.trucks t left join public.truck_costs tc on tc.truck_id = t.id
    where t.company_id = p_company and t.crew_id is not null
    order by t.crew_id, t.name
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
    select v.id, v.d, p.address, cu.full_name, v.crew_id, cr.name as crew_name, v.source, v.price_cents, v.mins,
           -- share of the crew's paid day that this job carries
           (coalesce(pd.m, dm.total) * v.mins / nullif(dm.total, 0)) as paid_mins,
           r.cph as rate_cph, tr.cph as truck_cph, tr.l100, k.km, dm.n, m.cents as mat_cents,
           (c.visit_id is not null) as is_complaint
    from v
    join day_mins dm on dm.crew_id is not distinct from v.crew_id and dm.d = v.d
    join public.properties p on p.id = v.property_id
    join public.customers cu on cu.id = p.customer_id
    left join public.crews cr on cr.id = v.crew_id
    left join paid pd on pd.crew_id = v.crew_id and pd.d = v.d
    left join rate r on r.crew_id = v.crew_id
    left join truck tr on tr.crew_id = v.crew_id
    left join km k on k.crew_id = v.crew_id and k.day = v.d
    left join mat m on m.visit_id = v.id
    left join comp c on c.visit_id = v.id
  ),
  y as (
    select x.*,
           round(coalesce(x.rate_cph, 0) * coalesce(x.paid_mins, 0) / 60)::int as labour,
           round(coalesce(x.km, 0) / nullif(x.n, 0) * coalesce(x.l100, 0) / 100 * fuel_price * 100)::int as fuel,
           round(coalesce(x.mat_cents, 0))::int as materials,
           round(coalesce(x.truck_cph, 0) * coalesce(x.paid_mins, 0) / 60)::int as truck
    from x
  )
  select y.id, y.d, y.address, y.full_name, y.crew_id, y.crew_name, y.source, y.price_cents,
         coalesce(y.labour, 0), coalesce(y.fuel, 0), y.materials, y.truck,
         y.price_cents - coalesce(y.labour, 0) - coalesce(y.fuel, 0) - y.materials - y.truck,
         y.mins, y.is_complaint
  from y
  order by y.d, y.crew_name, y.address;
end;
$$;
revoke all on function public.job_profit(uuid, date, date) from public, anon;
grant execute on function public.job_profit(uuid, date, date) to authenticated;

-- ───────────────────────────── business summary ─────────────────────────────
-- One call for the owner's Finance screen and the emailed report.
create or replace function public.finance_summary(p_company uuid, p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  result jsonb;
begin
  perform app.assert_finance_access(p_company);

  with j as (select * from public.job_profit(p_company, p_from, p_to)),
  tz as (select c.timezone, c.monthly_revenue_target_cents as target from public.companies c where c.id = p_company),
  leads as (
    select l.crew_id, count(*) as created, count(*) filter (where l.status = 'won') as won,
           count(*) filter (where l.status in ('new', 'quoted')) as open
    from public.leads l, tz
    where l.company_id = p_company and (l.created_at at time zone tz.timezone)::date between p_from and p_to
    group by l.crew_id
  ),
  crews as (
    select cr.id, cr.name from public.crews cr where cr.company_id = p_company
  ),
  per_crew as (
    select c.id, c.name,
           coalesce(sum(j.revenue_cents), 0) as revenue, coalesce(sum(j.profit_cents), 0) as profit,
           count(j.visit_id) as jobs, coalesce(sum(j.minutes), 0) as minutes,
           count(*) filter (where j.complaint) as complaints
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
    'truck_cents', (select coalesce(sum(truck_cents), 0) from j),
    'profit_cents', (select coalesce(sum(profit_cents), 0) from j),
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
    'monthly_target_cents', (select target from tz),
    'crews', coalesce((
      select jsonb_agg(jsonb_build_object(
        'crew_id', pc.id, 'name', pc.name, 'revenue_cents', pc.revenue, 'profit_cents', pc.profit,
        'jobs', pc.jobs, 'minutes', pc.minutes, 'complaints', pc.complaints,
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

-- ───────────────────────────── payroll ─────────────────────────────
-- Hours per person per week, from their crew's shifts. Lunch is unpaid, breaks are paid.
-- Overtime is anything over the company's weekly threshold, paid at its multiplier.
-- Note: until each person clocks in on their own, everyone on a crew gets the crew's hours.
create or replace function public.payroll(p_company uuid, p_from date, p_to date)
returns table (
  crew_member_id uuid, full_name text, crew text, week_start date,
  paid_hours numeric, regular_hours numeric, overtime_hours numeric,
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
  )
  select cm.id, cm.full_name, cr.name, sh.wk,
         round(sh.h::numeric, 2),
         round(least(sh.h, ot_after)::numeric, 2),
         round(greatest(sh.h - ot_after, 0)::numeric, 2),
         coalesce(lr.hourly_cost_cents, 0),
         round(coalesce(lr.hourly_cost_cents, 0) * (least(sh.h, ot_after) + greatest(sh.h - ot_after, 0) * ot_mult))::int
  from shift_hours sh
  join public.crew_members cm on cm.crew_id = sh.crew_id and cm.company_id = p_company and cm.active
  left join public.crews cr on cr.id = sh.crew_id
  left join public.labour_rates lr on lr.crew_member_id = cm.id
  order by sh.wk, cr.name, cm.full_name;
end;
$$;
revoke all on function public.payroll(uuid, date, date) from public, anon;
grant execute on function public.payroll(uuid, date, date) to authenticated;
