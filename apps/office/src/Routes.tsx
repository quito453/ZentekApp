// Routes: set the driving order for tomorrow, or for a crew's regular weekday.
//   • Pick a crew, then drag the list, tap the stops on the map in order, or tap "Shortest order".
//   • Tap another crew's stop on the map (or use "Move to") to give it to this crew.
//   • Extras: add a property for just this day (tomorrow) or to the regular week. Skip removes it.
// Tomorrow saves into visits (crew and route_order); a regular weekday saves into route_plans.
import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { useMap } from "./maps/useMap";
import { YARD_HTML, type LL } from "./maps/MapView";
import { ROAD_FACTOR, routeCode, routeKm, shortestOrder, type LatLng } from "@zentek/shared";
import { supabase } from "./supabase";

type Crew = { id: string; name: string; color: string | null };
type Stop = {
  key: string; // visit id (tomorrow) or property id (regular)
  propertyId: string; address: string; customer: string; lat: number | null; lng: number | null; minutes: number;
  crewId: string | null; extra?: boolean;
};
type Day = "tomorrow" | number; // 0 Monday … 6 Sunday
type Prop = { id: string; address: string; lat: number | null; lng: number | null; customers: { full_name: string } | null };

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const PALETTE = ["#1f5fbf", "#c2410c", "#15803d", "#7c3aed", "#0e7490", "#b91c1c", "#a16207", "#4d7c0f"];
const KMH = 32; // average speed in town, for drive-time estimates

const tomorrow = () => {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toLocaleDateString("en-CA");
};
const hasXY = (s: Stop): s is Stop & { lat: number; lng: number } => s.lat !== null && s.lng !== null;
// Road km for a crew's day: from the yard, through the stops, back to the yard.
const kmOf = (stops: Stop[], yard: LatLng | null) => routeKm(stops.filter(hasXY), yard, !!yard) * ROAD_FACTOR;

export function Routes({ companyId }: { companyId: string }) {
  const [day, setDay] = useState<Day>("tomorrow");
  const [crews, setCrews] = useState<Crew[]>([]);
  const [crewId, setCrewId] = useState<string | null>(null);
  const [stops, setStops] = useState<Stop[]>([]);
  const [original, setOriginal] = useState<Stop[]>([]);
  const [tapMode, setTapMode] = useState<string[] | null>(null); // keys tapped so far
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [fuel, setFuel] = useState<{ price: number; l100: Record<string, number>; yard: LatLng | null }>({ price: 0, l100: {}, yard: null });

  useEffect(() => {
    (async () => {
      const [c, co, t] = await Promise.all([
        supabase!.from("crews").select("id, name, color").eq("company_id", companyId).eq("active", true).order("name"),
        supabase!.from("companies").select("fuel_price_per_l, yard_lat, yard_lng").eq("id", companyId).single<{ fuel_price_per_l: number | null; yard_lat: number | null; yard_lng: number | null }>(),
        supabase!.from("trucks").select("crew_id, l_per_100km").eq("company_id", companyId),
      ]);
      const list = (c.data as Crew[]) ?? [];
      setCrews(list);
      setCrewId((id) => id ?? list[0]?.id ?? null);
      setFuel({
        price: Number(co.data?.fuel_price_per_l ?? 0),
        yard: co.data?.yard_lat != null && co.data?.yard_lng != null ? { lat: co.data.yard_lat, lng: co.data.yard_lng } : null,
        l100: Object.fromEntries(((t.data as { crew_id: string | null; l_per_100km: number | null }[]) ?? []).filter((x) => x.crew_id).map((x) => [x.crew_id!, Number(x.l_per_100km ?? 0)])),
      });
    })();
  }, [companyId]);

  async function load() {
    setMsg(null);
    setTapMode(null);
    let list: Stop[] = [];
    if (day === "tomorrow") {
      const { data } = await supabase!
        .from("visits")
        .select("id, crew_id, route_order, est_minutes, status, property_id, properties(address, lat, lng, customers(full_name))")
        .eq("company_id", companyId)
        .eq("scheduled_on", tomorrow())
        .not("status", "in", "(done,skipped,moved)")
        .order("route_order", { nullsFirst: false });
      type V = { id: string; crew_id: string | null; est_minutes: number; property_id: string; properties: (Omit<Prop, "id">) | null };
      list = ((data as unknown as V[]) ?? []).map((v) => ({
        key: v.id, propertyId: v.property_id, address: v.properties?.address ?? "?", customer: v.properties?.customers?.full_name ?? "",
        lat: v.properties?.lat ?? null, lng: v.properties?.lng ?? null, minutes: v.est_minutes, crewId: v.crew_id,
      }));
    } else {
      const { data: plans } = await supabase!.from("route_plans").select("crew_id, property_ids").eq("company_id", companyId).eq("weekday", day);
      const ids = [...new Set(((plans as { crew_id: string; property_ids: string[] }[]) ?? []).flatMap((p) => p.property_ids))];
      const { data: props } = ids.length
        ? await supabase!.from("properties").select("id, address, lat, lng, customers(full_name)").in("id", ids)
        : { data: [] };
      const byId = new Map(((props as unknown as Prop[]) ?? []).map((p) => [p.id, p]));
      for (const p of (plans as { crew_id: string; property_ids: string[] }[]) ?? [])
        for (const id of p.property_ids) {
          const pr = byId.get(id);
          if (pr) list.push({ key: id, propertyId: id, address: pr.address, customer: pr.customers?.full_name ?? "", lat: pr.lat, lng: pr.lng, minutes: 30, crewId: p.crew_id });
        }
    }
    setStops(list);
    setOriginal(list);
  }
  useEffect(() => void load(), [companyId, day]);

  const color = (id: string | null) => {
    const i = crews.findIndex((c) => c.id === id);
    return i < 0 ? "#6b7280" : crews[i]!.color || PALETTE[i % PALETTE.length]!;
  };
  const mine = stops.filter((s) => s.crewId === crewId);
  const unassigned = stops.filter((s) => !s.crewId);
  const crew = crews.find((c) => c.id === crewId);
  const dirty = JSON.stringify(stops.map((s) => [s.key, s.crewId])) !== JSON.stringify(original.map((s) => [s.key, s.crewId])) || stops.some((s) => s.extra);

  // Replace this crew's list in place, keeping everyone else's stops where they were.
  const setMine = (next: Stop[]) => setStops([...stops.filter((s) => s.crewId !== crewId), ...next]);
  const moveTo = (key: string, to: string | null) => {
    const s = stops.find((x) => x.key === key)!;
    setStops([...stops.filter((x) => x.key !== key), { ...s, crewId: to }]);
  };
  const shortest = () => {
    const located = mine.filter(hasXY);
    setMine([...shortestOrder(located, fuel.yard), ...mine.filter((s) => !hasXY(s))]);
  };
  const before = kmOf(original.filter((s) => s.crewId === crewId), fuel.yard);
  const after = kmOf(mine, fuel.yard);
  const bestKm = useMemo(() => kmOf(shortestOrder(mine.filter(hasXY), fuel.yard), fuel.yard), [mine, fuel.yard]);
  const fuelCost = (km: number) => (km * (fuel.l100[crewId ?? ""] ?? 0)) / 100 * fuel.price;

  function onMapTap(key: string) {
    const s = stops.find((x) => x.key === key);
    if (!s) return;
    if (tapMode) {
      if (tapMode.includes(key)) return;
      const tapped = [...tapMode, key];
      setTapMode(tapped);
      const own = stops.map((x) => (x.key === key ? { ...x, crewId } : x));
      const ordered = tapped.map((k) => own.find((x) => x.key === k)!);
      const rest = own.filter((x) => x.crewId === crewId && !tapped.includes(x.key));
      setStops([...own.filter((x) => x.crewId !== crewId), ...ordered, ...rest]);
      if (!rest.length) setTapMode(null);
    } else if (s.crewId !== crewId) {
      moveTo(key, crewId);
    }
  }

  async function save() {
    setSaving(true);
    let error: { message: string } | null = null;
    if (day === "tomorrow") {
      for (const s of stops.filter((x) => x.extra)) {
        const { data: plan } = await supabase!.from("plans").select("service_id, price_cents").eq("property_id", s.propertyId).eq("active", true).limit(1).maybeSingle<{ service_id: string; price_cents: number }>();
        const svc = plan?.service_id ?? (await supabase!.from("services").select("id").eq("company_id", companyId).limit(1).single<{ id: string }>()).data?.id;
        const r = await supabase!
          .from("visits")
          .insert({ company_id: companyId, property_id: s.propertyId, service_id: svc, scheduled_on: tomorrow(), crew_id: s.crewId, price_cents: plan?.price_cents ?? 0, source: plan ? "plan" : "new_customer" })
          .select("id")
          .single<{ id: string }>();
        if (r.error) error = r.error;
        else s.key = r.data.id;
      }
      const gone = original.filter((o) => !stops.some((s) => s.key === o.key));
      for (const g of gone) error = (await supabase!.from("visits").update({ status: "skipped" }).eq("id", g.key)).error ?? error;
      for (const c of [...crews.map((x) => x.id), null]) {
        const list = stops.filter((s) => s.crewId === c);
        for (let i = 0; i < list.length; i++) {
          error = (await supabase!.from("visits").update({ crew_id: c, route_order: c ? i + 1 : null }).eq("id", list[i]!.key)).error ?? error;
        }
      }
    } else {
      for (const c of crews) {
        const ids = stops.filter((s) => s.crewId === c.id).map((s) => s.propertyId);
        error =
          (await supabase!.from("route_plans").upsert({ company_id: companyId, crew_id: c.id, weekday: day, property_ids: ids, updated_at: new Date().toISOString() }, { onConflict: "company_id,crew_id,weekday" })).error ?? error;
      }
    }
    setSaving(false);
    setMsg(error ? { ok: false, text: error.message } : { ok: true, text: day === "tomorrow" ? "Saved. Crews see the new order on their tablets." : `Saved ${WEEKDAYS[day]}'s regular routes.` });
    if (!error) void load();
  }

  return (
    <div className="stack">
      <section className="card stack">
        <div className="row-between wrap">
          <div className="seg" role="group" aria-label="Which day">
            <button aria-pressed={day === "tomorrow"} onClick={() => setDay("tomorrow")}>Tomorrow</button>
            {WEEKDAYS.slice(0, 6).map((w, i) => (
              <button key={w} aria-pressed={day === i} onClick={() => setDay(i)} title={`Regular ${w} route`}>{w.slice(0, 3)}</button>
            ))}
          </div>
          {crew && <span className="muted small-text">Route code <b>{routeCode(crew.name, day === "tomorrow" ? (new Date(tomorrow() + "T12:00").getDay() + 6) % 7 : day)}</b></span>}
        </div>
        <div className="crew-chips" role="group" aria-label="Crew">
          {crews.map((c) => (
            <button key={c.id} aria-pressed={crewId === c.id} onClick={() => { setCrewId(c.id); setTapMode(null); }} style={{ ["--cc" as string]: color(c.id) }}>
              <i aria-hidden="true" />{c.name} <small>{stops.filter((s) => s.crewId === c.id).length}</small>
            </button>
          ))}
        </div>
      </section>

      <div className="routes-grid">
        <RouteMap stops={stops} crewId={crewId} color={color} onTap={onMapTap} tapped={tapMode} yard={fuel.yard} />
        <section className="card stack">
          <div className="row-between wrap">
            <h2 className="crew-head">{crew?.name ?? "No crews yet"}</h2>
            <div className="row wrap">
              <button className="small" disabled={mine.filter(hasXY).length < 3} onClick={shortest}>Shortest order</button>
              <button className="small" aria-pressed={!!tapMode} disabled={!mine.length} onClick={() => setTapMode(tapMode ? null : [])}>
                {tapMode ? "Stop tapping" : "Tap stops in order"}
              </button>
            </div>
          </div>
          {tapMode && <p className="notice small-text">Tap this crew's stops on the map in the order to drive them ({tapMode.length} of {mine.length}).</p>}
          <p className="muted small-text">
            About {after.toFixed(1)} km and {Math.round((after / KMH) * 60)} min driving{fuel.price ? `, ${"$" + fuelCost(after).toFixed(2)} fuel` : ""}.
            {after < before - 0.1 && <b className="ok"> {(before - after).toFixed(1)} km shorter than before{fuel.price ? ` (saves $${(fuelCost(before) - fuelCost(after)).toFixed(2)})` : ""}.</b>}
            {after > bestKm + 0.3 && <> The shortest order would be {bestKm.toFixed(1)} km.</>}
          </p>
          <StopList stops={mine} setStops={setMine} crews={crews} crewId={crewId} moveTo={moveTo} remove={(k) => setStops(stops.filter((s) => s.key !== k))} />
          <AddStop
            companyId={companyId}
            onAdd={(p) => setStops([...stops, { key: `new-${p.id}-${Date.now()}`, propertyId: p.id, address: p.address, customer: p.customers?.full_name ?? "", lat: p.lat, lng: p.lng, minutes: 30, crewId, extra: day === "tomorrow" }])}
            exclude={new Set(stops.map((s) => s.propertyId))}
          />
          {unassigned.length > 0 && (
            <>
              <h3>Not on a crew yet ({unassigned.length})</h3>
              <ul className="rows">
                {unassigned.map((s) => (
                  <li key={s.key} className="team-row">
                    <span><b>{s.address}</b> <span className="muted small-text">{s.customer}</span></span>
                    <button className="small" disabled={!crewId} onClick={() => moveTo(s.key, crewId)}>Add to {crew?.name}</button>
                  </li>
                ))}
              </ul>
            </>
          )}
          <div className="row">
            <button className="primary" disabled={!dirty || saving} onClick={() => void save()}>{saving ? "Saving…" : "Save routes"}</button>
            <button className="small" disabled={!dirty || saving} onClick={() => { setStops(original); setTapMode(null); }}>Undo changes</button>
          </div>
          {msg && <p className={msg.ok ? "ok" : "error"} role="status">{msg.text}</p>}
        </section>
      </div>
    </div>
  );
}

function StopList({ stops, setStops, crews, crewId, moveTo, remove }: {
  stops: Stop[]; setStops: (s: Stop[]) => void; crews: Crew[]; crewId: string | null; moveTo: (key: string, to: string | null) => void; remove: (key: string) => void;
}) {
  const drag = useRef<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const move = (from: number, to: number) => {
    if (from === to || to < 0 || to >= stops.length) return;
    const next = [...stops];
    const [s] = next.splice(from, 1);
    next.splice(to, 0, s!);
    setStops(next);
  };
  if (!stops.length) return <p className="muted">No stops for this crew. Tap a stop on the map or add one below.</p>;
  return (
    <ol className="route-list">
      {stops.map((s, i) => (
        <li
          key={s.key}
          draggable
          className={over === i ? "drop" : ""}
          onDragStart={(e: DragEvent) => { drag.current = i; e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", s.key); }}
          onDragOver={(e) => { e.preventDefault(); setOver(i); }}
          onDragLeave={() => setOver(null)}
          onDrop={(e) => { e.preventDefault(); if (drag.current !== null) move(drag.current, i); drag.current = null; setOver(null); }}
          onDragEnd={() => { drag.current = null; setOver(null); }}
        >
          <span className="grip" aria-hidden="true">⋮⋮</span>
          <span className="num">{i + 1}</span>
          <span className="who">
            <b>{s.address}</b>
            <span className="muted small-text">{s.customer}{s.lat === null ? " · no map location" : ""}{s.extra ? " · extra" : ""}</span>
          </span>
          <span className="row">
            <button className="small" aria-label={`Move ${s.address} up`} disabled={i === 0} onClick={() => move(i, i - 1)}>↑</button>
            <button className="small" aria-label={`Move ${s.address} down`} disabled={i === stops.length - 1} onClick={() => move(i, i + 1)}>↓</button>
            <select aria-label={`Move ${s.address} to another crew`} value="" onChange={(e) => e.target.value && moveTo(s.key, e.target.value === "-" ? null : e.target.value)}>
              <option value="">Move to…</option>
              {crews.filter((c) => c.id !== crewId).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              <option value="-">No crew</option>
            </select>
            <button className="small danger" onClick={() => remove(s.key)}>Skip</button>
          </span>
        </li>
      ))}
    </ol>
  );
}

function AddStop({ companyId, onAdd, exclude }: { companyId: string; onAdd: (p: Prop) => void; exclude: Set<string> }) {
  const [q, setQ] = useState("");
  const [found, setFound] = useState<Prop[]>([]);
  useEffect(() => {
    if (q.trim().length < 2) return setFound([]);
    const t = setTimeout(async () => {
      const { data } = await supabase!.from("properties").select("id, address, lat, lng, customers(full_name)").eq("company_id", companyId).ilike("address", `%${q.trim()}%`).limit(8);
      setFound(((data as unknown as Prop[]) ?? []).filter((p) => !exclude.has(p.id)));
    }, 250);
    return () => clearTimeout(t);
  }, [q, companyId]);
  return (
    <div className="stack">
      <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Add a stop: type an address" aria-label="Add a stop by address" />
      {found.length > 0 && (
        <ul className="rows">
          {found.map((p) => (
            <li key={p.id} className="team-row">
              <span><b>{p.address}</b> <span className="muted small-text">{p.customers?.full_name}</span></span>
              <button className="small" onClick={() => { onAdd(p); setQ(""); }}>Add</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function RouteMap({ stops, crewId, color, onTap, tapped, yard }: { stops: Stop[]; crewId: string | null; color: (id: string | null) => string; onTap: (key: string) => void; tapped: string[] | null; yard: LatLng | null }) {
  const { el, view } = useMap();
  const fitted = useRef<string>("");

  useEffect(() => {
    if (!view) return;
    view.clear();
    const located = stops.filter(hasXY);
    if (yard) view.marker({ at: [yard.lat, yard.lng], html: YARD_HTML, title: "Yard", tooltip: "Yard: routes start and end here", z: 500 });
    // Other crews first, faded, so the selected route sits on top.
    for (const s of located.filter((x) => x.crewId !== crewId)) {
      view.marker({ at: [s.lat, s.lng], html: `<span class="dot" style="--cc:${color(s.crewId)}"></span>`, title: s.address, tooltip: `${s.address} · tap to move here`, onClick: () => onTap(s.key) });
    }
    const mine = located.filter((x) => x.crewId === crewId);
    const path = mine.map((s) => [s.lat, s.lng] as LL);
    view.line(yard ? [[yard.lat, yard.lng], ...path, [yard.lat, yard.lng]] : path, color(crewId), 4, 0.8);
    mine.forEach((s) => {
      const n = stops.filter((x) => x.crewId === crewId).indexOf(s) + 1;
      const done = tapped?.includes(s.key);
      view.marker({ at: [s.lat, s.lng], html: `<span class="pin${tapped && !done ? " wait" : ""}" style="--cc:${color(crewId)}">${tapped && !done ? "?" : n}</span>`, title: s.address, z: 100 + n, onClick: () => onTap(s.key) });
    });
    // Fit the view when the day or crew changes, not on every reorder.
    const sig = `${crewId}|${located.length}`;
    if (located.length && fitted.current !== sig) {
      fitted.current = sig;
      view.fit([...(mine.length ? mine : located).map((s) => [s.lat, s.lng] as LL), ...(yard ? [[yard.lat, yard.lng] as LL] : [])]);
    }
  }, [view, stops, crewId, tapped, yard]);

  return <div ref={el} className="route-map card" role="application" aria-label="Map of stops. Numbered pins are the selected crew's route; Y is the yard." />;
}
