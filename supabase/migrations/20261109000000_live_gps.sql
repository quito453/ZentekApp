-- Live GPS: where each crew is right now, for the dispatcher's live map.
--
-- • Tablets make an id for each GPS point (client_id) so a point sent twice after a dropped
--   connection is stored once. The table's own id stays a server-made number.
-- • live_crews(): one row per crew for today: clocked in or not, on a break, last known position,
--   the stop they're at, the next stop, progress and kilometres so far. Office only.
-- • crew_trail(): the GPS trail for one crew and day, to draw on the map. Office only.
-- Positions are only recorded while a crew is clocked in (the tablet stops at clock-out), and the
-- live view only shows the current shift.

alter table public.gps_points add column client_id uuid;
create unique index gps_points_client_id on public.gps_points (client_id);
create index gps_points_company_time on public.gps_points (company_id, recorded_at desc);
alter table public.gps_points add column heading_deg real;

create or replace function public.live_crews(p_company uuid, p_now timestamptz default now())
returns table (
  crew_id uuid, crew text, color text,
  shift_id uuid, clocked_in_at timestamptz, on_break boolean,
  lat double precision, lng double precision, seen_at timestamptz, speed_mps real, accuracy_m real,
  stops_done int, stops_total int,
  at_visit_id uuid, at_address text, at_since timestamptz,
  next_visit_id uuid, next_address text, next_lat double precision, next_lng double precision,
  km_today numeric
)
language plpgsql stable security definer set search_path = '' as $$
declare
  tz text;
  today date;
begin
  if not app.is_office(p_company) then
    raise exception 'office only' using errcode = '42501';
  end if;
  select c.timezone into tz from public.companies c where c.id = p_company;
  today := (p_now at time zone tz)::date;

  return query
  with sh as (
    select distinct on (s.crew_id) s.crew_id, s.id, s.clock_in_at, s.clock_out_at
    from public.shifts s
    where s.company_id = p_company and (s.clock_in_at at time zone tz)::date = today and s.clock_in_at <= p_now
    order by s.crew_id, s.clock_in_at desc
  ),
  open_sh as (select * from sh where sh.clock_out_at is null or sh.clock_out_at > p_now),
  brk as (
    select sp.shift_id from public.shift_pauses sp
    where sp.company_id = p_company and sp.started_at <= p_now and (sp.ended_at is null or sp.ended_at > p_now)
  ),
  last_pt as (
    select distinct on (g.crew_id) g.crew_id, g.lat, g.lng, g.recorded_at, g.speed_mps, g.accuracy_m
    from public.gps_points g join open_sh o on o.crew_id = g.crew_id
    where g.company_id = p_company and g.recorded_at >= o.clock_in_at and g.recorded_at <= p_now
    order by g.crew_id, g.recorded_at desc
  ),
  v as (
    select vv.*, p.address, p.lat as plat, p.lng as plng
    from public.visits vv join public.properties p on p.id = vv.property_id
    where vv.company_id = p_company and vv.scheduled_on = today and vv.crew_id is not null
      and vv.status not in ('skipped', 'moved')
  ),
  prog as (
    select v.crew_id, count(*) filter (where v.status = 'done' or v.departed_at is not null)::int as done, count(*)::int as total
    from v group by v.crew_id
  ),
  here as (
    select distinct on (v.crew_id) v.crew_id, v.id, v.address, v.arrived_at
    from v where v.status = 'on_site' and v.departed_at is null
    order by v.crew_id, v.arrived_at desc
  ),
  nxt as (
    select distinct on (v.crew_id) v.crew_id, v.id, v.address, v.plat, v.plng
    from v where v.status in ('scheduled', 'en_route') and v.departed_at is null
    order by v.crew_id, v.route_order nulls last, v.id
  )
  select cr.id, cr.name, cr.color,
         o.id, o.clock_in_at, (o.id is not null and exists (select 1 from brk where brk.shift_id = o.id)),
         lp.lat, lp.lng, lp.recorded_at, lp.speed_mps, lp.accuracy_m,
         coalesce(pr.done, 0), coalesce(pr.total, 0),
         h.id, h.address, h.arrived_at,
         n.id, n.address, n.plat, n.plng,
         case when o.id is null then 0 else app.gps_km(cr.id, o.clock_in_at, p_now) end
  from public.crews cr
  left join open_sh o on o.crew_id = cr.id
  left join last_pt lp on lp.crew_id = cr.id
  left join prog pr on pr.crew_id = cr.id
  left join here h on h.crew_id = cr.id
  left join nxt n on n.crew_id = cr.id
  where cr.company_id = p_company and cr.active
  order by cr.name;
end;
$$;
revoke all on function public.live_crews(uuid, timestamptz) from public, anon;
grant execute on function public.live_crews(uuid, timestamptz) to authenticated;

create or replace function public.crew_trail(p_company uuid, p_crew uuid, p_day date)
returns table (lat double precision, lng double precision, recorded_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
declare
  tz text;
begin
  if not app.is_office(p_company) then
    raise exception 'office only' using errcode = '42501';
  end if;
  select c.timezone into tz from public.companies c where c.id = p_company;
  return query
  select g.lat, g.lng, g.recorded_at from public.gps_points g
  where g.company_id = p_company and g.crew_id = p_crew and (g.recorded_at at time zone tz)::date = p_day
    and (g.accuracy_m is null or g.accuracy_m <= 50)
  order by g.recorded_at
  limit 5000;
end;
$$;
revoke all on function public.crew_trail(uuid, uuid, date) from public, anon;
grant execute on function public.crew_trail(uuid, uuid, date) to authenticated;
