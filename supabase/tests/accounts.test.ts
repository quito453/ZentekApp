import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { asUser, count, freshDb } from "./helpers";

const CO = "c0000000-0000-0000-0000-000000000001";
const OTHER_CO = "c0000000-0000-0000-0000-000000000002";
const CREW = "c1000000-0000-0000-0000-000000000001";
const ADMIN = "00000000-0000-0000-0000-00000000ad01"; // the app owner
const OWNER = "00000000-0000-0000-0000-00000000c001";
const DISP = "00000000-0000-0000-0000-00000000c002";
const TECH = "00000000-0000-0000-0000-00000000c003";
const TECH2 = "00000000-0000-0000-0000-00000000c004";
const OTHER_OWNER = "00000000-0000-0000-0000-00000000d001";
const NEW_USER = "00000000-0000-0000-0000-00000000c005";
const SERVER_USER = "00000000-0000-0000-0000-00000000d002";

let db: PGlite;

async function asAnon<T>(fn: (tx: Parameters<Parameters<PGlite["transaction"]>[0]>[0]) => Promise<T>) {
  return db.transaction(async (tx) => {
    await tx.exec("set local role anon");
    return fn(tx);
  });
}

beforeAll(async () => {
  db = await freshDb();
  await db.exec(`
    insert into auth.users (id) values ('${ADMIN}'), ('${OWNER}'), ('${DISP}'), ('${TECH}'), ('${TECH2}'), ('${OTHER_OWNER}'), ('${NEW_USER}');
    insert into app.platform_admins (user_id) values ('${ADMIN}');
    insert into public.companies (id, name, region, seat_limit) values ('${CO}', 'Green Ridge', 'ON', 4), ('${OTHER_CO}', 'Other', 'ON', 2);
    insert into public.crews (id, company_id, name) values ('${CREW}', '${CO}', 'Crew 2');
    insert into public.memberships (user_id, company_id, role, crew_id) values
      ('${OWNER}', '${CO}', 'owner', null), ('${DISP}', '${CO}', 'dispatcher', null),
      ('${TECH}', '${CO}', 'crew', '${CREW}'), ('${OTHER_OWNER}', '${OTHER_CO}', 'owner', null);
    insert into public.profiles (user_id, company_id, username, full_name) values
      ('${TECH}', '${CO}', 'marco.r', 'Marco R.'), ('${DISP}', '${CO}', 'rosa.m', 'Rosa M.');
  `);
});

describe("only the app owner creates logins and sets licences", () => {
  it("a company owner cannot add a login", async () => {
    await expect(
      asUser(db, OWNER, (tx) => tx.query("insert into memberships (user_id, company_id, role, crew_id) values ($1, $2, 'crew', $3)", [NEW_USER, CO, CREW])),
    ).rejects.toThrow();
  });

  it("a dispatcher cannot add a login or a username", async () => {
    await expect(
      asUser(db, DISP, (tx) => tx.query("insert into memberships (user_id, company_id, role, crew_id) values ($1, $2, 'crew', $3)", [NEW_USER, CO, CREW])),
    ).rejects.toThrow();
    await expect(
      asUser(db, DISP, (tx) => tx.query("insert into profiles (user_id, company_id, username, full_name) values ($1, $2, 'new.tech', 'New')", [NEW_USER, CO])),
    ).rejects.toThrow();
  });

  it("a company owner cannot raise their own licence count, but can rename the company", async () => {
    await expect(asUser(db, OWNER, (tx) => tx.query("update companies set seat_limit = 99 where id = $1", [CO]))).rejects.toThrow(/app owner/);
    const r = await asUser(db, OWNER, (tx) => tx.query("update companies set name = 'Green Ridge Lawn & Snow' where id = $1", [CO]));
    expect(r.affectedRows).toBe(1);
  });

  it("the app owner adds a login, up to the licence count", async () => {
    await asUser(db, ADMIN, async (tx) => {
      await tx.query("insert into memberships (user_id, company_id, role, crew_id) values ($1, $2, 'crew', $3)", [TECH2, CO, CREW]);
      await tx.query("insert into profiles (user_id, company_id, username, full_name) values ($1, $2, 'luis.g', 'Luis G.')", [TECH2, CO]);
    });
    // 4 of 4 licences used: the fifth login is refused, even for the app owner.
    await expect(
      asUser(db, ADMIN, (tx) => tx.query("insert into memberships (user_id, company_id, role, crew_id) values ($1, $2, 'crew', $3)", [NEW_USER, CO, CREW])),
    ).rejects.toThrow(/licence limit/);
    await asUser(db, ADMIN, (tx) => tx.query("update companies set seat_limit = 5 where id = $1", [CO]));
    await asUser(db, ADMIN, (tx) => tx.query("insert into memberships (user_id, company_id, role, crew_id) values ($1, $2, 'crew', $3)", [NEW_USER, CO, CREW]));
    expect(await asUser(db, OWNER, (tx) => count(tx, "select * from memberships"))).toBe(5);
  });

  it("the server (Edge Functions) can add a login and change licences", async () => {
    await db.exec(`insert into auth.users (id) values ('${SERVER_USER}')`);
    await db.transaction(async (tx) => {
      await tx.exec("set local role service_role");
      await tx.query("update companies set seat_limit = 3 where id = $1", [OTHER_CO]);
      // The way Supabase's data API writes rows: column types are named, so app.role must be usable.
      await tx.query(
        `insert into memberships (user_id, company_id, role, crew_id)
         select * from json_to_recordset($1::json) as _("user_id" uuid, "company_id" uuid, "role" app.role, "crew_id" uuid)`,
        [JSON.stringify([{ user_id: SERVER_USER, company_id: OTHER_CO, role: "dispatcher", crew_id: null }])],
      );
      await tx.query("insert into profiles (user_id, company_id, username, full_name) values ($1, $2, 'sam.k', 'Sam K.')", [SERVER_USER, OTHER_CO]);
    });
    expect(await asUser(db, OTHER_OWNER, (tx) => count(tx, "select * from memberships"))).toBe(2);
  });

  it("the office sees its company's usernames; technicians see only their own", async () => {
    expect(await asUser(db, DISP, (tx) => count(tx, "select * from profiles"))).toBeGreaterThanOrEqual(2);
    expect(await asUser(db, TECH, (tx) => count(tx, "select * from profiles"))).toBe(1);
    expect(await asUser(db, OTHER_OWNER, (tx) => count(tx, "select * from profiles where company_id = $1", [CO]))).toBe(0);
  });

  it("nobody but the database can see who the app owners are", async () => {
    await expect(asUser(db, OWNER, (tx) => tx.query("select * from app.platform_admins"))).rejects.toThrow();
    expect((await asUser(db, ADMIN, (tx) => tx.query<{ a: boolean }>("select public.is_platform_admin() as a"))).rows[0]?.a).toBe(true);
    expect((await asUser(db, OWNER, (tx) => tx.query<{ a: boolean }>("select public.is_platform_admin() as a"))).rows[0]?.a).toBe(false);
  });
});

describe("who can set a new password", () => {
  const can = (caller: string, target: string) =>
    asUser(db, caller, (tx) => tx.query<{ ok: boolean }>("select public.can_reset_password($1) as ok", [target])).then((r) => r.rows[0]?.ok);

  it("dispatcher and owner can for technicians in their company", async () => {
    expect(await can(DISP, TECH)).toBe(true);
    expect(await can(OWNER, TECH)).toBe(true);
  });
  it("owner can for a dispatcher, dispatcher cannot for the owner", async () => {
    expect(await can(OWNER, DISP)).toBe(true);
    expect(await can(DISP, OWNER)).toBe(false);
  });
  it("technicians cannot, and nobody can across companies", async () => {
    expect(await can(TECH, TECH2)).toBe(false);
    expect(await can(OTHER_OWNER, TECH)).toBe(false);
  });
  it("the app owner can for anyone", async () => {
    expect(await can(ADMIN, OWNER)).toBe(true);
  });
});

describe("forgot password", () => {
  it("a signed-out technician's request reaches the dispatcher once", async () => {
    await asAnon((tx) => tx.query("select public.request_password_reset($1)", ["  Marco.R "]));
    await asAnon((tx) => tx.query("select public.request_password_reset($1)", ["marco.r"]));
    const rows = await asUser(db, DISP, (tx) =>
      tx.query<{ title: string; subject_user_id: string; crew_id: string }>("select title, subject_user_id, crew_id from office_items where kind = 'password_reset'"),
    );
    expect(rows.rows).toEqual([{ title: "Password reset: Marco R.", subject_user_id: TECH, crew_id: CREW }]);
  });

  it("an unknown username looks the same to the caller and creates nothing", async () => {
    await expect(asAnon((tx) => tx.query("select public.request_password_reset($1)", ["nobody.here"]))).resolves.toBeDefined();
    expect(await asUser(db, DISP, (tx) => count(tx, "select * from office_items where kind = 'password_reset'"))).toBe(1);
  });

  it("signed-out visitors cannot read the requests", async () => {
    await expect(asAnon((tx) => tx.query("select * from office_items"))).rejects.toThrow();
  });

  it("another company never sees the request", async () => {
    expect(await asUser(db, OTHER_OWNER, (tx) => count(tx, "select * from office_items"))).toBe(0);
  });
});
