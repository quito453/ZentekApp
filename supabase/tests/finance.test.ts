import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { asUser, count, freshDb } from "./helpers";

// A worked example with numbers you can check by hand.
//
// Crew 1 on Monday 2026-10-05 (Toronto time): shift 08:00–16:00, 30 min unpaid lunch → 450 paid min.
// People: Marco $30/h + Luis $25/h = $55/h for the crew. Truck: $40,000 over 5 years × 1,600 h = $5/h.
// GPS: 22.24 km that day; truck uses 20 L/100 km; fuel $1.50/L → 222¢ per job (3 jobs).
//
// Job   on site  share of 450 paid min  labour   truck   fuel  materials  price    profit
// V1    60 min   150 min                $137.50  $12.50  $2.22  —         $250.00   $97.78
// V2    30 min    75 min                 $68.75   $6.25  $2.22  $12.00     $80.00   −$9.22  (losing)
// V3    90 min   225 min                $206.25  $18.75  $2.22  —         $400.00  $172.78  (complaint)

const CO = "f0000000-0000-0000-0000-000000000001";
const OTHER_CO = "f0000000-0000-0000-0000-000000000002";
const CREW = "f1000000-0000-0000-0000-000000000001";
const OWNER = "00000000-0000-0000-0000-00000000f001";
const DISP = "00000000-0000-0000-0000-00000000f002";
const TECH = "00000000-0000-0000-0000-00000000f003";
const OTHER_OWNER = "00000000-0000-0000-0000-00000000f004";
const MARCO = "f2000000-0000-0000-0000-000000000001";
const LUIS = "f2000000-0000-0000-0000-000000000002";
const TRUCK = "f3000000-0000-0000-0000-000000000001";
const SVC = "f4000000-0000-0000-0000-000000000001";
const V1 = "f5000000-0000-0000-0000-000000000001";
const V2 = "f5000000-0000-0000-0000-000000000002";
const V3 = "f5000000-0000-0000-0000-000000000003";
const SHIFT_MON = "f6000000-0000-0000-0000-000000000001";

let db: PGlite;

beforeAll(async () => {
  db = await freshDb();
  const props = [1, 2, 3].map((i) => `('f7000000-0000-0000-0000-00000000000${i}', '${CO}', 'f8000000-0000-0000-0000-00000000000${i}', '${i} Birch Cres')`).join(",");
  const custs = [1, 2, 3].map((i) => `('f8000000-0000-0000-0000-00000000000${i}', '${CO}', 'Customer ${i}')`).join(",");
  // Tue–Sat: 10 h shifts with no lunch → the week reaches 57.5 paid hours.
  const extraShifts = [6, 7, 8, 9, 10]
    .map((d) => `('${CO}', '${CREW}', '2026-10-${String(d).padStart(2, "0")} 12:00:00+00', '2026-10-${String(d).padStart(2, "0")} 22:00:00+00')`)
    .join(",");
  await db.exec(`
    insert into auth.users (id) values ('${OWNER}'), ('${DISP}'), ('${TECH}'), ('${OTHER_OWNER}');
    insert into public.companies (id, name, region, seat_limit, fuel_price_per_l, monthly_revenue_target_cents)
      values ('${CO}', 'Green Ridge', 'ON', 10, 1.50, 2000000), ('${OTHER_CO}', 'Other', 'ON', 10, 1.50, null);
    insert into public.crews (id, company_id, name) values ('${CREW}', '${CO}', 'Crew 1');
    insert into public.memberships (user_id, company_id, role, crew_id) values
      ('${OWNER}', '${CO}', 'owner', null), ('${DISP}', '${CO}', 'dispatcher', null),
      ('${TECH}', '${CO}', 'crew', '${CREW}'), ('${OTHER_OWNER}', '${OTHER_CO}', 'owner', null);
    insert into public.crew_members (id, company_id, crew_id, full_name) values
      ('${MARCO}', '${CO}', '${CREW}', 'Marco R.'), ('${LUIS}', '${CO}', '${CREW}', 'Luis G.');
    insert into public.labour_rates (crew_member_id, company_id, hourly_cost_cents) values
      ('${MARCO}', '${CO}', 3000), ('${LUIS}', '${CO}', 2500);
    insert into public.trucks (id, company_id, crew_id, name, l_per_100km) values ('${TRUCK}', '${CO}', '${CREW}', 'Truck 12', 20);
    insert into public.truck_costs (truck_id, company_id, value_cents, life_years, work_hours_per_year) values ('${TRUCK}', '${CO}', 4000000, 5, 1600);
    insert into public.material_prices (company_id, product, unit, cost_per_unit_cents) values ('${CO}', 'Fall fertilizer', 'kg', 120);
    insert into public.services (id, company_id, key, name_en) values ('${SVC}', '${CO}', 'regular', 'Regular visit');
    insert into public.customers (id, company_id, full_name) values ${custs};
    insert into public.properties (id, company_id, customer_id, address) values ${props};

    insert into public.shifts (id, company_id, crew_id, clock_in_at, clock_out_at) values
      ('${SHIFT_MON}', '${CO}', '${CREW}', '2026-10-05 12:00:00+00', '2026-10-05 20:00:00+00');
    insert into public.shifts (company_id, crew_id, clock_in_at, clock_out_at) values ${extraShifts};
    insert into public.shift_pauses (company_id, shift_id, crew_id, kind, started_at, ended_at) values
      ('${CO}', '${SHIFT_MON}', '${CREW}', 'lunch', '2026-10-05 16:30:00+00', '2026-10-05 17:00:00+00'),
      ('${CO}', '${SHIFT_MON}', '${CREW}', 'break', '2026-10-05 14:30:00+00', '2026-10-05 14:45:00+00');

    insert into public.visits (id, company_id, property_id, service_id, source, scheduled_on, crew_id, price_cents, status, arrived_at, done_at) values
      ('${V1}', '${CO}', 'f7000000-0000-0000-0000-000000000001', '${SVC}', 'plan', '2026-10-05', '${CREW}', 25000, 'done', '2026-10-05 13:00:00+00', '2026-10-05 14:00:00+00'),
      ('${V2}', '${CO}', 'f7000000-0000-0000-0000-000000000002', '${SVC}', 'lead_won', '2026-10-05', '${CREW}', 8000, 'done', '2026-10-05 15:00:00+00', '2026-10-05 15:30:00+00'),
      ('${V3}', '${CO}', 'f7000000-0000-0000-0000-000000000003', '${SVC}', 'new_customer', '2026-10-05', '${CREW}', 40000, 'done', '2026-10-05 16:00:00+00', '2026-10-05 17:30:00+00');
    insert into public.material_applications (company_id, visit_id, crew_id, product, amount, unit) values ('${CO}', '${V2}', '${CREW}', 'fall fertilizer', 10, 'kg');
    insert into public.office_items (company_id, kind, visit_id, crew_id, title) values ('${CO}', 'complaint', '${V3}', '${CREW}', 'Clippings on driveway');

    -- GPS: two 0.1° steps north (11.12 km each, ~33 km/h), one inaccurate fix, one impossible jump.
    insert into public.gps_points (company_id, crew_id, recorded_at, lat, lng, accuracy_m) values
      ('${CO}', '${CREW}', '2026-10-05 12:10:00+00', 43.0, -79.0, 8),
      ('${CO}', '${CREW}', '2026-10-05 12:20:00+00', 43.05, -79.3, 400),
      ('${CO}', '${CREW}', '2026-10-05 12:30:00+00', 43.1, -79.0, 8),
      ('${CO}', '${CREW}', '2026-10-05 12:50:00+00', 43.2, -79.0, 8),
      ('${CO}', '${CREW}', '2026-10-05 12:51:00+00', 44.0, -79.0, 8);

    insert into public.leads (company_id, property_id, crew_id, kind, status, created_at) values
      ('${CO}', 'f7000000-0000-0000-0000-000000000001', '${CREW}', 'aeration', 'won', '2026-10-05 15:00:00+00'),
      ('${CO}', 'f7000000-0000-0000-0000-000000000002', '${CREW}', 'dead_shrub', 'new', '2026-10-05 15:10:00+00'),
      ('${CO}', 'f7000000-0000-0000-0000-000000000003', '${CREW}', 'aeration', 'lost', '2026-10-05 16:10:00+00');
  `);
});

type Job = { visit_id: string; revenue_cents: number; labour_cents: number; fuel_cents: number; materials_cents: number; truck_cents: number; profit_cents: number; complaint: boolean };

describe("profit per job", () => {
  it("matches the worked example", async () => {
    const r = await asUser(db, OWNER, (tx) => tx.query<Job>("select * from public.job_profit($1, '2026-10-05', '2026-10-05')", [CO]));
    const byId = Object.fromEntries(r.rows.map((j) => [j.visit_id, j]));
    expect(byId[V1]).toMatchObject({ revenue_cents: 25000, labour_cents: 13750, truck_cents: 1250, fuel_cents: 222, materials_cents: 0, profit_cents: 9778, complaint: false });
    expect(byId[V2]).toMatchObject({ revenue_cents: 8000, labour_cents: 6875, truck_cents: 625, fuel_cents: 222, materials_cents: 1200, profit_cents: -922 });
    expect(byId[V3]).toMatchObject({ labour_cents: 20625, truck_cents: 1875, profit_cents: 17278, complaint: true });
  });

  it("ignores inaccurate fixes and impossible jumps when measuring km", async () => {
    const r = await db.query<{ km: string }>("select km from app.crew_day_km($1, '2026-10-05', '2026-10-05', 'America/Toronto')", [CO]);
    expect(Number(r.rows[0]?.km)).toBeCloseTo(22.24, 1);
  });
});

describe("business summary", () => {
  it("adds up revenue, costs, mix, leads and complaints", async () => {
    const r = await asUser(db, OWNER, (tx) => tx.query<{ s: Record<string, any> }>("select public.finance_summary($1, '2026-10-01', '2026-10-31') as s", [CO]));
    const s = r.rows[0]!.s;
    expect(s).toMatchObject({
      jobs: 3, revenue_cents: 73000, labour_cents: 41250, fuel_cents: 666, materials_cents: 1200, truck_cents: 3750,
      profit_cents: 26134, losing_jobs: 1, complaint_jobs: 1, monthly_target_cents: 2000000,
      mix: { regular_cents: 25000, new_customer_cents: 40000, upsell_cents: 8000, other_cents: 0 },
      leads: { created: 3, won: 1, open: 1 },
    });
    expect(s.crews[0]).toMatchObject({ name: "Crew 1", jobs: 3, revenue_cents: 73000, profit_cents: 26134, complaints: 1, leads_created: 3, leads_won: 1 });
  });

  it("is empty, not an error, for a period with no work", async () => {
    const r = await asUser(db, OWNER, (tx) => tx.query<{ s: Record<string, any> }>("select public.finance_summary($1, '2026-09-01', '2026-09-30') as s", [CO]));
    expect(r.rows[0]!.s).toMatchObject({ jobs: 0, revenue_cents: 0, profit_cents: 0 });
  });
});

describe("payroll", () => {
  it("removes unpaid lunch, keeps paid breaks, and pays overtime past 44 h", async () => {
    const r = await asUser(db, OWNER, (tx) =>
      tx.query<{ full_name: string; week_start: string; paid_hours: string; regular_hours: string; overtime_hours: string; cost_cents: number }>(
        "select * from public.payroll($1, '2026-10-01', '2026-10-31')",
        [CO],
      ),
    );
    const marco = r.rows.find((x) => x.full_name === "Marco R.")!;
    expect(Number(marco.paid_hours)).toBe(57.5); // 7.5 + 5 × 10
    expect(Number(marco.regular_hours)).toBe(44);
    expect(Number(marco.overtime_hours)).toBe(13.5);
    expect(marco.cost_cents).toBe(3000 * (44 + 13.5 * 1.5));
    expect(r.rows.find((x) => x.full_name === "Luis G.")!.cost_cents).toBe(2500 * (44 + 13.5 * 1.5));
  });
});

describe("finance is owner-only", () => {
  it("dispatchers and technicians cannot run the numbers", async () => {
    for (const who of [DISP, TECH]) {
      await expect(asUser(db, who, (tx) => tx.query("select * from public.job_profit($1, '2026-10-01', '2026-10-31')", [CO]))).rejects.toThrow(/owner-only/);
      await expect(asUser(db, who, (tx) => tx.query("select public.finance_summary($1, '2026-10-01', '2026-10-31')", [CO]))).rejects.toThrow(/owner-only/);
      await expect(asUser(db, who, (tx) => tx.query("select * from public.payroll($1, '2026-10-01', '2026-10-31')", [CO]))).rejects.toThrow(/owner-only/);
    }
  });

  it("dispatchers and technicians cannot see pay rates or truck costs", async () => {
    for (const who of [DISP, TECH]) {
      expect(await asUser(db, who, (tx) => count(tx, "select * from labour_rates"))).toBe(0);
      expect(await asUser(db, who, (tx) => count(tx, "select * from truck_costs"))).toBe(0);
      expect(await asUser(db, who, (tx) => count(tx, "select * from report_settings"))).toBe(0);
    }
    expect(await asUser(db, OWNER, (tx) => count(tx, "select * from labour_rates"))).toBe(2);
  });

  it("another company's owner sees nothing", async () => {
    await expect(asUser(db, OTHER_OWNER, (tx) => tx.query("select public.finance_summary($1, '2026-10-01', '2026-10-31')", [CO]))).rejects.toThrow(/owner-only/);
    expect(await asUser(db, OTHER_OWNER, (tx) => count(tx, "select * from labour_rates"))).toBe(0);
  });

  it("an owner can set pay rates and report settings", async () => {
    await asUser(db, OWNER, async (tx) => {
      await tx.query("update labour_rates set hourly_cost_cents = 3100 where crew_member_id = $1", [MARCO]);
      await tx.query("insert into report_settings (company_id, weekly, weekly_day, monthly, recipients) values ($1, true, 1, true, '{owner@example.com}')", [CO]);
    });
    expect(await asUser(db, OWNER, (tx) => count(tx, "select * from report_settings"))).toBe(1);
    await asUser(db, OWNER, (tx) => tx.query("update labour_rates set hourly_cost_cents = 3000 where crew_member_id = $1", [MARCO]));
  });
});

describe("fixed costs and fuel receipts", () => {
  it("shares fixed costs by what each job earns", async () => {
    // $1,000 a month → one day is 100000 × 12 ÷ 365.25 = 3285¢, split 250 : 80 : 400.
    await asUser(db, OWNER, (tx) => tx.query("insert into fixed_costs (company_id, name, monthly_cents) values ($1, 'Insurance', 100000)", [CO]));
    const r = await asUser(db, OWNER, (tx) => tx.query<Job & { fixed_share_cents: number; net_cents: number }>("select * from public.job_profit($1, '2026-10-05', '2026-10-05')", [CO]));
    const byId = Object.fromEntries(r.rows.map((j) => [j.visit_id, j]));
    expect(byId[V1]).toMatchObject({ fixed_share_cents: 1125, net_cents: 9778 - 1125 });
    expect(byId[V2]).toMatchObject({ fixed_share_cents: 360, net_cents: -922 - 360 });
    expect(byId[V3]).toMatchObject({ fixed_share_cents: 1800, net_cents: 17278 - 1800 });
    const s = await asUser(db, OWNER, (tx) => tx.query<{ s: Record<string, any> }>("select public.finance_summary($1, '2026-10-05', '2026-10-05') as s", [CO]));
    expect(s.rows[0]!.s).toMatchObject({ profit_cents: 26134, fixed_cents: 3285, net_profit_cents: 26134 - 3285 });
    await asUser(db, OWNER, (tx) => tx.query("delete from fixed_costs where company_id = $1", [CO]));
  });

  it("uses what crews paid at the pump when there are receipts", async () => {
    // 50 L for $90 → $1.80/L instead of the $1.50 setting: 7.41 km per job × 20 L/100 km × $1.80 = 267¢.
    await db.query("insert into fuel_receipts (company_id, crew_id, litres, amount_cents, bought_at) values ($1, $2, 50, 9000, '2026-10-05 15:00:00+00')", [CO, CREW]);
    const r = await asUser(db, OWNER, (tx) => tx.query<Job>("select * from public.job_profit($1, '2026-10-05', '2026-10-05')", [CO]));
    expect(r.rows.every((j) => j.fuel_cents === 267)).toBe(true);
    const s = await asUser(db, OWNER, (tx) => tx.query<{ s: Record<string, any> }>("select public.finance_summary($1, '2026-10-05', '2026-10-05') as s", [CO]));
    expect(s.rows[0]!.s).toMatchObject({ fuel_price_from: "receipts" });
    expect(Number(s.rows[0]!.s.fuel_price_per_l)).toBe(1.8);
    await db.query("delete from fuel_receipts where company_id = $1", [CO]);
  });

  it("keeps fixed costs and fetched fuel prices from dispatchers and crews", async () => {
    await asUser(db, OWNER, (tx) => tx.query("insert into fixed_costs (company_id, name, monthly_cents) values ($1, 'Shop rent', 150000)", [CO]));
    await db.query("insert into company_fuel_prices (company_id, fuel_type, price_per_l, period, area, source) values ($1, 'regular', 1.468, '2026-09-01', 'Toronto', 'Statistics Canada')", [CO]);
    for (const who of [DISP, TECH, OTHER_OWNER]) {
      expect(await asUser(db, who, (tx) => count(tx, "select * from fixed_costs"))).toBe(0);
      expect(await asUser(db, who, (tx) => count(tx, "select * from company_fuel_prices"))).toBe(0);
    }
    expect(await asUser(db, OWNER, (tx) => count(tx, "select * from company_fuel_prices"))).toBe(1);
    await expect(asUser(db, DISP, (tx) => tx.query("insert into fixed_costs (company_id, name, monthly_cents) values ($1, 'x', 1)", [CO]))).rejects.toThrow();
    // Only the server writes fetched prices, not even the owner.
    await expect(asUser(db, OWNER, (tx) => tx.query("insert into company_fuel_prices (company_id, fuel_type, price_per_l, period, area, source) values ($1, 'regular', 1, '2026-10-01', 'x', 'x')", [CO]))).rejects.toThrow();
    await asUser(db, OWNER, (tx) => tx.query("delete from fixed_costs where company_id = $1", [CO]));
  });
});
