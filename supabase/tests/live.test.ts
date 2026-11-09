import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { asUser, freshDb } from "./helpers";

// Monday 2026-10-05, Toronto. Crew 1 clocked in at 08:00 (12:00 UTC) and has three stops:
// 1 done, 2 on site since 09:40, 3 next. Crew 2 hasn't clocked in. "Now" is 10:00 (14:00 UTC).
const CO = "e0000000-0000-0000-0000-000000000001";
const OTHER_CO = "e0000000-0000-0000-0000-000000000002";
const C1 = "e1000000-0000-0000-0000-000000000001";
const C2 = "e1000000-0000-0000-0000-000000000002";
const OWNER = "00000000-0000-0000-0000-00000000e001";
const DISP = "00000000-0000-0000-0000-00000000e002";
const TECH = "00000000-0000-0000-0000-00000000e003";
const OTHER_OWNER = "00000000-0000-0000-0000-00000000e004";
const SHIFT = "e6000000-0000-0000-0000-000000000001";
const SVC = "e4000000-0000-0000-0000-000000000001";
const V = (i: number) => `e5000000-0000-0000-0000-00000000000${i}`;
const NOW = "2026-10-05 14:00:00+00";

let db: PGlite;

beforeAll(async () => {
  db = await freshDb();
  await db.exec(`
    insert into auth.users (id) values ('${OWNER}'), ('${DISP}'), ('${TECH}'), ('${OTHER_OWNER}');
    insert into public.companies (id, name, region, seat_limit) values ('${CO}', 'Green Ridge', 'ON', 10), ('${OTHER_CO}', 'Other', 'ON', 10);
    insert into public.crews (id, company_id, name, color) values ('${C1}', '${CO}', 'Crew 1', '#1f5fbf'), ('${C2}', '${CO}', 'Crew 2', null);
    insert into public.memberships (user_id, company_id, role, crew_id) values
      ('${OWNER}', '${CO}', 'owner', null), ('${DISP}', '${CO}', 'dispatcher', null),
      ('${TECH}', '${CO}', 'crew', '${C1}'), ('${OTHER_OWNER}', '${OTHER_CO}', 'owner', null);
    insert into public.services (id, company_id, key, name_en) values ('${SVC}', '${CO}', 'mow', 'Mow');
    insert into public.customers (id, company_id, full_name) values ('e8000000-0000-0000-0000-000000000001', '${CO}', 'Customer');
    insert into public.properties (id, company_id, customer_id, address, lat, lng) values
      ('e7000000-0000-0000-0000-000000000001', '${CO}', 'e8000000-0000-0000-0000-000000000001', '1 Birch Cres', 43.70, -79.40),
      ('e7000000-0000-0000-0000-000000000002', '${CO}', 'e8000000-0000-0000-0000-000000000001', '2 Birch Cres', 43.71, -79.40),
      ('e7000000-0000-0000-0000-000000000003', '${CO}', 'e8000000-0000-0000-0000-000000000001', '3 Birch Cres', 43.72, -79.40);
    insert into public.shifts (id, company_id, crew_id, clock_in_at) values ('${SHIFT}', '${CO}', '${C1}', '2026-10-05 12:00:00+00');
    insert into public.visits (id, company_id, property_id, service_id, scheduled_on, crew_id, route_order, est_minutes, price_cents, status, arrived_at, departed_at, done_at) values
      ('${V(1)}', '${CO}', 'e7000000-0000-0000-0000-000000000001', '${SVC}', '2026-10-05', '${C1}', 1, 30, 5000, 'done', '2026-10-05 12:30:00+00', '2026-10-05 13:10:00+00', '2026-10-05 13:10:00+00'),
      ('${V(2)}', '${CO}', 'e7000000-0000-0000-0000-000000000002', '${SVC}', '2026-10-05', '${C1}', 2, 30, 5000, 'on_site', '2026-10-05 13:40:00+00', null, null),
      ('${V(3)}', '${CO}', 'e7000000-0000-0000-0000-000000000003', '${SVC}', '2026-10-05', '${C1}', 3, 30, 5000, 'scheduled', null, null, null);
    insert into public.gps_points (company_id, crew_id, shift_id, recorded_at, lat, lng, accuracy_m, speed_mps) values
      ('${CO}', '${C1}', '${SHIFT}', '2026-10-05 12:05:00+00', 43.69, -79.40, 8, 10),
      ('${CO}', '${C1}', '${SHIFT}', '2026-10-05 12:30:00+00', 43.70, -79.40, 8, 0),
      ('${CO}', '${C1}', '${SHIFT}', '2026-10-05 13:40:00+00', 43.71, -79.40, 8, 0),
      ('${CO}', '${C1}', '${SHIFT}', '2026-10-05 13:59:00+00', 43.7101, -79.4001, 6, 0),
      ('${CO}', '${C1}', '${SHIFT}', '2026-10-05 15:00:00+00', 43.80, -79.40, 6, 0);  -- after "now": ignored
  `);
});

type Live = { crew: string; shift_id: string | null; lat: number | null; seen_at: string | null; stops_done: number; stops_total: number; at_address: string | null; next_address: string | null; km_today: string; on_break: boolean };

describe("live crews", () => {
  it("shows where each crew is, what they're doing and what's next", async () => {
    const r = await asUser(db, DISP, (tx) => tx.query<Live>("select * from public.live_crews($1, $2)", [CO, NOW]));
    const [c1, c2] = r.rows;
    expect(c1).toMatchObject({ crew: "Crew 1", shift_id: SHIFT, stops_done: 1, stops_total: 3, at_address: "2 Birch Cres", next_address: "3 Birch Cres", on_break: false });
    expect(c1!.lat).toBeCloseTo(43.7101, 4);
    expect(new Date(c1!.seen_at!).toISOString()).toBe("2026-10-05T13:59:00.000Z");
    expect(Number(c1!.km_today)).toBeCloseTo(2.24, 1); // 43.69 → 43.71 ≈ 2.2 km
    expect(c2).toMatchObject({ crew: "Crew 2", shift_id: null, lat: null, stops_total: 0 });
  });

  it("shows a break while it's on", async () => {
    await db.query("insert into shift_pauses (company_id, shift_id, crew_id, kind, started_at) values ($1, $2, $3, 'lunch', '2026-10-05 13:50:00+00')", [CO, SHIFT, C1]);
    const r = await asUser(db, OWNER, (tx) => tx.query<Live>("select * from public.live_crews($1, $2)", [CO, NOW]));
    expect(r.rows[0]!.on_break).toBe(true);
    await db.query("delete from shift_pauses where shift_id = $1", [SHIFT]);
  });

  it("is for the office only, and only for its own company", async () => {
    await expect(asUser(db, TECH, (tx) => tx.query("select * from public.live_crews($1)", [CO]))).rejects.toThrow(/office only/);
    await expect(asUser(db, OTHER_OWNER, (tx) => tx.query("select * from public.live_crews($1)", [CO]))).rejects.toThrow(/office only/);
    await expect(asUser(db, TECH, (tx) => tx.query("select * from public.crew_trail($1, $2, '2026-10-05')", [CO, C1]))).rejects.toThrow(/office only/);
  });

  it("draws the day's trail", async () => {
    const r = await asUser(db, DISP, (tx) => tx.query<{ lat: number }>("select * from public.crew_trail($1, $2, '2026-10-05')", [CO, C1]));
    expect(r.rows.map((p) => p.lat)).toEqual([43.69, 43.7, 43.71, 43.7101, 43.8]);
  });
});

describe("points from the tablet", () => {
  it("stores a point sent twice only once", async () => {
    const id = "e9000000-0000-0000-0000-000000000001";
    const send = () =>
      asUser(db, TECH, (tx) =>
        tx.query(
          "insert into gps_points (client_id, company_id, crew_id, shift_id, recorded_at, lat, lng) values ($1, $2, $3, $4, '2026-10-05 13:59:30+00', 43.7102, -79.4) on conflict (client_id) do nothing",
          [id, CO, C1, SHIFT],
        ),
      );
    await send();
    await send();
    expect((await db.query("select * from gps_points where client_id = $1", [id])).rows).toHaveLength(1);
  });

  it("a crew can't add points for another crew", async () => {
    await expect(
      asUser(db, TECH, (tx) => tx.query("insert into gps_points (company_id, crew_id, recorded_at, lat, lng) values ($1, $2, now(), 1, 1)", [CO, C2])),
    ).rejects.toThrow();
  });
});
