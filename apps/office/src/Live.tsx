// Live: where every crew is right now. The map shows each truck at its last GPS point; the list says
// in plain words what each crew is doing, how far along the day is, and when they'll reach the next stop.
// Tap a crew to see its trail and stops for today.
//
// Positions come from the crew tablets (gps_points) and appear as they arrive through Supabase
// Realtime; the rest refreshes when visits, shifts or breaks change, and every minute as a safety net.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMap } from "./maps/useMap";
import { YARD_HTML, type LL } from "./maps/MapView";
import { etaMinutes, liveLabel, liveStatus, type LiveKind } from "@zentek/shared";
import { supabase } from "./supabase";
import { debounce } from "./lib";

type Row = {
  crew_id: string; crew: string; color: string | null;
  shift_id: string | null; clocked_in_at: string | null; on_break: boolean;
  lat: number | null; lng: number | null; seen_at: string | null; speed_mps: number | null; accuracy_m: number | null;
  stops_done: number; stops_total: number;
  at_visit_id: string | null; at_address: string | null; at_since: string | null;
  next_visit_id: string | null; next_address: string | null; next_lat: number | null; next_lng: number | null;
  km_today: number | string;
};
type Stop = { id: string; status: string; route_order: number | null; departed_at: string | null; properties: { address: string; lat: number | null; lng: number | null } | null };
type Pt = { lat: number; lng: number; recorded_at: string };

const PALETTE = ["#1f5fbf", "#c2410c", "#15803d", "#7c3aed", "#0e7490", "#b91c1c", "#a16207", "#4d7c0f"];
const TONE: Record<LiveKind, string> = { off: "muted", no_signal: "bad", break: "warn", at_stop: "ok", driving: "info", stopped: "warn", done: "ok" };
const today = () => new Date().toLocaleDateString("en-CA");
const ago = (iso: string | null, now: number) => {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  return s < 60 ? `${s} s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
};
const initials = (name: string) => (name.match(/\d+/)?.[0] ? `C${name.match(/\d+/)![0]}` : name.replace(/[^A-Za-z]/g, "").slice(0, 2).toUpperCase());

export function Live({ companyId }: { companyId: string }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState("");
  const [live, setLive] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [sel, setSel] = useState<string | null>(null);
  const [trail, setTrail] = useState<Pt[]>([]);
  const [stops, setStops] = useState<Stop[]>([]);
  const [yard, setYard] = useState<LL | null>(null);
  useEffect(() => {
    supabase!.from("companies").select("yard_lat, yard_lng").eq("id", companyId).single<{ yard_lat: number | null; yard_lng: number | null }>()
      .then(({ data }) => setYard(data?.yard_lat != null && data?.yard_lng != null ? [data.yard_lat, data.yard_lng] : null));
  }, [companyId]);

  const load = useCallback(async () => {
    const { data, error } = await supabase!.rpc("live_crews", { p_company: companyId });
    setError(error?.message ?? "");
    if (data) setRows(data as Row[]);
  }, [companyId]);

  const loadSelected = useCallback(async (crewId: string) => {
    const [t, v] = await Promise.all([
      supabase!.rpc("crew_trail", { p_company: companyId, p_crew: crewId, p_day: today() }),
      supabase!
        .from("visits")
        .select("id, status, route_order, departed_at, properties(address, lat, lng)")
        .eq("company_id", companyId)
        .eq("crew_id", crewId)
        .eq("scheduled_on", today())
        .not("status", "in", "(skipped,moved)")
        .order("route_order", { nullsFirst: false }),
    ]);
    setTrail((t.data as Pt[]) ?? []);
    setStops((v.data as unknown as Stop[]) ?? []);
  }, [companyId]);

  useEffect(() => {
    void load();
    const reload = debounce(() => void load(), 1500);
    const channel = supabase!
      .channel(`live-${companyId}`)
      // A new GPS point: move the truck straight away, no round trip.
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "gps_points", filter: `company_id=eq.${companyId}` }, (p) => {
        const g = p.new as { crew_id: string; lat: number; lng: number; recorded_at: string; speed_mps: number | null; accuracy_m: number | null };
        setRows((rs) => rs.map((r) => (r.crew_id === g.crew_id && (!r.seen_at || g.recorded_at > r.seen_at) ? { ...r, lat: g.lat, lng: g.lng, seen_at: g.recorded_at, speed_mps: g.speed_mps, accuracy_m: g.accuracy_m } : r)));
        setTrail((t) => (selRef.current === g.crew_id ? [...t, { lat: g.lat, lng: g.lng, recorded_at: g.recorded_at }] : t));
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "visits", filter: `company_id=eq.${companyId}` }, () => { reload(); if (selRef.current) void loadSelected(selRef.current); })
      .on("postgres_changes", { event: "*", schema: "public", table: "shifts", filter: `company_id=eq.${companyId}` }, reload)
      .on("postgres_changes", { event: "*", schema: "public", table: "shift_pauses", filter: `company_id=eq.${companyId}` }, reload)
      .subscribe((status) => setLive(status === "SUBSCRIBED"));
    const safety = setInterval(() => void load(), 60_000);
    const tick = setInterval(() => setNow(Date.now()), 10_000);
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(safety);
      clearInterval(tick);
      window.removeEventListener("focus", onFocus);
      void supabase!.removeChannel(channel);
    };
  }, [companyId, load, loadSelected]);

  const selRef = useRef<string | null>(null);
  useEffect(() => {
    selRef.current = sel;
    if (sel) void loadSelected(sel);
    else { setTrail([]); setStops([]); }
  }, [sel, loadSelected]);

  const color = (r: Row, i: number) => r.color || PALETTE[i % PALETTE.length]!;
  const crews = useMemo(
    () =>
      rows.map((r, i) => {
        const st = liveStatus({ shiftId: r.shift_id, onBreak: r.on_break, seenAt: r.seen_at, speedMps: r.speed_mps, atAddress: r.at_address, atSince: r.at_since, nextAddress: r.next_address, stopsDone: r.stops_done, stopsTotal: r.stops_total }, now);
        const eta = st.kind === "driving" || st.kind === "stopped" ? (r.lat !== null && r.next_lat !== null && r.next_lng !== null ? etaMinutes({ lat: r.lat, lng: r.lng! }, { lat: r.next_lat, lng: r.next_lng }) : null) : null;
        return { r, st, eta, color: color(r, i), label: liveLabel(st.kind, st.minutes, st.kind === "at_stop" ? r.at_address : r.next_address) };
      }),
    [rows, now],
  );
  const working = crews.filter((c) => c.st.kind !== "off");
  const quiet = crews.filter((c) => c.st.kind === "no_signal");

  return (
    <div className="stack">
      <section className="card row-between wrap">
        <div>
          <h1>Live</h1>
          <p className="muted">
            {working.length} of {crews.length} crews clocked in
            {quiet.length > 0 && <> · <b className="bad-text">{quiet.length} with no signal</b></>}
          </p>
        </div>
        <span className={`live ${live ? "on" : ""}`} title={live ? "Positions arrive as they happen" : "Reconnecting"}>{live ? "Live" : "Reconnecting…"}</span>
      </section>
      {error && <p className="error">{error}</p>}
      <div className="routes-grid">
        <LiveMap crews={crews} sel={sel} onSel={setSel} trail={trail} stops={stops} yard={yard} />
        <section className="stack">
          {crews.map((c) => {
            const pct = c.r.stops_total ? Math.round((c.r.stops_done / c.r.stops_total) * 100) : 0;
            return (
              <button key={c.r.crew_id} className={`card crewlive ${sel === c.r.crew_id ? "on" : ""}`} aria-pressed={sel === c.r.crew_id} onClick={() => setSel(sel === c.r.crew_id ? null : c.r.crew_id)} style={{ ["--cc" as string]: c.color }}>
                <span className="row-between">
                  <b className="crewname"><i aria-hidden="true" />{c.r.crew}</b>
                  <span className={`tag ${TONE[c.st.kind]}`}>{c.label}</span>
                </span>
                {c.st.kind !== "off" && (
                  <>
                    <span className="prog" role="img" aria-label={`${c.r.stops_done} of ${c.r.stops_total} stops done`}><span style={{ width: `${pct}%` }} /></span>
                    <span className="row-between small-text muted">
                      <span>{c.r.stops_done} of {c.r.stops_total} stops · {Number(c.r.km_today).toFixed(1)} km today</span>
                      <span>seen {ago(c.r.seen_at, now)}</span>
                    </span>
                    {c.r.next_address && c.st.kind !== "at_stop" && (
                      <span className="small-text">Next: <b>{c.r.next_address}</b>{c.eta !== null && <> · about {c.eta} min away</>}</span>
                    )}
                  </>
                )}
              </button>
            );
          })}
          {crews.length === 0 && <p className="muted card">No crews yet.</p>}
          <p className="muted small-text">
            Positions come from the crew tablets while they're clocked in, about every 30 seconds. "No signal" means nothing has arrived for 5 minutes: the tablet may be off, out of coverage, or have location turned off.
          </p>
        </section>
      </div>
    </div>
  );
}

type C = { r: Row; st: { kind: LiveKind }; color: string; label: string };

function LiveMap({ crews, sel, onSel, trail, stops, yard }: { crews: C[]; sel: string | null; onSel: (id: string | null) => void; trail: Pt[]; stops: Stop[]; yard: LL | null }) {
  const { el, view } = useMap();
  const fitted = useRef("");

  useEffect(() => {
    if (!view) return;
    view.clear();
    if (yard) view.marker({ at: yard, html: YARD_HTML, title: "Yard", tooltip: "Yard" });
    const selected = crews.find((c) => c.r.crew_id === sel);
    if (selected) {
      view.line(trail.map((p) => [p.lat, p.lng] as LL), selected.color, 4, 0.55);
      stops.forEach((s, i) => {
        if (s.properties?.lat == null || s.properties?.lng == null) return;
        const done = s.status === "done" || !!s.departed_at;
        const here = s.status === "on_site" && !s.departed_at;
        view.marker({ at: [s.properties.lat, s.properties.lng], html: `<span class="pin ${done ? "done" : here ? "here" : "wait"}" style="--cc:${selected.color}">${done ? "✓" : i + 1}</span>`, title: s.properties.address, z: 50 });
      });
    }
    const onMap = crews.filter((c) => c.r.lat !== null && c.r.lng !== null && c.st.kind !== "off");
    for (const c of onMap) {
      view.marker({
        at: [c.r.lat!, c.r.lng!],
        html: `<span class="truck ${c.st.kind === "no_signal" ? "faded" : ""} ${c.r.crew_id === sel ? "sel" : ""}" style="--cc:${c.color}">${initials(c.r.crew)}</span>`,
        title: `${c.r.crew}: ${c.label}`,
        tooltip: `<b>${c.r.crew}</b><br>${c.label}`,
        z: c.r.crew_id === sel ? 1000 : 200,
        onClick: () => onSel(c.r.crew_id),
      });
    }
    // Frame the trucks when the set of crews on the map changes, or the selected crew's day.
    const sig = sel ? `sel:${sel}:${stops.length}` : `all:${onMap.length}`;
    if (fitted.current !== sig) {
      const own = onMap.filter((c) => c.r.crew_id === sel).map((c) => [c.r.lat!, c.r.lng!] as LL);
      const frame: LL[] = sel ? [...stops.filter((s) => s.properties?.lat != null).map((s) => [s.properties!.lat!, s.properties!.lng!] as LL), ...own] : onMap.map((c) => [c.r.lat!, c.r.lng!] as LL);
      if (!frame.length && yard) frame.push(yard);
      if (frame.length) { fitted.current = sig; view.fit(frame); }
    }
  }, [view, crews, sel, trail, stops, yard]);

  return <div ref={el} className="route-map card" role="application" aria-label="Map of crews. Each truck is at its last known position; Y is the yard." />;
}
