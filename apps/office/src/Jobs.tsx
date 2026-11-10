// Jobs: add work for a property on a day (or every week), give it to a crew, and see what's coming.
// Order within a crew's day is set on Routes.
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { supabase } from "./supabase";
import { CREW_COLORS } from "./Setup";

type Prop = { id: string; address: string; customers: { full_name: string } | null };
type Service = { id: string; name_en: string; default_minutes: number };
type Crew = { id: string; name: string; color: string | null };
type Job = { id: string; scheduled_on: string; status: string; price_cents: number; est_minutes: number; crew_id: string | null; route_order: number | null; properties: { address: string; customers: { full_name: string } | null } | null; services: { name_en: string } | null };

const day = (d: Date) => d.toLocaleDateString("en-CA");
const addDays = (s: string, n: number) => { const d = new Date(s + "T12:00:00"); d.setDate(d.getDate() + n); return day(d); };
const nice = (s: string) => new Date(s + "T12:00:00").toLocaleDateString("en-CA", { weekday: "long", month: "short", day: "numeric" });
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "job";

export function Jobs({ companyId }: { companyId: string }) {
  const [props, setProps] = useState<Prop[]>([]);
  const [services, setServices] = useState<Service[]>([]);
  const [crews, setCrews] = useState<Crew[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [q, setQ] = useState("");
  const [propId, setPropId] = useState("");
  const [svc, setSvc] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [tick, setTick] = useState(0);
  const today = day(new Date());

  useEffect(() => {
    (async () => {
      const [p, s, c, j] = await Promise.all([
        supabase!.from("properties").select("id, address, customers(full_name)").eq("company_id", companyId).order("address"),
        supabase!.from("services").select("id, name_en, default_minutes").eq("company_id", companyId).order("name_en"),
        supabase!.from("crews").select("id, name, color").eq("company_id", companyId).eq("active", true).order("name"),
        supabase!
          .from("visits")
          .select("id, scheduled_on, status, price_cents, est_minutes, crew_id, route_order, properties(address, customers(full_name)), services(name_en)")
          .eq("company_id", companyId)
          .gte("scheduled_on", today)
          .lte("scheduled_on", addDays(today, 13))
          .not("status", "in", "(skipped,moved)")
          .order("scheduled_on")
          .order("route_order", { nullsFirst: false }),
      ]);
      setProps((p.data as unknown as Prop[]) ?? []);
      setServices((s.data as Service[]) ?? []);
      setSvc((cur) => cur || ((s.data as Service[] | null)?.[0]?.id ?? "new"));
      setCrews((c.data as Crew[]) ?? []);
      setJobs((j.data as unknown as Job[]) ?? []);
    })();
  }, [companyId, tick, today]);

  const color = (id: string | null) => { const i = crews.findIndex((c) => c.id === id); return i < 0 ? "#8a94a0" : crews[i]!.color || CREW_COLORS[i % CREW_COLORS.length]!; };
  const matches = useMemo(() => props.filter((p) => !q || `${p.address} ${p.customers?.full_name ?? ""}`.toLowerCase().includes(q.toLowerCase())).slice(0, 8), [props, q]);
  const chosen = props.find((p) => p.id === propId);

  async function add(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!chosen) return setMsg({ ok: false, text: "Pick a property first." });
    const form = e.currentTarget;
    const f = new FormData(form);
    let serviceId = svc;
    const minutes = Math.max(5, Number(f.get("minutes")) || 30);
    if (svc === "new" || !svc) {
      const name = String(f.get("newservice") || "").trim() || "Job";
      const s = await supabase!
        .from("services")
        .upsert({ company_id: companyId, key: slug(name), name_en: name, default_minutes: minutes }, { onConflict: "company_id,key" })
        .select("id")
        .single<{ id: string }>();
      if (s.error) return setMsg({ ok: false, text: s.error.message });
      serviceId = s.data.id;
    }
    const first = String(f.get("date"));
    const weeks = Math.min(52, Math.max(1, Number(f.get("weeks")) || 1));
    const price = Math.round(parseFloat(String(f.get("price")).replace(/[$,\s]/g, "")) * 100);
    if (!Number.isFinite(price) || price < 0) return setMsg({ ok: false, text: "Enter a price like 55.00" });
    const rows = Array.from({ length: weeks }, (_, i) => ({
      company_id: companyId, property_id: chosen.id, service_id: serviceId, scheduled_on: addDays(first, i * 7),
      crew_id: f.get("crew") || null, est_minutes: minutes, price_cents: price, source: "plan",
    }));
    const { error } = await supabase!.from("visits").insert(rows);
    setMsg(error ? { ok: false, text: error.message } : { ok: true, text: weeks > 1 ? `${weeks} weekly jobs added, starting ${nice(first)}.` : `Job added for ${nice(first)}.` });
    if (!error) { setPropId(""); setQ(""); setTick((n) => n + 1); }
  }
  async function remove(id: string) {
    const { error } = await supabase!.from("visits").update({ status: "skipped" }).eq("id", id);
    setMsg(error ? { ok: false, text: error.message } : { ok: true, text: "Job cancelled." });
    if (!error) setTick((n) => n + 1);
  }
  async function moveCrew(id: string, crewId: string) {
    await supabase!.from("visits").update({ crew_id: crewId || null, route_order: null }).eq("id", id);
    setTick((n) => n + 1);
  }

  const days = [...new Set(jobs.map((j) => j.scheduled_on))];
  return (
    <div className="stack">
      <section className="card stack">
        <h1>Add a job</h1>
        {props.length === 0 ? (
          <p className="muted">Add a customer first, under Customers.</p>
        ) : (
          <form className="stack" onSubmit={add}>
            {chosen ? (
              <p className="row"><b>{chosen.address}</b> <span className="muted">{chosen.customers?.full_name}</span><button type="button" className="small" onClick={() => setPropId("")}>Change</button></p>
            ) : (
              <>
                <input type="search" placeholder="Find the property: address or customer" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find the property" />
                <ul className="rows">
                  {matches.map((p) => (
                    <li key={p.id} className="team-row"><span><b>{p.address}</b> <span className="muted small-text">{p.customers?.full_name}</span></span><button type="button" className="small" onClick={() => setPropId(p.id)}>Choose</button></li>
                  ))}
                </ul>
              </>
            )}
            <div className="inline-form">
              <label>Work
                <select value={svc} onChange={(e) => setSvc(e.target.value)}>
                  {services.map((s) => <option key={s.id} value={s.id}>{s.name_en}</option>)}
                  <option value="new">{services.length ? "Something new…" : "Name the work below"}</option>
                </select>
              </label>
              {(svc === "new" || services.length === 0 || !svc) && <label>New kind of work<input name="newservice" placeholder="e.g. Weekly mow" required={svc === "new" || services.length === 0} /></label>}
              <label>First date<input name="date" type="date" defaultValue={addDays(today, 1)} min={today} required /></label>
              <label>Repeat every week for<select name="weeks" defaultValue="1">{[1, 4, 8, 12, 16, 20, 26, 30].map((n) => <option key={n} value={n}>{n === 1 ? "Just once" : `${n} weeks`}</option>)}</select></label>
              <label>Crew<select name="crew" defaultValue={crews[0]?.id ?? ""}><option value="">Not assigned yet</option>{crews.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
              <label>Price ($)<input name="price" inputMode="decimal" required placeholder="55.00" /></label>
              <label>Minutes on site<input name="minutes" inputMode="numeric" defaultValue={services.find((s) => s.id === svc)?.default_minutes ?? 30} /></label>
            </div>
            <button className="primary" disabled={!chosen}>Add job</button>
          </form>
        )}
        {msg && <p className={msg.ok ? "ok" : "error"} role="status">{msg.text}</p>}
      </section>
      <section className="card stack">
        <h2>Next two weeks</h2>
        {days.length === 0 && <p className="muted">No jobs yet.</p>}
        {days.map((d) => (
          <div key={d}>
            <h3 className="day-head">{nice(d)} <span className="muted small-text">{jobs.filter((j) => j.scheduled_on === d).length} jobs</span></h3>
            <ul className="rows">
              {jobs.filter((j) => j.scheduled_on === d).map((j) => (
                <li key={j.id} className="team-row job-row" style={{ ["--cc" as string]: color(j.crew_id) }}>
                  <span><b>{j.properties?.address}</b> <span className="muted small-text">{j.properties?.customers?.full_name} · {j.services?.name_en} · ${(j.price_cents / 100).toFixed(2)} · {j.est_minutes} min{j.status !== "scheduled" ? ` · ${j.status.replace("_", " ")}` : ""}</span></span>
                  <span className="row">
                    <select value={j.crew_id ?? ""} aria-label="Crew" onChange={(e) => void moveCrew(j.id, e.target.value)}>
                      <option value="">Not assigned</option>
                      {crews.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                    {j.status === "scheduled" && <button className="small danger" onClick={() => void remove(j.id)}>Cancel</button>}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>
    </div>
  );
}
