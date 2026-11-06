import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { asUser, count, freshDb } from "./helpers";

// A worked example with numbers you can check by hand.
//
// Crew 1 on Monday 2026-10-05 (Toronto time): shift 08:00–16:00, 30 min unpaid lunch → 450 paid min.
// People: Marco $30/h + Luis $25/h = $55/h for the crew.
// GPS: 22.24 km that day → 7.41 km per job. Truck uses 20 L/100 km; fuel $1.50/L → 222¢ per job.
// Maintenance: 15¢ per km → 111¢ per job. The truck ($40,000 over 5 years) is depreciation, a fixed cost.
//
// Job   on site  share of 450 paid min  labour   maint  fuel   materials  price    profit
// V1    60 min   150 min                $137.50  $1.11  $2.22  —         $250.00  $109.17
// V2    30 min    75 min                 $68.75  $1.11  $2.22  $12.00     $80.00   −$4.08  (losing)
// V3    90 min   225 min                $206.25  $1.11  $2.22  —         $400.00  $190.42  (complaint)
//
// Trips: shift starts 08:00, V1 arrives 09:00 (60 min drive), leaves 10:00; V2 arrives 11:00 (60);
// V3 arrives 12:00 after leaving V2 at 11:30 (30). Drive 2.5 h, on site 3 h, other 2 h of 7.5 paid.

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

type Job = { visit_id: string; revenue_cents: number; labour_cents: number; fuel_cents: number; materials_cents: number; maintenance_cents: number; profit_cents: number; complaint: boolean };

describe("profit per job", () => {
  it("matches the worked example", async () => {
    const r = await asUser(db, OWNER, (tx) => tx.query<Job>("select * from public.job_profit($1, '2026-10-05', '2026-10-05')", [CO]));
    const byId = Object.fromEntries(r.rows.map((j) => [j.visit_id, j]));
    expect(byId[V1]).toMatchObject({ revenue_cents: 25000, labour_cents: 13750, maintenance_cents: 111, fuel_cents: 222, materials_cents: 0, profit_cents: 10917, complaint: false });
    expect(byId[V2]).toMatchObject({ revenue_cents: 8000, labour_cents: 6875, maintenance_cents: 111, fuel_cents: 222, materials_cents: 1200, profit_cents: -408 });
    expect(byId[V3]).toMatchObject({ labour_cents: 20625, maintenance_cents: 111, profit_cents: 19042, complaint: true });
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
      jobs: 3, revenue_cents: 73000, labour_cents: 41250, fuel_cents: 666, materials_cents: 1200, maintenance_cents: 333,
      profit_cents: 29551, losing_jobs: 1, complaint_jobs: 1, monthly_target_cents: 2000000,
      mix: { regular_cents: 25000, new_customer_cents: 40000, upsell_cents: 8000, other_cents: 0 },
      leads: { created: 3, won: 1, open: 1 },
    });
    expect(s.crews[0]).toMatchObject({ name: "Crew 1", jobs: 3, revenue_cents: 73000, profit_cents: 29551, complaints: 1, leads_created: 3, leads_won: 1 });
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
    // Truck depreciation alone: $40,000 ÷ 5 ÷ 12 = $666.67 a month → 2190¢ for one day.
    let r = await asUser(db, OWNER, (tx) => tx.query<Job & { fixed_share_cents: number; net_cents: number }>("select * from public.job_profit($1, '2026-10-05', '2026-10-05')", [CO]));
    expect(Object.fromEntries(r.rows.map((j) => [j.visit_id, j.fixed_share_cents]))).toEqual({ [V1]: 750, [V2]: 240, [V3]: 1200 });
    // Plus $1,000 a month insurance → (100000 + 66666.67) × 12 ÷ 365.25 = 5476¢, split 250 : 80 : 400.
    await asUser(db, OWNER, (tx) => tx.query("insert into fixed_costs (company_id, name, monthly_cents) values ($1, 'Insurance', 100000)", [CO]));
    r = await asUser(db, OWNER, (tx) => tx.query<Job & { fixed_share_cents: number; net_cents: number }>("select * from public.job_profit($1, '2026-10-05', '2026-10-05')", [CO]));
    const byId = Object.fromEntries(r.rows.map((j) => [j.visit_id, j]));
    expect(byId[V1]).toMatchObject({ fixed_share_cents: 1875, net_cents: 10917 - 1875 });
    expect(byId[V2]).toMatchObject({ fixed_share_cents: 600, net_cents: -408 - 600 });
    expect(byId[V3]).toMatchObject({ fixed_share_cents: 3001, net_cents: 19042 - 3001 });
    const s = await asUser(db, OWNER, (tx) => tx.query<{ s: Record<string, any> }>("select public.finance_summary($1, '2026-10-05', '2026-10-05') as s", [CO]));
    expect(s.rows[0]!.s).toMatchObject({ profit_cents: 29551, fixed_cents: 5476, depreciation_cents: 2190, net_profit_cents: 29551 - 5476 });
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

describe("trips, time on site and payroll split", () => {
  type Trip = { visit_id: string; from_address: string; drive_minutes: number; site_minutes: number; km: string; fuel_cents: number };
  it("measures each drive from the last stop (or the start of the shift)", async () => {
    const r = await asUser(db, OWNER, (tx) => tx.query<Trip>("select * from public.crew_trips($1, '2026-10-05', '2026-10-05')", [CO]));
    const byId = Object.fromEntries(r.rows.map((t) => [t.visit_id, t]));
    expect(byId[V1]).toMatchObject({ from_address: "Start of shift", drive_minutes: 60, site_minutes: 60 });
    expect(Number(byId[V1]!.km)).toBeCloseTo(22.24, 1);
    expect(byId[V1]!.fuel_cents).toBe(667); // 22.24 km × 20 L/100 km × $1.50
    expect(byId[V2]).toMatchObject({ from_address: "1 Birch Cres", drive_minutes: 60, site_minutes: 30, fuel_cents: 0 });
    expect(byId[V3]).toMatchObject({ from_address: "2 Birch Cres", drive_minutes: 30, site_minutes: 90 });
  });

  it("splits paid hours into on site, driving and other", async () => {
    const r = await asUser(db, OWNER, (tx) =>
      tx.query<{ full_name: string; paid_hours: string; on_site_hours: string; driving_hours: string; other_hours: string }>(
        "select * from public.payroll($1, '2026-10-05', '2026-10-05')", [CO]),
    );
    const marco = r.rows.find((x) => x.full_name === "Marco R.")!;
    expect([marco.paid_hours, marco.on_site_hours, marco.driving_hours, marco.other_hours].map(Number)).toEqual([7.5, 3, 2.5, 2]);
    const week = await asUser(db, OWNER, (tx) => tx.query<{ full_name: string; other_hours: string }>("select * from public.payroll($1, '2026-10-01', '2026-10-31')", [CO]));
    expect(Number(week.rows.find((x) => x.full_name === "Marco R.")!.other_hours)).toBe(52);
  });

  it("adds up profit and time per customer", async () => {
    const r = await asUser(db, OWNER, (tx) =>
      tx.query<{ address: string; visits: number; revenue_cents: number; profit_cents: number; site_minutes: number; drive_minutes: number }>(
        "select * from public.customer_profit($1, '2026-10-01', '2026-10-31')", [CO]),
    );
    expect(r.rows).toHaveLength(3);
    expect(r.rows.find((c) => c.address === "1 Birch Cres")).toMatchObject({ visits: 1, revenue_cents: 25000, profit_cents: 10917, site_minutes: 60, drive_minutes: 60 });
  });

  it("compares GPS with the odometer", async () => {
    await db.query(
      "insert into odometer_readings (company_id, truck_id, crew_id, reading_km, read_at) values ($1, $2, $3, 50000, '2026-10-05 11:55:00+00'), ($1, $2, $3, 50023, '2026-10-05 20:05:00+00')",
      [CO, TRUCK, CREW],
    );
    const r = await asUser(db, OWNER, (tx) => tx.query<{ odometer_km: number; gps_km: string; gap_pct: string }>("select * from public.gps_vs_odometer($1, '2026-10-05', '2026-10-05')", [CO]));
    expect(r.rows[0]!.odometer_km).toBe(23);
    expect(Number(r.rows[0]!.gps_km)).toBeCloseTo(22.24, 1);
    expect(Number(r.rows[0]!.gap_pct)).toBeCloseTo(3.3, 0);
    await db.query("delete from odometer_readings where company_id = $1", [CO]);
  });

  it("dispatchers and crews cannot run trips, customers or the odometer check", async () => {
    for (const fn of ["crew_trips", "customer_profit", "gps_vs_odometer"]) {
      await expect(asUser(db, DISP, (tx) => tx.query(`select * from public.${fn}($1, '2026-10-01', '2026-10-31')`, [CO]))).rejects.toThrow(/owner-only/);
    }
  });
});

describe("mowers", () => {
  it("adds mower fuel and maintenance for the time the engine runs", async () => {
    // One mower: 3 L/h, runs half the time on site, $1.50 per engine hour.
    // V1 60 min → 0.5 h → 1.5 L × $1.50 = 225¢ fuel, 75¢ maintenance.
    await db.query("insert into equipment (id, company_id, crew_id, name) values ('f3000000-0000-0000-0000-0000000000e1', $1, $2, 'Mower 1')", [CO, CREW]);
    await asUser(db, OWNER, (tx) =>
      tx.query("insert into equipment_costs (equipment_id, company_id, l_per_hour, use_share, value_cents, life_years) values ('f3000000-0000-0000-0000-0000000000e1', $1, 3, 0.5, 0, 5)", [CO]),
    );
    const r = await asUser(db, OWNER, (tx) => tx.query<Job>("select * from public.job_profit($1, '2026-10-05', '2026-10-05')", [CO]));
    const byId = Object.fromEntries(r.rows.map((j) => [j.visit_id, j]));
    expect([byId[V1]!.fuel_cents, byId[V2]!.fuel_cents, byId[V3]!.fuel_cents]).toEqual([222 + 225, 222 + 113, 222 + 338]);
    expect([byId[V1]!.maintenance_cents, byId[V2]!.maintenance_cents, byId[V3]!.maintenance_cents]).toEqual([111 + 75, 111 + 38, 111 + 113]);
    for (const who of [DISP, TECH]) expect(await asUser(db, who, (tx) => count(tx, "select * from equipment_costs"))).toBe(0);
    await db.query("delete from equipment where company_id = $1", [CO]);
  });
});

describe("bringing jobs in", () => {
  const job = (o: Record<string, unknown>) => ({ date: "2026-10-06", customer: "Customer 1", address: "1 Birch Cres", service: "Weekly mow", priceCents: 5500, crew: "crew 1", minutes: 40, area: "Birch", externalId: null, ...o });

  it("adds spreadsheet jobs to existing customers and properties, and skips bad rows", async () => {
    const jobs = [job({}), job({ customer: "New Person", address: "9 Elm St", crew: "Nobody" }), job({ date: "not a date" }), job({ priceCents: "55" })];
    const r = await asUser(db, OWNER, (tx) => tx.query<{ r: Record<string, number> }>("select public.import_jobs($1, 'october.csv', $2) as r", [CO, JSON.stringify(jobs)]));
    expect(r.rows[0]!.r).toEqual({ added: 2, updated: 0, skipped: 2 });
    const v = await db.query<{ address: string; status: string; crew_id: string | null; est_minutes: number; area: string }>(
      "select p.address, v.status, v.crew_id, v.est_minutes, p.area from visits v join properties p on p.id = v.property_id where v.arrival_source = 'import' order by p.address",
    );
    expect(v.rows).toEqual([
      { address: "1 Birch Cres", status: "done", crew_id: CREW, est_minutes: 40, area: "Birch" },
      { address: "9 Elm St", status: "done", crew_id: null, est_minutes: 40, area: "Birch" },
    ]);
    expect((await db.query("select * from customers where company_id = $1", [CO])).rows).toHaveLength(4);
    expect(await asUser(db, OWNER, (tx) => count(tx, "select * from imports where rows_added = 2 and rows_skipped = 2"))).toBe(1);
    await expect(asUser(db, DISP, (tx) => tx.query("select public.import_jobs($1, 'x.csv', '[]')", [CO]))).rejects.toThrow(/owner only/);
  });

  it("takes jobs from Zapier with a key, once per job number", async () => {
    const key = (await asUser(db, OWNER, (tx) => tx.query<{ k: string }>("select public.create_api_key($1, 'Zapier – Yardbook') as k", [CO]))).rows[0]!.k;
    const send = (jobs: unknown[]) => db.query<{ r: Record<string, number> }>("select public.ingest_jobs($1, 'zapier', $2) as r", [key, JSON.stringify(jobs)]);
    expect((await send([job({ externalId: "Y-1", date: "2099-05-01" })])).rows[0]!.r).toEqual({ added: 1, updated: 0, skipped: 0 });
    expect((await send([job({ externalId: "Y-1", date: "2099-05-01", priceCents: 6000 })])).rows[0]!.r).toEqual({ added: 0, updated: 1, skipped: 0 });
    const v = await db.query<{ status: string; price_cents: number }>("select status, price_cents from visits where external_id = 'Y-1'");
    expect(v.rows).toEqual([{ status: "scheduled", price_cents: 6000 }]); // future jobs go to the crew's route
    await expect(db.query("select public.ingest_jobs('cc_live_nope', 'zapier', '[]')")).rejects.toThrow(/unknown or revoked/);
    await asUser(db, OWNER, (tx) => tx.query("update api_keys set revoked_at = now()"));
    await expect(send([])).rejects.toThrow(/unknown or revoked/);
    // Signed-in users can't call it at all.
    await expect(asUser(db, OWNER, (tx) => tx.query("select public.ingest_jobs($1, 'zapier', '[]')", [key]))).rejects.toThrow(/permission denied/);
  });
});
