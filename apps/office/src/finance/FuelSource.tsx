// Where the fuel price comes from: the area average (looked up online) or a price the owner types.
// Crews' fuel receipts always win when there are any, because that's what was really paid.
import { useEffect, useState } from "react";
import { CA_PROVINCES, FUEL_LABEL, STATCAN_CITIES, US_STATES, fuelSupport, type FuelType } from "@zentek/shared";
import { supabase } from "../supabase";

type Co = {
  country: string; region: string; fuel_type: FuelType; fuel_city: string | null; fuel_price_auto: boolean;
  fuel_price_per_l: number | null; fuel_price_source: string | null; fuel_price_period: string | null; fuel_price_checked_at: string | null;
};
const ERR: Record<string, string> = {
  no_source_for_country: "There's no public price source for this country yet. Type your price below.",
  eia_key_missing: "U.S. prices need the EIA_API_KEY secret on the server (a free key from eia.gov).",
  no_price_found: "The source had no recent price for this area. Try a nearby city, or type your price below.",
  owner_only: "Only the company owner can change fuel prices.",
};
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short" }) : "never");
const periodText = (d: string | null, country: string) =>
  !d ? "" : new Date(d + "T12:00:00").toLocaleDateString("en-CA", country === "CA" ? { month: "long", year: "numeric" } : { dateStyle: "medium" });

export function FuelSource({ companyId, onChange }: { companyId: string; onChange: () => void }) {
  const [co, setCo] = useState<Co | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function load() {
    const { data } = await supabase!
      .from("companies")
      .select("country, region, fuel_type, fuel_city, fuel_price_auto, fuel_price_per_l, fuel_price_source, fuel_price_period, fuel_price_checked_at")
      .eq("id", companyId)
      .single<Co>();
    setCo(data);
  }
  useEffect(() => void load(), [companyId]);
  if (!co) return null;

  const regions = co.country === "CA" ? CA_PROVINCES : co.country === "US" ? US_STATES : [];
  const cities = co.country === "CA" ? STATCAN_CITIES[co.region] ?? [] : [];
  const support = fuelSupport(co.country);

  async function save(patch: Partial<Co>) {
    const next = { ...co!, ...patch };
    if (patch.country) { next.region = patch.country === "CA" ? "ON" : patch.country === "US" ? "NY" : next.region; next.fuel_city = null; }
    if (patch.region && next.country === "CA") next.fuel_city = (STATCAN_CITIES[patch.region] ?? [])[0] ?? null;
    if (!fuelSupport(next.country).auto) next.fuel_price_auto = false;
    setCo(next);
    const { error } = await supabase!
      .from("companies")
      .update({ country: next.country, region: next.region, fuel_type: next.fuel_type, fuel_city: next.fuel_city, fuel_price_auto: next.fuel_price_auto })
      .eq("id", companyId);
    setMsg(error ? { ok: false, text: error.message } : null);
  }

  async function checkNow() {
    setBusy(true);
    setMsg(null);
    const { data, error } = await supabase!.functions.invoke("fuel-prices", { body: { company_id: companyId } });
    setBusy(false);
    if (error) {
      const code = (await (error as { context?: Response })?.context?.json?.().catch(() => null))?.error ?? error.message;
      return setMsg({ ok: false, text: ERR[code] ?? `Couldn't reach the price source (${code}). Try again later.` });
    }
    setMsg({ ok: true, text: `Updated: $${Number(data.pricePerL).toFixed(3)} per litre (${data.source}).` });
    await load();
    onChange();
  }

  return (
    <section className="card stack">
      <h2>Fuel price</h2>
      <p className="muted">
        Fuel cost per job = kilometres driven (from GPS) × your truck's litres per 100 km × the fuel price. When crews log fuel receipts, the price they
        actually paid is used for that week or month.
      </p>
      <div className="inline-form">
        <label>
          Country
          <select value={co.country} onChange={(e) => void save({ country: e.target.value })}>
            <option value="CA">Canada</option>
            <option value="US">United States</option>
            <option value="OTHER">Another country</option>
          </select>
        </label>
        {regions.length > 0 && (
          <label>
            {co.country === "CA" ? "Province or territory" : "State"}
            <select value={co.region} onChange={(e) => void save({ region: e.target.value })}>
              {regions.map(([c, n]) => <option key={c} value={c}>{n}</option>)}
            </select>
          </label>
        )}
        {co.country === "CA" && (
          <label>
            Closest city with published prices
            <select value={co.fuel_city ?? ""} onChange={(e) => void save({ fuel_city: e.target.value || null })}>
              {cities.map((c) => <option key={c} value={c}>{c}</option>)}
              <option value="">Canada average</option>
            </select>
          </label>
        )}
        <label>
          Your trucks use
          <select value={co.fuel_type} onChange={(e) => void save({ fuel_type: e.target.value as FuelType })}>
            {(["regular", "diesel"] as FuelType[]).map((f) => <option key={f} value={f}>{FUEL_LABEL[f]}</option>)}
          </select>
        </label>
        <p className="muted small-text">{support.note}</p>
        {support.auto && (
          <label className="check-row">
            <input type="checkbox" checked={co.fuel_price_auto} onChange={(e) => void save({ fuel_price_auto: e.target.checked })} />
            Keep the fuel price up to date automatically (checked every day)
          </label>
        )}
      </div>
      <div className="fuel-now">
        <div>
          <span className="muted small-text">Price in use</span>
          <strong className="big-price">{co.fuel_price_per_l ? `$${Number(co.fuel_price_per_l).toFixed(3)}/L` : "Not set"}</strong>
          <span className="muted small-text">
            {co.fuel_price_source ? `${co.fuel_price_source}${co.fuel_price_period ? `, ${periodText(co.fuel_price_period, co.country)}` : ""}. Checked ${when(co.fuel_price_checked_at)}.` : "Typed in by you."}
          </span>
        </div>
        {support.auto && (
          <button className="small primary" disabled={busy} onClick={() => void checkNow()}>
            {busy ? "Checking…" : "Check the price now"}
          </button>
        )}
      </div>
      {msg && <p className={msg.ok ? "ok" : "error"} role="status">{msg.text}</p>}
    </section>
  );
}
