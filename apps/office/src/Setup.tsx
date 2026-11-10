// Setup: everything a new company needs before its first day, from zero.
//   1. Yard: where the trucks start and end (picked on Google Maps). Owner only.
//   2. Crews: name and colour (the colour is used on every map and list).
//   3. Crew members: who works on which crew.
//   4. Customers and jobs (their own screens), then sign-ins for the crew phones.
import { useEffect, useState, type FormEvent } from "react";
import { supabase } from "./supabase";
import { AddressInput, type PickedAddress } from "./maps/AddressInput";
import { useMap } from "./maps/useMap";
import { YARD_HTML } from "./maps/MapView";

type Co = { yard_address: string | null; yard_lat: number | null; yard_lng: number | null; country: string };
type Crew = { id: string; name: string; color: string | null; active: boolean };
type Member = { id: string; full_name: string; crew_id: string | null; phone: string | null; language: string; active: boolean };
export const CREW_COLORS = ["#1f5fbf", "#c2410c", "#15803d", "#7c3aed", "#0e7490", "#b91c1c", "#a16207", "#be185d"];

export function Setup({ companyId, isOwner, go }: { companyId: string; isOwner: boolean; go: (tab: "clients" | "jobs" | "team" | "routes") => void }) {
  const [co, setCo] = useState<Co | null>(null);
  const [crews, setCrews] = useState<Crew[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [counts, setCounts] = useState({ customers: 0, jobs: 0, logins: 0 });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [tick, setTick] = useState(0);
  const reload = () => setTick((n) => n + 1);

  useEffect(() => {
    (async () => {
      const [c, cr, m, cu, v, l] = await Promise.all([
        supabase!.from("companies").select("yard_address, yard_lat, yard_lng, country").eq("id", companyId).single<Co>(),
        supabase!.from("crews").select("id, name, color, active").eq("company_id", companyId).order("name"),
        supabase!.from("crew_members").select("id, full_name, crew_id, phone, language, active").eq("company_id", companyId).order("full_name"),
        supabase!.from("customers").select("id", { count: "exact", head: true }).eq("company_id", companyId),
        supabase!.from("visits").select("id", { count: "exact", head: true }).eq("company_id", companyId),
        supabase!.from("memberships").select("user_id", { count: "exact", head: true }).eq("company_id", companyId).eq("role", "crew"),
      ]);
      setCo(c.data);
      setCrews((cr.data as Crew[]) ?? []);
      setMembers((m.data as Member[]) ?? []);
      setCounts({ customers: cu.count ?? 0, jobs: v.count ?? 0, logins: l.count ?? 0 });
    })();
  }, [companyId, tick]);

  const done = (error: { message: string } | null, text: string) => {
    setMsg(error ? { ok: false, text: error.message } : { ok: true, text });
    if (!error) reload();
  };

  async function saveYard(a: PickedAddress) {
    const { error } = await supabase!.from("companies").update({ yard_address: a.address, yard_lat: a.lat, yard_lng: a.lng, yard_place_id: a.placeId }).eq("id", companyId);
    done(error, "Yard saved. Routes now start and end here.");
  }
  async function addCrew(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const { error } = await supabase!.from("crews").insert({ company_id: companyId, name: String(f.get("name")).trim(), color: String(f.get("color")) });
    done(error, "Crew added.");
    if (!error) form.reset();
  }
  async function updateCrew(id: string, patch: Partial<Crew>) {
    const { error } = await supabase!.from("crews").update(patch).eq("id", id);
    done(error, "Saved.");
  }
  async function addMember(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const { error } = await supabase!.from("crew_members").insert({
      company_id: companyId, full_name: String(f.get("name")).trim(), crew_id: f.get("crew") || null, phone: String(f.get("phone") || "").trim() || null, language: String(f.get("lang")),
    });
    done(error, "Added. Set their pay under Finance → Costs.");
    if (!error) form.reset();
  }
  async function updateMember(id: string, patch: Partial<Member>) {
    const { error } = await supabase!.from("crew_members").update(patch).eq("id", id);
    done(error, "Saved.");
  }

  const activeCrews = crews.filter((c) => c.active);
  const steps: [string, boolean, string, (() => void) | null][] = [
    ["Set the yard", !!co?.yard_lat, "Where trucks start and end the day", null],
    ["Add crews", activeCrews.length > 0, "Each with a name and a colour", null],
    ["Add crew members", members.some((m) => m.active), "Who works on each crew", null],
    ["Add customers", counts.customers > 0, "With their address on the map", () => go("clients")],
    ["Add jobs", counts.jobs > 0, "One-off or every week", () => go("jobs")],
    ["Plan the routes", false, "Put each crew's stops in order", () => go("routes")],
    ["Sign in the crew phones", counts.logins > 0, "Each crew gets a login for the Tech app", () => go("team")],
  ];
  const doneCount = steps.filter((s) => s[1]).length;

  return (
    <div className="stack">
      <section className="card stack">
        <div className="row-between wrap">
          <h1>Set up your company</h1>
          <span className="muted">{doneCount} of {steps.length - 1} done</span>
        </div>
        <ol className="checklist">
          {steps.map(([t, ok, sub, act]) => (
            <li key={t} className={ok ? "ok" : ""}>
              <span className="tick" aria-hidden="true">{ok ? "✓" : ""}</span>
              <span><b>{t}</b> <span className="muted small-text">{sub}</span></span>
              {act && <button className="small" onClick={act}>Open</button>}
            </li>
          ))}
        </ol>
        {msg && <p className={msg.ok ? "ok" : "error"} role="status">{msg.text}</p>}
      </section>

      <section className="card stack">
        <h2>Yard</h2>
        <p className="muted">Where the trucks start and end the day. Routes are planned from here.</p>
        {co?.yard_address && <p><b>{co.yard_address}</b>{co.yard_lat === null && <span className="warn-text"> (no map position: pick it from the list to place it on the map)</span>}</p>}
        {isOwner ? <AddressInput id="yard" onPick={(a) => void saveYard(a)} placeholder={co?.yard_address ? "Change the yard address" : "Yard address"} region={co?.country === "US" ? "us" : co?.country === "CA" ? "ca" : undefined} /> : <p className="muted small-text">Only the owner can change the yard.</p>}
        {co?.yard_lat != null && co?.yard_lng != null && <YardMap lat={co.yard_lat} lng={co.yard_lng} />}
      </section>

      <section className="card stack">
        <h2>Crews</h2>
        <p className="muted">The colour marks the crew's truck, route and stops on every map.</p>
        <ul className="rows">
          {crews.map((c, i) => (
            <li key={c.id} className="team-row crew-edit">
              <input type="color" value={c.color ?? CREW_COLORS[i % CREW_COLORS.length]} aria-label={`Colour for ${c.name}`} onChange={(e) => void updateCrew(c.id, { color: e.target.value })} />
              <input defaultValue={c.name} aria-label="Crew name" onBlur={(e) => e.target.value.trim() && e.target.value !== c.name && void updateCrew(c.id, { name: e.target.value.trim() })} />
              <span className="muted small-text">{members.filter((m) => m.crew_id === c.id && m.active).map((m) => m.full_name).join(", ") || "no one yet"}</span>
              <button className="small" onClick={() => void updateCrew(c.id, { active: !c.active })}>{c.active ? "Retire" : "Bring back"}</button>
            </li>
          ))}
        </ul>
        <form className="row" onSubmit={addCrew}>
          <input name="color" type="color" defaultValue={CREW_COLORS[crews.length % CREW_COLORS.length]} aria-label="Colour" />
          <input name="name" required placeholder="Crew name, e.g. Crew 1 · Dave" aria-label="Crew name" />
          <button className="small primary">Add crew</button>
        </form>
      </section>

      <section className="card stack">
        <h2>Crew members</h2>
        <ul className="rows">
          {members.map((m) => (
            <li key={m.id} className={`team-row ${m.active ? "" : "muted"}`}>
              <span><b>{m.full_name}</b> {m.phone && <span className="muted small-text">· {m.phone}</span>} <span className="muted small-text">· {m.language === "es" ? "Español" : "English"}</span></span>
              <span className="row">
                <select value={m.crew_id ?? ""} aria-label={`Crew for ${m.full_name}`} onChange={(e) => void updateMember(m.id, { crew_id: e.target.value || null })}>
                  <option value="">No crew</option>
                  {activeCrews.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
                <button className="small" onClick={() => void updateMember(m.id, { active: !m.active })}>{m.active ? "Left the company" : "Back"}</button>
              </span>
            </li>
          ))}
        </ul>
        <form className="row" onSubmit={addMember}>
          <input name="name" required placeholder="Full name" aria-label="Full name" />
          <select name="crew" aria-label="Crew" defaultValue={activeCrews[0]?.id ?? ""}>
            <option value="">No crew</option>
            {activeCrews.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <input name="phone" type="tel" placeholder="Phone (optional)" aria-label="Phone" />
          <select name="lang" aria-label="Language on the crew app" defaultValue="es"><option value="es">Español</option><option value="en">English</option></select>
          <button className="small primary">Add person</button>
        </form>
        <p className="muted small-text">Crew phones sign in with one login per crew. Logins are made by your Cutting Cost administrator; see Team.</p>
      </section>
    </div>
  );
}

function YardMap({ lat, lng }: { lat: number; lng: number }) {
  const { el, view } = useMap([lat, lng]);
  useEffect(() => {
    if (!view) return;
    view.clear();
    view.marker({ at: [lat, lng], html: YARD_HTML, title: "Yard" });
    view.fit([[lat, lng]], 15);
  }, [view, lat, lng]);
  return <div ref={el} className="yard-map" role="img" aria-label="Map showing the yard" />;
}
