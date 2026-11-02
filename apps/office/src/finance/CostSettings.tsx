// What things cost: people per hour, trucks, materials, fuel, overtime and the monthly target.
// Entered once by the owner; every job's profit is worked out from these.
import { useEffect, useState, type FormEvent } from "react";
import { supabase } from "../supabase";
import { FuelSource } from "./FuelSource";
import { FixedCosts } from "./FixedCosts";

type Crew = { id: string; name: string };
type Member = { id: string; full_name: string; crew_id: string | null; active: boolean };
type Truck = { id: string; name: string; crew_id: string | null; l_per_100km: number | null };
type TruckCost = { truck_id: string; value_cents: number; life_years: number; work_hours_per_year: number };
type Material = { id: string; product: string; unit: string; cost_per_unit_cents: number };
type Company = { fuel_price_per_l: number | null; overtime_after_hours: number; overtime_multiplier: number; monthly_revenue_target_cents: number | null };

const toCents = (v: string) => Math.round(parseFloat(v.replace(/[$,\s]/g, "")) * 100);
const dollars = (c: number | null | undefined) => (c === null || c === undefined ? "" : (c / 100).toFixed(2));

export function CostSettings({ companyId }: { companyId: string }) {
  const [crews, setCrews] = useState<Crew[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [rates, setRates] = useState<Record<string, number>>({});
  const [trucks, setTrucks] = useState<Truck[]>([]);
  const [truckCosts, setTruckCosts] = useState<Record<string, TruckCost>>({});
  const [materials, setMaterials] = useState<Material[]>([]);
  const [company, setCompany] = useState<Company | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [tick, setTick] = useState(0);
  const reload = () => setTick((n) => n + 1);

  useEffect(() => {
    (async () => {
      const [c, m, r, t, tc, mp, co] = await Promise.all([
        supabase!.from("crews").select("id, name").eq("company_id", companyId).order("name"),
        supabase!.from("crew_members").select("id, full_name, crew_id, active").eq("company_id", companyId).order("full_name"),
        supabase!.from("labour_rates").select("crew_member_id, hourly_cost_cents").eq("company_id", companyId),
        supabase!.from("trucks").select("id, name, crew_id, l_per_100km").eq("company_id", companyId).order("name"),
        supabase!.from("truck_costs").select("truck_id, value_cents, life_years, work_hours_per_year").eq("company_id", companyId),
        supabase!.from("material_prices").select("id, product, unit, cost_per_unit_cents").eq("company_id", companyId).order("product"),
        supabase!.from("companies").select("fuel_price_per_l, overtime_after_hours, overtime_multiplier, monthly_revenue_target_cents").eq("id", companyId).single(),
      ]);
      setCrews((c.data as Crew[]) ?? []);
      setMembers((m.data as Member[]) ?? []);
      setRates(Object.fromEntries(((r.data as { crew_member_id: string; hourly_cost_cents: number }[]) ?? []).map((x) => [x.crew_member_id, x.hourly_cost_cents])));
      setTrucks((t.data as Truck[]) ?? []);
      setTruckCosts(Object.fromEntries(((tc.data as TruckCost[]) ?? []).map((x) => [x.truck_id, x])));
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

  // ── trucks ──
  async function saveTruck(e: FormEvent<HTMLFormElement>, truck: Truck) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const t = await supabase!.from("trucks").update({ l_per_100km: Number(f.get("l100")) || null }).eq("id", truck.id);
    if (t.error) return done(t.error, "");
    const value = toCents(String(f.get("value") || "0"));
    const { error } = await supabase!.from("truck_costs").upsert({ truck_id: truck.id, company_id: companyId, value_cents: value, life_years: Number(f.get("years")) || 5, work_hours_per_year: Number(f.get("hours")) || 1800 });
    done(error, `${truck.name} saved.`);
  }
  async function addTruck(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const { error } = await supabase!.from("trucks").insert({ company_id: companyId, name: String(f.get("name")).trim(), crew_id: f.get("crew") || null, l_per_100km: Number(f.get("l100")) || null });
    done(error, "Truck added. Add its value below.");
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
      })
      .eq("id", companyId);
    done(error, "Saved.");
  }

  return (
    <div className="stack">
      {msg && <p className={msg.ok ? "ok" : "error"} role="status">{msg.text}</p>}

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
        <h2>Trucks</h2>
        <p className="muted">Truck wear = value ÷ years you'll use it ÷ working hours per year, charged for the hours it's out.</p>
        {trucks.map((t) => {
          const c = truckCosts[t.id];
          const perHour = c ? c.value_cents / c.life_years / c.work_hours_per_year / 100 : null;
          return (
            <form key={t.id} className="row truck-row" onSubmit={(e) => void saveTruck(e, t)}>
              <b className="truck-name">{t.name}</b>
              <span className="muted">{crewName(t.crew_id)}</span>
              <label>Value $<input name="value" className="num" inputMode="decimal" defaultValue={dollars(c?.value_cents)} /></label>
              <label>Years<input name="years" className="num" inputMode="decimal" defaultValue={c?.life_years ?? 5} /></label>
              <label>Hours/yr<input name="hours" className="num" inputMode="numeric" defaultValue={c?.work_hours_per_year ?? 1800} /></label>
              <label>L/100 km<input name="l100" className="num" inputMode="decimal" defaultValue={t.l_per_100km ?? ""} /></label>
              <button className="small">Save</button>
              {perHour !== null && <span className="muted small-text">≈ ${perHour.toFixed(2)}/h wear</span>}
            </form>
          );
        })}
        <form className="row" onSubmit={addTruck}>
          <input name="name" placeholder="Truck name" required aria-label="Truck name" />
          <select name="crew" aria-label="Crew" defaultValue="">
            <option value="">No crew</option>
            {crews.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <input name="l100" className="num" inputMode="decimal" placeholder="L/100 km" aria-label="Litres per 100 km" />
          <button className="small">Add truck</button>
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

      <FixedCosts companyId={companyId} />
      <FuelSource companyId={companyId} onChange={reload} />

      {company && (
        <section className="card" key={tick}>
          <h2>Fuel, overtime and target</h2>
          <form className="inline-form" onSubmit={saveCompany}>
            <label>Fuel price you pay ($ per litre; replaced by automatic prices when they're on)<input name="fuel" inputMode="decimal" defaultValue={company.fuel_price_per_l ?? ""} /></label>
            <label>Overtime after (hours per week)<input name="ot" inputMode="decimal" defaultValue={company.overtime_after_hours} /></label>
            <label>Overtime pay (× regular)<input name="otx" inputMode="decimal" defaultValue={company.overtime_multiplier} /></label>
            <label>Monthly revenue target ($, optional)<input name="target" inputMode="decimal" defaultValue={dollars(company.monthly_revenue_target_cents)} /></label>
            <button className="small primary">Save</button>
          </form>
        </section>
      )}
    </div>
  );
}
