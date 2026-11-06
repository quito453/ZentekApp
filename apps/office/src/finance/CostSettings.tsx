// What things cost, split the way owners think about it:
//   Variable (grows with every job): crew pay, fuel, maintenance, materials.
//   Fixed (paid every month anyway): insurance, rent, software, licences… plus depreciation.
// Entered once by the owner; every job's profit is worked out from these.
import { useEffect, useState, type FormEvent } from "react";
import { supabase } from "../supabase";
import { FuelSource } from "./FuelSource";
import { FixedCosts } from "./FixedCosts";
import { Equipment } from "./Equipment";

type Crew = { id: string; name: string };
type Member = { id: string; full_name: string; crew_id: string | null; active: boolean };
type Material = { id: string; product: string; unit: string; cost_per_unit_cents: number };
type Company = {
  fuel_price_per_l: number | null; overtime_after_hours: number; overtime_multiplier: number; monthly_revenue_target_cents: number | null;
  season_start_month: number; season_end_month: number;
};
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const toCents = (v: string) => Math.round(parseFloat(v.replace(/[$,\s]/g, "")) * 100);
const dollars = (c: number | null | undefined) => (c === null || c === undefined ? "" : (c / 100).toFixed(2));

export function CostSettings({ companyId }: { companyId: string }) {
  const [crews, setCrews] = useState<Crew[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [rates, setRates] = useState<Record<string, number>>({});
  const [materials, setMaterials] = useState<Material[]>([]);
  const [company, setCompany] = useState<Company | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [tick, setTick] = useState(0);
  const reload = () => setTick((n) => n + 1);

  useEffect(() => {
    (async () => {
      const [c, m, r, mp, co] = await Promise.all([
        supabase!.from("crews").select("id, name").eq("company_id", companyId).order("name"),
        supabase!.from("crew_members").select("id, full_name, crew_id, active").eq("company_id", companyId).order("full_name"),
        supabase!.from("labour_rates").select("crew_member_id, hourly_cost_cents").eq("company_id", companyId),
        supabase!.from("material_prices").select("id, product, unit, cost_per_unit_cents").eq("company_id", companyId).order("product"),
        supabase!.from("companies").select("fuel_price_per_l, overtime_after_hours, overtime_multiplier, monthly_revenue_target_cents, season_start_month, season_end_month").eq("id", companyId).single(),
      ]);
      setCrews((c.data as Crew[]) ?? []);
      setMembers((m.data as Member[]) ?? []);
      setRates(Object.fromEntries(((r.data as { crew_member_id: string; hourly_cost_cents: number }[]) ?? []).map((x) => [x.crew_member_id, x.hourly_cost_cents])));
      setMaterials((mp.data as Material[]) ?? []);
      setCompany(co.data as Company);
    })();
  }, [companyId, tick]);

  const done = (error: { message: string } | null, text: string) => {
    setMsg(error ? { ok: false, text: error.message } : { ok: true, text });
    if (!error) reload();
  };
  const crewName = (id: string | null) => crews.find((c) => c.id === id)?.name ?? "No crew";

  // ── people ──
  async function saveRate(memberId: string, value: string) {
    const cents = toCents(value);
    if (!Number.isFinite(cents) || cents < 0) return setMsg({ ok: false, text: "Enter an hourly cost like 25.00" });
    const { error } = await supabase!.from("labour_rates").upsert({ crew_member_id: memberId, company_id: companyId, hourly_cost_cents: cents, updated_at: new Date().toISOString() });
    done(error, "Hourly cost saved.");
  }
  async function addMember(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const { data, error } = await supabase!.from("crew_members").insert({ company_id: companyId, full_name: String(f.get("name")).trim(), crew_id: f.get("crew") || null }).select("id").single<{ id: string }>();
    if (!error && f.get("rate")) await saveRate(data.id, String(f.get("rate")));
    else done(error, "Person added.");
    e.currentTarget.reset();
  }

  // ── materials ──
  async function addMaterial(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const { error } = await supabase!
      .from("material_prices")
      .upsert({ company_id: companyId, product: String(f.get("product")).trim(), unit: String(f.get("unit")), cost_per_unit_cents: toCents(String(f.get("price"))) }, { onConflict: "company_id,product,unit" });
    done(error, "Price saved.");
    e.currentTarget.reset();
  }
  async function removeMaterial(id: string) {
    const { error } = await supabase!.from("material_prices").delete().eq("id", id);
    done(error, "Price removed.");
  }

  // ── company ──
  async function saveCompany(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const target = String(f.get("target") || "").trim();
    const { error } = await supabase!
      .from("companies")
      .update({
        fuel_price_per_l: Number(f.get("fuel")) || null,
        overtime_after_hours: Number(f.get("ot")) || 44,
        overtime_multiplier: Number(f.get("otx")) || 1.5,
        monthly_revenue_target_cents: target ? toCents(target) : null,
        season_start_month: Number(f.get("s1")) || 4,
        season_end_month: Number(f.get("s2")) || 11,
      })
      .eq("id", companyId);
    done(error, "Saved.");
  }

  return (
    <div className="stack">
      {msg && <p className={msg.ok ? "ok" : "error"} role="status">{msg.text}</p>}

      <h2 className="section-head">Variable costs <span className="muted">grow with every job</span></h2>
      <section className="card stack">
        <h2>People and what they cost per hour</h2>
        <p className="muted">Include what you pay on top of wages (payroll taxes, WSIB, benefits). Only you see these numbers.</p>
        <div className="table-wrap">
          <table className="fin">
            <thead><tr><th>Name</th><th>Crew</th><th className="n">Cost per hour ($)</th><th /></tr></thead>
            <tbody>
              {members.filter((m) => m.active).map((m) => (
                <tr key={m.id}>
                  <td><b>{m.full_name}</b></td>
                  <td>{crewName(m.crew_id)}</td>
                  <td className="n">
                    <input className="num" inputMode="decimal" defaultValue={dollars(rates[m.id])} aria-label={`Cost per hour for ${m.full_name}`} onBlur={(e) => e.target.value !== dollars(rates[m.id]) && void saveRate(m.id, e.target.value)} />
                  </td>
                  <td />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <form className="row" onSubmit={addMember}>
          <input name="name" placeholder="Name" required aria-label="Name" />
          <select name="crew" aria-label="Crew" defaultValue="">
            <option value="">No crew</option>
            {crews.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <input name="rate" className="num" inputMode="decimal" placeholder="$/h" aria-label="Cost per hour" />
          <button className="small">Add person</button>
        </form>
      </section>

      <section className="card stack">
        <h2>Material prices</h2>
        <p className="muted">Matched by product name to what crews record when they apply it.</p>
        <ul className="rows">
          {materials.map((m) => (
            <li key={m.id} className="team-row">
              <span><b>{m.product}</b> <span className="muted">· ${dollars(m.cost_per_unit_cents)} per {m.unit}</span></span>
              <button className="small danger" onClick={() => void removeMaterial(m.id)}>Remove</button>
            </li>
          ))}
        </ul>
        <form className="row" onSubmit={addMaterial}>
          <input name="product" placeholder="Product, e.g. Fall fertilizer 24-0-12" required aria-label="Product" />
          <input name="price" className="num" inputMode="decimal" placeholder="$" required aria-label="Price per unit" />
          <select name="unit" aria-label="Unit" defaultValue="kg">
            {["kg", "g", "L", "mL", "lb", "oz", "gal"].map((u) => <option key={u}>{u}</option>)}
          </select>
          <button className="small">Save price</button>
        </form>
      </section>

      <FuelSource companyId={companyId} onChange={reload} />
      <Equipment companyId={companyId} />

      <h2 className="section-head">Fixed costs <span className="muted">paid every month, busy or not</span></h2>
      <FixedCosts companyId={companyId} />

      {company && (
        <section className="card" key={tick}>
          <h2>Fuel, overtime, target and season</h2>
          <form className="inline-form" onSubmit={saveCompany}>
            <label>Fuel price you pay ($ per litre; replaced by automatic prices when they're on)<input name="fuel" inputMode="decimal" defaultValue={company.fuel_price_per_l ?? ""} /></label>
            <label>Overtime after (hours per week)<input name="ot" inputMode="decimal" defaultValue={company.overtime_after_hours} /></label>
            <label>Overtime pay (× regular)<input name="otx" inputMode="decimal" defaultValue={company.overtime_multiplier} /></label>
            <label>Monthly revenue target ($, optional)<input name="target" inputMode="decimal" defaultValue={dollars(company.monthly_revenue_target_cents)} /></label>
            <label>Season starts in
              <select name="s1" defaultValue={company.season_start_month}>{MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}</select>
            </label>
            <label>Season ends after
              <select name="s2" defaultValue={company.season_end_month}>{MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}</select>
            </label>
            <button className="small primary">Save</button>
          </form>
        </section>
      )}
    </div>
  );
}
