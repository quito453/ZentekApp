import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { asUser, count, freshDb } from "./helpers";

// Fixed ids keep the tests readable.
const CO_A = "a0000000-0000-0000-0000-000000000001";
const CO_B = "b0000000-0000-0000-0000-000000000001";
const CREW_A1 = "a1000000-0000-0000-0000-000000000001";
const CREW_A2 = "a2000000-0000-0000-0000-000000000001";
const CREW_B1 = "b1000000-0000-0000-0000-000000000001";
const OWNER_A = "00000000-0000-0000-0000-0000000000a1";
const DISP_A = "00000000-0000-0000-0000-0000000000a2";
const TAB_A1 = "00000000-0000-0000-0000-0000000000a3"; // crew 1 tablet
const TAB_A2 = "00000000-0000-0000-0000-0000000000a4"; // crew 2 tablet
const OWNER_B = "00000000-0000-0000-0000-0000000000b1";
const PROP_A1 = "a0000000-0000-0000-0000-0000000000f1";
const PROP_A2 = "a0000000-0000-0000-0000-0000000000f2";
const VISIT_A1 = "a0000000-0000-0000-0000-0000000000e1";
const VISIT_A2 = "a0000000-0000-0000-0000-0000000000e2";
const SVC_A = "a0000000-0000-0000-0000-0000000000d1";
const SVC_B = "b0000000-0000-0000-0000-0000000000d1";

let db: PGlite;

beforeAll(async () => {
  db = await freshDb();
  await db.exec(`
    insert into auth.users (id) values ('${OWNER_A}'), ('${DISP_A}'), ('${TAB_A1}'), ('${TAB_A2}'), ('${OWNER_B}');
    insert into public.companies (id, name, region, seat_limit) values ('${CO_A}', 'Green Ridge', 'ON', 10), ('${CO_B}', 'Other Lawn Co', 'ON', 10);
    insert into public.crews (id, company_id, name) values ('${CREW_A1}', '${CO_A}', 'Crew 1'), ('${CREW_A2}', '${CO_A}', 'Crew 2'), ('${CREW_B1}', '${CO_B}', 'Crew 1');
    insert into public.memberships (user_id, company_id, role, crew_id) values
      ('${OWNER_A}', '${CO_A}', 'owner', null),
      ('${DISP_A}', '${CO_A}', 'dispatcher', null),
      ('${TAB_A1}', '${CO_A}', 'crew', '${CREW_A1}'),
      ('${TAB_A2}', '${CO_A}', 'crew', '${CREW_A2}'),
      ('${OWNER_B}', '${CO_B}', 'owner', null);
    insert into public.customers (id, company_id, full_name) values
      ('a0000000-0000-0000-0000-0000000000c1', '${CO_A}', 'Tremblay'),
      ('a0000000-0000-0000-0000-0000000000c2', '${CO_A}', 'Nguyen'),
      ('b0000000-0000-0000-0000-0000000000c1', '${CO_B}', 'Smith');
    insert into public.properties (id, company_id, customer_id, address) values
      ('${PROP_A1}', '${CO_A}', 'a0000000-0000-0000-0000-0000000000c1', '7 Birch Cres'),
      ('${PROP_A2}', '${CO_A}', 'a0000000-0000-0000-0000-0000000000c2', '19 Birch Cres'),
      ('b0000000-0000-0000-0000-0000000000f1', '${CO_B}', 'b0000000-0000-0000-0000-0000000000c1', '1 Main St');
    insert into public.property_notes (company_id, property_id, kind, text_en, text_es, created_by) values
      ('${CO_A}', '${PROP_A1}', 'gate', 'Gate code 4412', 'Código del portón 4412', '${DISP_A}');
    insert into public.services (id, company_id, key, name_en, tasks) values
      ('${SVC_A}', '${CO_A}', 'regular', 'Regular visit', '{mow,edge,trim,blow}'),
      ('${SVC_B}', '${CO_B}', 'regular', 'Regular visit', '{mow}');
    insert into public.plans (company_id, property_id, service_id, frequency, price_cents, starts_on) values
      ('${CO_A}', '${PROP_A1}', '${SVC_A}', 'weekly', 5500, current_date);
    insert into public.visits (id, company_id, property_id, service_id, scheduled_on, crew_id, price_cents) values
      ('${VISIT_A1}', '${CO_A}', '${PROP_A1}', '${SVC_A}', current_date, '${CREW_A1}', 5500),
      ('${VISIT_A2}', '${CO_A}', '${PROP_A2}', '${SVC_A}', current_date, '${CREW_A2}', 12000),
      ('b0000000-0000-0000-0000-0000000000e1', '${CO_B}', 'b0000000-0000-0000-0000-0000000000f1', '${SVC_B}', current_date, '${CREW_B1}', 4000);
    insert into public.fuel_receipts (company_id, crew_id, litres, amount_cents) values ('${CO_A}', '${CREW_A1}', 68.4, 10602);
  `);
});

describe("companies are kept apart", () => {
  it("an owner never sees another company's customers", async () => {
    const n = await asUser(db, OWNER_B, (tx) => count(tx, "select * from customers"));
    expect(n).toBe(1);
    const leaked = await asUser(db, OWNER_B, (tx) => count(tx, "select * from customers where company_id = $1", [CO_A]));
    expect(leaked).toBe(0);
  });

  it("an owner cannot edit another company", async () => {
    const r = await asUser(db, OWNER_B, (tx) => tx.query("update companies set name = 'x' where id = $1", [CO_A]));
    expect(r.affectedRows).toBe(0);
  });

  it("a crew tablet cannot record GPS for another company", async () => {
    await expect(
      asUser(db, TAB_A1, (tx) =>
        tx.query("insert into gps_points (company_id, crew_id, recorded_at, lat, lng) values ($1, $2, now(), 43.6, -79.4)", [CO_B, CREW_B1]),
      ),
    ).rejects.toThrow();
  });
});

describe("office roles", () => {
  it("the dispatcher sees every customer in the company", async () => {
    expect(await asUser(db, DISP_A, (tx) => count(tx, "select * from customers"))).toBe(2);
  });

  it("the dispatcher can create a job", async () => {
    const r = await asUser(db, DISP_A, (tx) =>
      tx.query("insert into visits (company_id, property_id, service_id, scheduled_on, source) values ($1, $2, $3, current_date + 7, 'lead_won')", [CO_A, PROP_A2, SVC_A]),
    );
    expect(r.affectedRows).toBe(1);
  });

  it("fuel receipts are owner-only to read", async () => {
    expect(await asUser(db, OWNER_A, (tx) => count(tx, "select * from fuel_receipts"))).toBe(1);
    expect(await asUser(db, DISP_A, (tx) => count(tx, "select * from fuel_receipts"))).toBe(0);
    expect(await asUser(db, TAB_A1, (tx) => count(tx, "select * from fuel_receipts"))).toBe(0);
  });
});

describe("crew tablets", () => {
  it("see only their own crew's visits, properties, notes and customers", async () => {
    await asUser(db, TAB_A1, async (tx) => {
      expect(await count(tx, "select * from visits")).toBe(1);
      expect(await count(tx, "select * from properties")).toBe(1);
      expect(await count(tx, "select * from property_notes")).toBe(1);
      expect(await count(tx, "select * from customers")).toBe(1);
    });
    await asUser(db, TAB_A2, async (tx) => {
      expect(await count(tx, "select * from property_notes")).toBe(0);
    });
  });

  it("cannot see plans or prices on plans", async () => {
    expect(await asUser(db, TAB_A1, (tx) => count(tx, "select * from plans"))).toBe(0);
  });

  it("can move their visit along", async () => {
    const r = await asUser(db, TAB_A1, (tx) =>
      tx.query("update visits set status = 'on_site', arrived_at = now() where id = $1", [VISIT_A1]),
    );
    expect(r.affectedRows).toBe(1);
  });

  it("cannot change the price, day or crew of their visit", async () => {
    await expect(asUser(db, TAB_A1, (tx) => tx.query("update visits set price_cents = 1 where id = $1", [VISIT_A1]))).rejects.toThrow(/progress fields/);
    await expect(asUser(db, TAB_A1, (tx) => tx.query("update visits set scheduled_on = current_date + 1 where id = $1", [VISIT_A1]))).rejects.toThrow(/progress fields/);
    await expect(asUser(db, TAB_A1, (tx) => tx.query("update visits set crew_id = $2 where id = $1", [VISIT_A1, CREW_A2]))).rejects.toThrow();
  });

  it("cannot touch another crew's visit", async () => {
    const r = await asUser(db, TAB_A1, (tx) => tx.query("update visits set status = 'done' where id = $1", [VISIT_A2]));
    expect(r.affectedRows).toBe(0);
  });

  it("cannot create jobs", async () => {
    await expect(
      asUser(db, TAB_A1, (tx) =>
        tx.query("insert into visits (company_id, property_id, service_id, scheduled_on, crew_id) values ($1, $2, $3, current_date, $4)", [CO_A, PROP_A1, SVC_A, CREW_A1]),
      ),
    ).rejects.toThrow();
  });

  it("record GPS, checklist ticks and fuel receipts for their own crew only", async () => {
    await asUser(db, TAB_A1, async (tx) => {
      await tx.query("insert into gps_points (company_id, crew_id, recorded_at, lat, lng) values ($1, $2, now(), 43.6, -79.4)", [CO_A, CREW_A1]);
      await tx.query("insert into visit_checks (visit_id, company_id, task) values ($1, $2, 'mow')", [VISIT_A1, CO_A]);
      await tx.query("insert into fuel_receipts (company_id, crew_id, litres, amount_cents) values ($1, $2, 40, 6200)", [CO_A, CREW_A1]);
    });
    await expect(
      asUser(db, TAB_A1, (tx) =>
        tx.query("insert into gps_points (company_id, crew_id, recorded_at, lat, lng) values ($1, $2, now(), 43.6, -79.4)", [CO_A, CREW_A2]),
      ),
    ).rejects.toThrow();
    await expect(
      asUser(db, TAB_A1, (tx) => tx.query("insert into visit_checks (visit_id, company_id, task) values ($1, $2, 'mow')", [VISIT_A2, CO_A])),
    ).rejects.toThrow();
  });

  it("can report a lead only for a property on their route", async () => {
    await asUser(db, TAB_A1, (tx) =>
      tx.query("insert into leads (company_id, property_id, crew_id, kind) values ($1, $2, $3, 'aeration')", [CO_A, PROP_A1, CREW_A1]),
    );
    await expect(
      asUser(db, TAB_A1, (tx) =>
        tx.query("insert into leads (company_id, property_id, crew_id, kind) values ($1, $2, $3, 'aeration')", [CO_A, PROP_A2, CREW_A1]),
      ),
    ).rejects.toThrow();
  });
});

describe("signed-out visitors", () => {
  it("get nothing", async () => {
    await expect(
      db.transaction(async (tx) => {
        await tx.exec("set local role anon");
        return tx.query("select * from customers");
      }),
    ).rejects.toThrow();
  });
});

describe("fixed costs and fetched fuel prices", () => {
  it("are the owner's alone", async () => {
    await asUser(db, OWNER_A, (tx) => tx.query("insert into fixed_costs (company_id, name, monthly_cents) values ($1, 'Insurance', 90000)", [CO_A]));
    await db.query("insert into company_fuel_prices (company_id, fuel_type, price_per_l, period, area, source) values ($1, 'regular', 1.45, '2026-09-01', 'Toronto', 'Statistics Canada')", [CO_A]);
    expect(await asUser(db, OWNER_A, (tx) => count(tx, "select * from fixed_costs"))).toBe(1);
    expect(await asUser(db, OWNER_A, (tx) => count(tx, "select * from company_fuel_prices"))).toBe(1);
    for (const who of [DISP_A, TAB_A1, OWNER_B]) {
      expect(await asUser(db, who, (tx) => count(tx, "select * from fixed_costs"))).toBe(0);
      expect(await asUser(db, who, (tx) => count(tx, "select * from company_fuel_prices"))).toBe(0);
    }
    await expect(asUser(db, TAB_A1, (tx) => tx.query("insert into fixed_costs (company_id, name, monthly_cents) values ($1, 'x', 1)", [CO_A]))).rejects.toThrow();
  });
});
