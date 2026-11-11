// Runs the real migrations in PGlite (Postgres compiled to WebAssembly) with a small stand-in
// for Supabase's `auth` schema, so row-level security can be tested without Docker or a project.
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const MIGRATIONS = fileURLToPath(new URL("../migrations/", import.meta.url));

const SUPABASE_STANDIN = `
  create role authenticated nologin;
  create role anon nologin;
  -- What Edge Functions use. Like on Supabase: skips row-level security and gets the public tables,
  -- but nothing in the app schema unless a migration grants it.
  create role service_role nologin bypassrls;
  alter default privileges in schema public grant all on tables to service_role;
  alter default privileges in schema public grant all on sequences to service_role;
  alter default privileges in schema public grant all on functions to service_role;
  create schema auth;
  create table auth.users (id uuid primary key);
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  grant usage on schema auth to authenticated, anon;
  grant execute on function auth.uid() to authenticated, anon;
`;

export async function freshDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(SUPABASE_STANDIN);
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
    await db.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
  }
  return db;
}

/** Run `fn` as a signed-in user, the way Supabase runs API requests (role `authenticated`). */
export async function asUser<T>(db: PGlite, userId: string, fn: (tx: Transaction) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.exec("set local role authenticated");
    await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [userId]);
    return fn(tx);
  });
}

export async function count(tx: Transaction, sql: string, params: unknown[] = []): Promise<number> {
  const r = await tx.query<{ n: number }>(`select count(*)::int as n from (${sql}) q`, params);
  return r.rows[0]?.n ?? 0;
}
