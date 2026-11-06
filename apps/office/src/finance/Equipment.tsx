// Trucks and mowers: which crew has them, what they burn, what they're worth.
//   Variable: truck fuel (km × L/100 km), mower fuel (hours on site × share running × L/h),
//             maintenance (a set amount per km and per mower hour).
//   Fixed:    depreciation (value ÷ years ÷ 12 each month), shared across jobs like insurance.
import { useEffect, useState, type FormEvent } from "react";
import { money } from "@zentek/shared";
import { supabase } from "../supabase";

type Crew = { id: string; name: string };
type Truck = { id: string; name: string; crew_id: string | null; l_per_100km: number | null };
type TruckCost = { truck_id: string; value_cents: number; life_years: number };
type Engine = { id: string; name: string; kind: string; crew_id: string | null };
type EngineCost = { equipment_id: string; l_per_hour: number; use_share: number; value_cents: number; life_years: number };
type Rates = { maint_cents_per_km: number; maint_cents_per_mower_hour: number };

const toCents = (v: string) => Math.round(parseFloat(v.replace(/[$,\s]/g, "") || "0") * 100);
const dollars = (c: number | null | undefined) => (c === null || c === undefined ? "" : (c / 100).toFixed(2));
const KINDS: [string, string][] = [["mower", "Mower"], ["trimmer", "Trimmer"], ["blower", "Blower"], ["other", "Other engine"]];

export function Equipment({ companyId, onChange }: { companyId: string; onChange?: () => void }) {
  const [crews, setCrews] = useState<Crew[]>([]);
  const [trucks, setTrucks] = useState<Truck[]>([]);
  const [tc, setTc] = useState<Record<string, TruckCost>>({});
  const [engines, setEngines] = useState<Engine[]>([]);
  const [ec, setEc] = useState<Record<string, EngineCost>>({});
  const [rates, setRates] = useState<Rates | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    (async () => {
      const [c, t, tcs, e, ecs, co] = await Promise.all([
        supabase!.from("crews").select("id, name").eq("company_id", companyId).eq("active", true).order("name"),
        supabase!.from("trucks").select("id, name, crew_id, l_per_100km").eq("company_id", companyId).order("name"),
        supabase!.from("truck_costs").select("truck_id, value_cents, life_years").eq("company_id", companyId),
        supabase!.from("equipment").select("id, name, kind, crew_id").eq("company_id", companyId).order("name"),
        supabase!.from("equipment_costs").select("equipment_id, l_per_hour, use_share, value_cents, life_years").eq("company_id", companyId),
        supabase!.from("companies").select("maint_cents_per_km, maint_cents_per_mower_hour").eq("id", companyId).single<Rates>(),
      ]);
      setCrews((c.data as Crew[]) ?? []);
      setTrucks((t.data as Truck[]) ?? []);
      setTc(Object.fromEntries(((tcs.data as TruckCost[]) ?? []).map((x) => [x.truck_id, x])));
      setEngines((e.data as Engine[]) ?? []);
      setEc(Object.fromEntries(((ecs.data as EngineCost[]) ?? []).map((x) => [x.equipment_id, x])));
      setRates(co.data);
    })();
  }, [companyId, tick]);

  const done = (error: { message: string } | null, text: string) => {
    setMsg(error ? { ok: false, text: error.message } : { ok: true, text });
    if (!error) {
      setTick((n) => n + 1);
      onChange?.();
    }
  };

  async function saveTruck(e: FormEvent<HTMLFormElement>, t: Truck) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const a = await supabase!.from("trucks").update({ crew_id: f.get("crew") || null, l_per_100km: Number(f.get("l100")) || null }).eq("id", t.id);
    if (a.error) return done(a.error, "");
    const { error } = await supabase!
      .from("truck_costs")
      .upsert({ truck_id: t.id, company_id: companyId, value_cents: toCents(String(f.get("value"))), life_years: Number(f.get("years")) || 5 });
    done(error, `${t.name} saved.`);
  }
  async function addTruck(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const { error } = await supabase!.from("trucks").insert({ company_id: companyId, name: String(f.get("name")).trim(), crew_id: f.get("crew") || null, l_per_100km: Number(f.get("l100")) || null });
    done(error, "Truck added. Add its value so depreciation counts.");
    if (!error) form.reset();
  }
  async function saveEngine(e: FormEvent<HTMLFormElement>, m: Engine) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const a = await supabase!.from("equipment").update({ crew_id: f.get("crew") || null }).eq("id", m.id);
    if (a.error) return done(a.error, "");
    const { error } = await supabase!.from("equipment_costs").upsert({
      equipment_id: m.id,
      company_id: companyId,
      l_per_hour: Number(f.get("lph")) || 0,
      use_share: Math.min(1, Math.max(0, (Number(f.get("share")) || 0) / 100)),
      value_cents: toCents(String(f.get("value"))),
      life_years: Number(f.get("years")) || 5,
    });
    done(error, `${m.name} saved.`);
  }
  async function addEngine(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const { data, error } = await supabase!
      .from("equipment")
      .insert({ company_id: companyId, name: String(f.get("name")).trim(), kind: String(f.get("kind")), crew_id: f.get("crew") || null })
      .select("id")
      .single<{ id: string }>();
    if (!error && data && f.get("lph")) {
      await supabase!.from("equipment_costs").insert({ equipment_id: data.id, company_id: companyId, l_per_hour: Number(f.get("lph")) || 0 });
    }
    done(error, "Added. Set how much it runs and what it's worth below.");
    if (!error) form.reset();
  }
  async function saveRates(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const { error } = await supabase!
      .from("companies")
      .update({ maint_cents_per_km: toCents(String(f.get("km"))), maint_cents_per_mower_hour: toCents(String(f.get("hr"))) })
      .eq("id", companyId);
    done(error, "Maintenance rates saved.");
  }

  const crewSelect = (value: string | null, label: string) => (
    <select name="crew" defaultValue={value ?? ""} aria-label={label}>
      <option value="">Spare (no crew)</option>
      {crews.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
    </select>
  );
  const monthly = (value: number, years: number) => (value && years ? Math.round(value / years / 12) : 0);
  const totalDepr =
    trucks.reduce((a, t) => a + monthly(tc[t.id]?.value_cents ?? 0, tc[t.id]?.life_years ?? 5), 0) +
    engines.reduce((a, m) => a + monthly(ec[m.id]?.value_cents ?? 0, ec[m.id]?.life_years ?? 5), 0);

  return (
    <section className="card stack" key={tick}>
      <h2>Trucks and mowers</h2>
      <p className="muted">
        Give each crew its truck and mowers. Fuel and maintenance are counted per job; depreciation (what they lose in value) is a fixed cost of{" "}
        <b>{money(totalDepr)} a month</b>, shared across jobs like insurance.
      </p>
      {msg && <p className={msg.ok ? "ok" : "error"} role="status">{msg.text}</p>}

      <h3>Trucks</h3>
      {trucks.length === 0 && <p className="muted">No trucks yet.</p>}
      {trucks.map((t) => {
        const c = tc[t.id];
        return (
          <form key={t.id} className="row truck-row" onSubmit={(e) => void saveTruck(e, t)}>
            <b className="truck-name">{t.name}</b>
            {crewSelect(t.crew_id, `Crew for ${t.name}`)}
            <label>L/100 km<input name="l100" className="num" inputMode="decimal" defaultValue={t.l_per_100km ?? ""} /></label>
            <label>Value $<input name="value" className="num" inputMode="decimal" defaultValue={dollars(c?.value_cents)} /></label>
            <label>Years<input name="years" className="num" inputMode="decimal" defaultValue={c?.life_years ?? 5} /></label>
            <button className="small">Save</button>
            {c?.value_cents ? <span className="muted small-text">{money(monthly(c.value_cents, c.life_years))}/month</span> : null}
          </form>
        );
      })}
      <form className="row" onSubmit={addTruck}>
        <input name="name" placeholder="Truck name, e.g. Truck 12" required aria-label="Truck name" />
        {crewSelect(null, "Crew")}
        <input name="l100" className="num" inputMode="decimal" placeholder="L/100 km" aria-label="Litres per 100 km" />
        <button className="small">Add truck</button>
      </form>

      <h3>Mowers and other engines</h3>
      <p className="muted small-text">
        "Runs" is how much of the time on site the engine is on. A mower that runs 45 minutes of an hour-long stop is 75%. Fuel = hours on site × runs × litres per hour.
      </p>
      {engines.length === 0 && <p className="muted">No mowers yet.</p>}
      {engines.map((m) => {
        const c = ec[m.id];
        return (
          <form key={m.id} className="row truck-row" onSubmit={(e) => void saveEngine(e, m)}>
            <b className="truck-name">{m.name}</b>
            <span className="muted small-text">{KINDS.find(([k]) => k === m.kind)?.[1] ?? m.kind}</span>
            {crewSelect(m.crew_id, `Crew for ${m.name}`)}
            <label>L/hour<input name="lph" className="num" inputMode="decimal" defaultValue={c?.l_per_hour ?? ""} /></label>
            <label>Runs %<input name="share" className="num" inputMode="numeric" defaultValue={Math.round((c?.use_share ?? 0.6) * 100)} /></label>
            <label>Value $<input name="value" className="num" inputMode="decimal" defaultValue={dollars(c?.value_cents)} /></label>
            <label>Years<input name="years" className="num" inputMode="decimal" defaultValue={c?.life_years ?? 5} /></label>
            <button className="small">Save</button>
          </form>
        );
      })}
      <form className="row" onSubmit={addEngine}>
        <input name="name" placeholder="Name, e.g. Scag 61 in" required aria-label="Mower name" />
        <select name="kind" aria-label="Kind" defaultValue="mower">
          {KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        {crewSelect(null, "Crew")}
        <input name="lph" className="num" inputMode="decimal" placeholder="L/hour" aria-label="Litres per hour" />
        <button className="small">Add</button>
      </form>

      {rates && (
        <>
          <h3>Maintenance (wear and tear)</h3>
          <form className="row" onSubmit={saveRates}>
            <label>Truck, $ per km<input name="km" className="num" inputMode="decimal" defaultValue={dollars(rates.maint_cents_per_km)} /></label>
            <label>Mower, $ per engine hour<input name="hr" className="num" inputMode="decimal" defaultValue={dollars(rates.maint_cents_per_mower_hour)} /></label>
            <button className="small">Save</button>
          </form>
          <p className="muted small-text">Oil, tires, blades, belts and repairs, spread over use. A year of repair bills ÷ a year of km is a good start; $0.15/km and $1.50/h are common.</p>
        </>
      )}
    </section>
  );
}
