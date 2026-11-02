// fuel-prices: looks up the area's average fuel price and saves it for the company.
//
// Two ways in:
//   1. Scheduled (pg_cron, once a day): header x-cron-secret = CRON_SECRET. Updates every active
//      company that has automatic fuel prices turned on. Sources publish weekly (US) or monthly
//      (Canada), so checking daily picks up each new number the day it comes out.
//   2. "Check the price now" from the owner's Costs and rates screen: POST { company_id }.
//
// Secrets: EIA_API_KEY (free, for US companies), CRON_SECRET, ALLOWED_ORIGINS.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.118.0";
import { adminClient, callerClient, callerId, corsHeaders, json } from "../_shared/http.ts";
import { eiaAreas, eiaUrl, readEia, readStatcan, statcanCoordinate, STATCAN_PID, STATCAN_WDS, type FuelQuote, type FuelType } from "../_shared/fuel.ts";

type Company = { id: string; country: string; region: string; fuel_type: FuelType; fuel_city: string | null; fuel_price_auto: boolean };

const TIMEOUT = 20_000;
let statcanMeta: unknown = null; // the table layout rarely changes; keep it for the life of the function

async function postJson(url: string, body: unknown): Promise<unknown> {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT) });
  if (!r.ok) throw new Error(`source_http_${r.status}`);
  return r.json();
}

async function canada(city: string | null, fuel: FuelType): Promise<FuelQuote | null> {
  statcanMeta ??= await postJson(`${STATCAN_WDS}/getCubeMetadata`, [{ productId: STATCAN_PID }]);
  const where = statcanCoordinate(statcanMeta, city, fuel);
  if (!where) return null;
  const data = await postJson(`${STATCAN_WDS}/getDataFromCubePidCoordAndLatestNPeriods`, [{ productId: STATCAN_PID, coordinate: where.coordinate, latestN: 3 }]);
  return readStatcan(data, where.area, fuel);
}

async function unitedStates(state: string, fuel: FuelType): Promise<FuelQuote | null> {
  const key = Deno.env.get("EIA_API_KEY");
  if (!key) throw new Error("eia_key_missing");
  for (const area of eiaAreas(state, fuel)) {
    const r = await fetch(eiaUrl(key, area.code, fuel), { signal: AbortSignal.timeout(TIMEOUT) });
    if (!r.ok) throw new Error(`source_http_${r.status}`);
    const quote = readEia(await r.json(), area.name, fuel);
    if (quote) return quote;
  }
  return null;
}

export async function lookup(c: Company): Promise<FuelQuote | null> {
  if (c.country === "CA") return canada(c.fuel_city, c.fuel_type);
  if (c.country === "US") return unitedStates(c.region, c.fuel_type);
  throw new Error("no_source_for_country");
}

async function save(db: SupabaseClient, c: Company, q: FuelQuote) {
  await db.from("company_fuel_prices").upsert(
    { company_id: c.id, fuel_type: c.fuel_type, price_per_l: q.pricePerL, currency: q.currency, period: q.period, area: q.area, source: q.source, source_url: q.sourceUrl, fetched_at: new Date().toISOString() },
    { onConflict: "company_id,fuel_type,period,source,area" },
  );
  const { error } = await db
    .from("companies")
    .update({ fuel_price_per_l: q.pricePerL, fuel_price_source: q.source, fuel_price_period: q.period, fuel_price_checked_at: new Date().toISOString() })
    .eq("id", c.id);
  if (error) throw new Error(error.message);
}

const COLS = "id, country, region, fuel_type, fuel_city, fuel_price_auto";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req) });
  if (req.method !== "POST") return json(req, 405, { error: "method_not_allowed" });
  const admin = adminClient();

  // 1. Scheduled run
  const cronSecret = Deno.env.get("CRON_SECRET");
  if (cronSecret && req.headers.get("x-cron-secret") === cronSecret) {
    const { data } = await admin.from("companies").select(COLS).eq("active", true).eq("fuel_price_auto", true);
    const results = [];
    for (const c of (data ?? []) as Company[]) {
      try {
        const q = await lookup(c);
        if (q) await save(admin, c, q);
        results.push({ company_id: c.id, price_per_l: q?.pricePerL ?? null, period: q?.period ?? null });
      } catch (e) {
        results.push({ company_id: c.id, error: (e as Error).message });
      }
    }
    return json(req, 200, { results });
  }

  // 2. The owner asks now
  const caller = callerClient(req);
  const me = await callerId(caller);
  if (!me) return json(req, 401, { error: "sign_in_required" });
  const body = await req.json().catch(() => null);
  const companyId = typeof body?.company_id === "string" ? body.company_id : "";
  const { data: role } = await caller.from("memberships").select("role").eq("user_id", me).eq("company_id", companyId).maybeSingle<{ role: string }>();
  if (role?.role !== "owner") return json(req, 403, { error: "owner_only" });

  const { data: company } = await admin.from("companies").select(COLS).eq("id", companyId).single<Company>();
  if (!company) return json(req, 404, { error: "not_found" });
  try {
    const q = await lookup(company);
    if (!q) return json(req, 404, { error: "no_price_found" });
    await save(admin, company, q);
    return json(req, 200, q);
  } catch (e) {
    return json(req, 502, { error: (e as Error).message });
  }
});
