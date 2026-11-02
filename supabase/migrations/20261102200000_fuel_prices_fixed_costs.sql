-- Fuel prices from public sources, and fixed costs shared across jobs by what each job earns.
--
-- Fuel price for a job, best source first:
--   1. what the crews actually paid: fuel receipts in the period (total paid ÷ litres)
--   2. companies.fuel_price_per_l, which the fuel-prices Edge Function keeps up to date from the
--      area average when the owner turns on automatic prices (or the owner types it in)
--
-- Fixed costs (insurance, shop rent, phones, software, office pay, loan payments) are entered per
-- month. For any period they are prorated by days (× 12 ÷ 365.25), then shared across that
-- period's jobs in proportion to each job's price: a $2,000 job carries ten times the share of a
-- $200 job. Everything here is owner-only, like the rest of Finance.

-- ───────────────────────────── where to look up fuel prices ─────────────────────────────
alter table public.companies add column fuel_type text not null default 'regular' check (fuel_type in ('regular', 'diesel'));
alter table public.companies add column fuel_city text;                 -- Canada: the Statistics Canada city closest to the company
alter table public.companies add column fuel_price_auto boolean not null default false;
alter table public.companies add column fuel_price_source text;         -- e.g. "Statistics Canada · Toronto · regular, self-serve"
alter table public.companies add column fuel_price_period date;         -- the week or month the price is for
alter table public.companies add column fuel_price_checked_at timestamptz;

-- Every price the app has fetched, so finance can show where a number came from.
create table public.company_fuel_prices (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  fuel_type text not null check (fuel_type in ('regular', 'diesel')),
  price_per_l numeric(7, 4) not null check (price_per_l > 0),
  currency text not null default 'CAD',
  period date not null,
  area text not null,
  source text not null,
  source_url text,
  fetched_at timestamptz not null default now(),
  unique (company_id, fuel_type, period, source, area)
);

-- ───────────────────────────── fixed costs ─────────────────────────────
create table public.fixed_costs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 80),
  monthly_cents int not null check (monthly_cents >= 0),
  created_at timestamptz not null default now()
);
create index fixed_costs_company on public.fixed_costs (company_id);

alter table public.company_fuel_prices enable row level security;
alter table public.fixed_costs enable row level security;
grant select on public.company_fuel_prices to authenticated;
grant select, insert, update, delete on public.fixed_costs to authenticated;

-- Fetched prices: owners read them; only the server (the Edge Function) writes them.
-- Dispatchers and crews get no policy, so they see nothing.
create policy company_fuel_prices_owner_read on public.company_fuel_prices for select to authenticated
  using (app.is_owner(company_id));
create policy fixed_costs_owner on public.fixed_costs for all to authenticated
  using (app.is_owner(company_id)) with check (app.is_owner(company_id));

-- ───────────────────────────── fuel price used for a period ─────────────────────────────
create or replace function app.fuel_price_for(p_company uuid, p_from date, p_to date, p_tz text)
returns numeric language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select sum(r.amount_cents)::numeric / 100 / nullif(sum(r.litres), 0)
       from public.fuel_receipts r
      where r.company_id = p_company and r.litres > 0
        and (r.bought_at at time zone p_tz)::date between p_from and p_to),
    (select c.fuel_price_per_l from public.companies c where c.id = p_company),
    0);
$$;

-- Fixed costs for a period, prorated by days.
create or replace function app.fixed_cents_for(p_company uuid, p_from date, p_to date)
returns int language sql stable security definer set search_path = '' as $$
  select round(coalesce(sum(f.monthly_cents), 0) * 12 / 365.25 * (p_to - p_from + 1))::int
  from public.fixed_costs f where f.company_id = p_company;
$$;

-- ───────────────────────────── profit per job ─────────────────────────────
-- Same as before, plus: fuel from receipts when there are any, the job's share of fixed costs,
-- and profit after that share. The return type changes, so the function is dropped first.
drop function public.job_profit(uuid, date, date);
create function public.job_profit(p_company uuid, p_from date, p_to date)
returns table (
  visit_id uuid, day date, address text, customer text, crew_id uuid, crew text, source app.visit_source,
  revenue_cents int, labour_cents int, fuel_cents int, materials_cents int, truck_cents int,
  profit_cents int, minutes int, complaint boolean, fixed_share_cents int, net_cents int
)
language plpgsql stable security definer set search_path = '' as $$
declare
  tz text;
  fuel_price numeric;
  fixed_total int;
begin
  perform app.assert_finance_access(p_company);
  select c.timezone into tz from public.companies c where c.id = p_company;
  fuel_price := app.fuel_price_for(p_company, p_from, p_to, tz);
  fixed_total := app.fixed_cents_for(p_company, p_from, p_to);

  return query
  with v as (
    select vv.id, vv.crew_id, vv.property_id, vv.source, vv.price_cents,
           (vv.done_at at time zone tz)::date as d,
           greatest(1, round(extract(epoch from vv.done_at - coalesce(vv.arrived_at, vv.done_at - make_interval(mins => vv.est_minutes))) / 60))::int as mins
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
           round(coalesce(x.truck_cph, 0) * coalesce(x.paid_mins, 0) / 60)::int as truck,
           -- share of fixed costs in proportion to what this job earns
           coalesce(round(fixed_total * x.price_cents / nullif((select cents from total_rev), 0)), 0)::int as fixed_share
    from x
  )
  select y.id, y.d, y.address, y.full_name, y.crew_id, y.crew_name, y.source, y.price_cents,
         coalesce(y.labour, 0), coalesce(y.fuel, 0), y.materials, y.truck,
         y.price_cents - coalesce(y.labour, 0) - coalesce(y.fuel, 0) - y.materials - y.truck,
         y.mins, y.is_complaint, y.fixed_share,
         y.price_cents - coalesce(y.labour, 0) - coalesce(y.fuel, 0) - y.materials - y.truck - y.fixed_share
  from y
  order by y.d, y.crew_name, y.address;
end;
$$;
revoke all on function public.job_profit(uuid, date, date) from public, anon;
grant execute on function public.job_profit(uuid, date, date) to authenticated;

-- ───────────────────────────── business summary ─────────────────────────────
-- Adds fixed costs for the period, profit after them, the fuel price used and where it came from.
create or replace function public.finance_summary(p_company uuid, p_from date, p_to date)
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
    'fixed_cents', fixed_total,
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
