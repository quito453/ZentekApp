// Technician app. Kept as simple as possible: crews work outdoors on a tablet in the truck.
// 1. Sign in once (Forgot password sends a request to the office).
// 2. Location must be on: it records drive time, kilometres and time at each stop by itself.
// 3. Start my day: the odometer (and, in Everything mode, the truck checklist).
// 4. Today's stops: arrival and departure are recorded from GPS; big buttons are there as a backup.
// 5. End my day: the odometer again, then clock out.
// Every change is saved on the tablet first and sent through the outbox, so it works with no signal.
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { Session } from "@supabase/supabase-js";
import { GeofenceDetector, kmBetween, loginEmail, t, type Fix, type Lang } from "@zentek/shared";
import { supabase } from "./supabase";
import { loadJson, saveJson } from "./localStore";
import { outbox, type ClockIn, type ClockOut, type GpsBatch, type GpsPoint, type OdometerRead, type VisitUpdate } from "./sync";
import { askForLocation, locationState, openLocationSettings, watch, type LocState } from "./location";

type Mode = "finance" | "full";
type Me = { company_id: string; crew_id: string; crew_name: string; full_name: string; mode: Mode; truck_id: string | null; truck_name: string | null };
type Shift = { id: string; day: string; clockInAt: string; odoStart: number | null; ended?: boolean };
type Visit = {
  id: string; status: string; route_order: number | null; arrived_at: string | null; departed_at: string | null; arrival_source: string | null;
  properties: { address: string; lat: number | null; lng: number | null } | null;
};

const ME_KEY = "zentek.me.v1";
const SHIFT_KEY = "zentek.shift.v1";
const CHECK_KEY = "zentek.checklist.v1";
const TODAY_KEY = "zentek.today.v1";
const LANG_KEY = "zentek.lang.v1";
const SENT_KEY = "zentek.gpssent.v1";
const CHECKLIST = ["p_oil", "p_blades", "p_line", "p_fuel", "p_bags", "p_ppe", "p_aid", "p_trailer", "p_tablet"] as const;
const LOGIN_DOMAIN = (import.meta.env.VITE_LOGIN_EMAIL_DOMAIN as string | undefined) ?? "";

const today = () => new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD on the tablet's clock

export function App() {
  const [lang, setLangState] = useState<Lang>(() => loadJson<Lang>(LANG_KEY, "es"));
  const setLang = (l: Lang) => (setLangState(l), saveJson(LANG_KEY, l));
  const [session, setSession] = useState<Session | null | undefined>(undefined);

  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);

  if (!supabase || !LOGIN_DOMAIN)
    return <main className="shell"><p className="card">Setup needed: copy apps/crew/.env.example to .env.local and fill it in.</p></main>;

  return (
    <div className="shell">
      <div className="langbar">
        <div className="seg" role="group" aria-label="Language">
          {(["en", "es"] as const).map((l) => (
            <button key={l} aria-pressed={lang === l} onClick={() => setLang(l)}>
              {l.toUpperCase()}
            </button>
          ))}
        </div>
      </div>
      {session === undefined ? <p className="muted center">{t(lang, "loading")}</p> : session ? <SignedIn lang={lang} /> : <SignIn lang={lang} />}
    </div>
  );
}

// ───────────────────────────── 1. Sign in ─────────────────────────────
function SignIn({ lang }: { lang: Lang }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [forgot, setForgot] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!navigator.onLine) return setError(t(lang, "needSignalLogin"));
    setBusy(true);
    setError("");
    const { error } = await supabase!.auth.signInWithPassword({ email: loginEmail(username, LOGIN_DOMAIN), password });
    setBusy(false);
    if (error) setError(t(lang, "badLogin"));
  }

  if (forgot) return <ForgotPassword lang={lang} initial={username} onBack={() => setForgot(false)} />;

  return (
    <main className="login">
      <h1>{t(lang, "techTitle")}</h1>
      <div className="logo" aria-hidden="true"><span>Cutting</span><span>Cost</span></div>
      <form className="stack" onSubmit={submit}>
        <label htmlFor="user">{t(lang, "username")}</label>
        <input id="user" autoCapitalize="none" autoCorrect="off" autoComplete="username" spellCheck={false} required value={username} onChange={(e) => setUsername(e.target.value)} />
        <label htmlFor="pass">{t(lang, "password")}</label>
        <input id="pass" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        {error && <p className="error" role="alert">{error}</p>}
        <button className="primary big" type="submit" disabled={busy}>
          {t(lang, "signIn")}
        </button>
      </form>
      <button className="link center" onClick={() => setForgot(true)}>
        {t(lang, "forgotPw")}
      </button>
    </main>
  );
}

function ForgotPassword({ lang, initial, onBack }: { lang: Lang; initial: string; onBack: () => void }) {
  const [username, setUsername] = useState(initial);
  const [state, setState] = useState<"idle" | "sent" | "offline">("idle");

  async function send(e: FormEvent) {
    e.preventDefault();
    if (!navigator.onLine) return setState("offline");
    const { error } = await supabase!.rpc("request_password_reset", { p_username: username });
    // The server answers the same whether or not the username exists.
    setState(error ? "offline" : "sent");
  }

  return (
    <main className="login">
      <h1>{t(lang, "forgotPw")}</h1>
      {state === "sent" ? (
        <p className="ok" role="status">{t(lang, "forgotSent")}</p>
      ) : (
        <form className="stack" onSubmit={send}>
          <p>{t(lang, "forgotP")}</p>
          <label htmlFor="fuser">{t(lang, "username")}</label>
          <input id="fuser" autoCapitalize="none" autoCorrect="off" spellCheck={false} required value={username} onChange={(e) => setUsername(e.target.value)} />
          {state === "offline" && <p className="error" role="alert">{t(lang, "forgotNoSignal")}</p>}
          <button className="primary big" type="submit">{t(lang, "forgotSend")}</button>
        </form>
      )}
      <button className="link center" onClick={onBack}>{t(lang, "back")}</button>
    </main>
  );
}

// ───────────────────────────── 2. Location, then start the day ─────────────────────────────
function SignedIn({ lang }: { lang: Lang }) {
  const [me, setMe] = useState<Me | null>(() => loadJson<Me | null>(ME_KEY, null));
  const [notTech, setNotTech] = useState(false);
  const [loc, setLoc] = useState<LocState | null>(null);
  const [shift, setShiftState] = useState<Shift | null>(() => {
    const s = loadJson<Shift | null>(SHIFT_KEY, null);
    return s && s.day === today() ? s : null;
  });
  const setShift = (s: Shift) => (setShiftState(s), saveJson(SHIFT_KEY, s));

  useEffect(() => {
    void locationState().then(setLoc);
    (async () => {
      const { data: user } = await supabase!.auth.getUser();
      if (!user.user) return;
      const m = await supabase!.from("memberships").select("company_id, role, crew_id, crews(name)").eq("user_id", user.user.id).maybeSingle<{ company_id: string; role: string; crew_id: string | null; crews: { name: string } | null }>();
      if (m.error || !m.data) return; // no signal: keep the saved copy
      if (m.data.role !== "crew" || !m.data.crew_id) return setNotTech(true);
      const [p, co, tr] = await Promise.all([
        supabase!.from("profiles").select("full_name").eq("user_id", user.user.id).maybeSingle<{ full_name: string }>(),
        supabase!.from("companies").select("mode").eq("id", m.data.company_id).maybeSingle<{ mode: Mode }>(),
        supabase!.from("trucks").select("id, name").eq("crew_id", m.data.crew_id).order("name").limit(1).maybeSingle<{ id: string; name: string }>(),
      ]);
      const next: Me = {
        company_id: m.data.company_id, crew_id: m.data.crew_id, crew_name: m.data.crews?.name ?? "", full_name: p.data?.full_name ?? "",
        mode: co.data?.mode ?? "finance", truck_id: tr.data?.id ?? null, truck_name: tr.data?.name ?? null,
      };
      setMe(next);
      saveJson(ME_KEY, next);
    })();
  }, []);

  async function signOut() {
    await supabase!.auth.signOut({ scope: "local" });
    for (const k of [ME_KEY, SHIFT_KEY, CHECK_KEY, TODAY_KEY, SENT_KEY]) localStorage.removeItem(k);
  }

  if (notTech)
    return (
      <main className="card stack">
        <p>{t(lang, "notTechLogin")}</p>
        <button className="link" onClick={signOut}>{t(lang, "signOut")}</button>
      </main>
    );
  if (!me || loc === null) return <p className="muted center">{t(lang, "loading")}</p>;
  if (loc !== "granted") return <LocationGate lang={lang} state={loc} onState={setLoc} onSignOut={signOut} />;
  if (shift?.ended)
    return (
      <main className="stack center-screen">
        <h1>{t(lang, "slDayDone")}</h1>
        <button className="link center" onClick={signOut}>{t(lang, "signOut")}</button>
      </main>
    );
  if (!shift) return <StartDay lang={lang} me={me} onStart={setShift} onSignOut={signOut} />;
  return <Route lang={lang} me={me} shift={shift} onEnd={setShift} onLocationOff={() => setLoc("denied")} />;
}

/** No way past this screen without location: it's how the day gets recorded. */
function LocationGate({ lang, state, onState, onSignOut }: { lang: Lang; state: LocState; onState: (s: LocState) => void; onSignOut: () => void }) {
  const [busy, setBusy] = useState(false);
  async function ask() {
    setBusy(true);
    onState(await askForLocation());
    setBusy(false);
  }
  return (
    <main className="stack">
      <section className="card stack loc-gate">
        <div className="loc-icon" aria-hidden="true">⌖</div>
        {state === "denied" ? (
          <>
            <h1>{t(lang, "lcDeniedT")}</h1>
            <p>{t(lang, "lcDeniedP")}</p>
            <p className="strong">{t(lang, "lcSteps")}</p>
            <button className="primary big" disabled={busy} onClick={() => void openLocationSettings().then((ok) => { if (!ok) void ask(); })}>{t(lang, "lcOpenSettings")}</button>
            <button className="big secondary" disabled={busy} onClick={() => void ask()}>{t(lang, "lcRetry")}</button>
          </>
        ) : state === "unsupported" ? (
          <>
            <h1>{t(lang, "lcDeniedT")}</h1>
            <p>{t(lang, "lcNoGps")}</p>
          </>
        ) : (
          <>
            <h1>{t(lang, "lcT")}</h1>
            <p>{t(lang, "lcP")}</p>
            <p className="muted">{t(lang, "lcWhileNote")}</p>
            <button className="primary big" disabled={busy} onClick={() => void ask()}>{t(lang, "lcBtn")}</button>
          </>
        )}
      </section>
      <button className="link center" onClick={onSignOut}>{t(lang, "signOut")}</button>
    </main>
  );
}

function OdometerInput({ lang, me, value, onChange, min }: { lang: Lang; me: Me; value: string; onChange: (v: string) => void; min?: number | null }) {
  const n = Number(value);
  const low = min !== null && min !== undefined && value !== "" && n < min;
  return (
    <label className="stack odo">
      <span className="strong">{t(lang, "slOdo", { t: me.truck_name ?? t(lang, "slOdoTruck") })}</span>
      <input inputMode="numeric" pattern="[0-9]*" value={value} onChange={(e) => onChange(e.target.value.replace(/\D/g, "").slice(0, 7))} placeholder="000000" aria-describedby="odo-help" />
      <span id="odo-help" className={low ? "error" : "muted"}>{low ? t(lang, "slOdoLow", { k: min!.toLocaleString() }) : t(lang, "slOdoP")}</span>
    </label>
  );
}

function StartDay({ lang, me, onStart, onSignOut }: { lang: Lang; me: Me; onStart: (s: Shift) => void; onSignOut: () => void }) {
  const [checks, setChecks] = useState<Record<string, boolean>>(() => loadJson(CHECK_KEY, {}));
  const [odo, setOdo] = useState("");
  const full = me.mode === "full";
  const done = CHECKLIST.filter((k) => checks[k]).length;
  const needOdo = !!me.truck_id;
  const ready = (!full || done === CHECKLIST.length) && (!needOdo || odo.length > 0);

  function toggle(k: string) {
    const next = { ...checks, [k]: !checks[k] };
    setChecks(next);
    saveJson(CHECK_KEY, next);
  }

  async function start() {
    const now = new Date().toISOString();
    const shift: Shift = { id: crypto.randomUUID(), day: today(), clockInAt: now, odoStart: odo ? Number(odo) : null };
    onStart(shift); // 1. on the tablet
    saveJson(SENT_KEY, 0);
    // 2. queued for the office
    await outbox.enqueue<ClockIn>("shift.clock_in", { id: shift.id, company_id: me.company_id, crew_id: me.crew_id, clock_in_at: now, checklist: full ? checks : {} });
    if (me.truck_id && odo) {
      await outbox.enqueue<OdometerRead>("odometer.read", { id: crypto.randomUUID(), company_id: me.company_id, truck_id: me.truck_id, crew_id: me.crew_id, reading_km: Number(odo), read_at: now });
    }
    void outbox.flush();
  }

  return (
    <main className="stack">
      <header>
        <h1>{t(lang, "gmName", { n: me.full_name.split(" ")[0] || me.crew_name })}</h1>
        <p className="muted">{me.crew_name}</p>
      </header>
      {needOdo && (
        <section className="card">
          <OdometerInput lang={lang} me={me} value={odo} onChange={setOdo} />
        </section>
      )}
      {full && (
        <section className="card stack">
          <h2>{t(lang, "preT")}</h2>
          <p className="muted">{t(lang, "preP")}</p>
          <div className="checks">
            {CHECKLIST.map((k) => (
              <button key={k} className="check" aria-pressed={!!checks[k]} onClick={() => toggle(k)}>
                <span className="box" aria-hidden="true">{checks[k] ? "✓" : ""}</span>
                {t(lang, k)}
              </button>
            ))}
          </div>
          <p className="center strong">{t(lang, "preCount", { d: done, n: CHECKLIST.length })}</p>
        </section>
      )}
      <button className="primary big" disabled={!ready} onClick={() => void start()}>
        {t(lang, "slStart")}
      </button>
      {full && done < CHECKLIST.length && <p className="muted center">{t(lang, "preNeed")}</p>}
      <button className="link center" onClick={onSignOut}>{t(lang, "signOut")}</button>
    </main>
  );
}

// ───────────────────────────── 3. Today's stops ─────────────────────────────
const hhmm = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "");
const minsBetween = (a: string | null, b: string | null) => (a ? Math.max(0, Math.round(((b ? Date.parse(b) : Date.now()) - Date.parse(a)) / 60000)) : 0);

function Route({ lang, me, shift, onEnd, onLocationOff }: { lang: Lang; me: Me; shift: Shift; onEnd: (s: Shift) => void; onLocationOff: () => void }) {
  const [visits, setVisitsState] = useState<Visit[]>(() => loadJson<Visit[]>(TODAY_KEY, []));
  const visitsRef = useRef(visits);
  const setVisits = (v: Visit[]) => {
    visitsRef.current = v;
    setVisitsState(v);
    saveJson(TODAY_KEY, v);
  };
  const [online, setOnline] = useState(navigator.onLine);
  const [waiting, setWaiting] = useState(0);
  const [sent, setSent] = useState(() => loadJson<number>(SENT_KEY, 0));
  const [ending, setEnding] = useState(false);
  const [, tick] = useState(0);
  const full = me.mode === "full";

  const flush = useCallback(async () => {
    await outbox.flush();
    setWaiting(outbox.pending.length);
  }, []);

  // Today's stops from the server, keeping progress the server hasn't received yet.
  useEffect(() => {
    (async () => {
      await outbox.load();
      setWaiting(outbox.pending.length);
      const { data, error } = await supabase!
        .from("visits")
        .select("id, status, route_order, arrived_at, departed_at, arrival_source, properties(address, lat, lng)")
        .eq("crew_id", me.crew_id)
        .eq("scheduled_on", today())
        .not("status", "in", "(skipped,moved)")
        .order("route_order", { ascending: true, nullsFirst: false })
        .returns<Visit[]>();
      if (!error && data) {
        const local = new Map(visitsRef.current.map((v) => [v.id, v]));
        setVisits(data.map((v) => (outbox.pending.length && local.has(v.id) ? { ...v, ...pick(local.get(v.id)!) } : v)));
      }
      await flush();
    })();
  }, [me.crew_id, flush]);

  useEffect(() => {
    const up = () => (setOnline(true), void flush());
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    const timer = setInterval(() => (void flush(), tick((n) => n + 1)), 30_000);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
      clearInterval(timer);
    };
  }, [flush]);

  // One change to one stop: on the tablet first, then the outbox.
  const update = useCallback(
    async (id: string, local: Partial<Visit>, patch: Record<string, unknown>) => {
      setVisits(visitsRef.current.map((x) => (x.id === id ? { ...x, ...local } : x)));
      await outbox.enqueue<VisitUpdate>("visit.update", { visitId: id, patch });
      setWaiting(outbox.pending.length);
      void flush();
    },
    [flush],
  );

  const arrive = (id: string, at: string, source: "geofence" | "manual") =>
    update(id, { status: "on_site", arrived_at: at, arrival_source: source }, { status: "on_site", arrived_at: at, arrival_source: source });
  // In Finance-only mode leaving the property is the end of the job; in Everything mode the crew
  // still taps Done (with the checklist), so leaving only records the time.
  const depart = (id: string, at: string) =>
    full
      ? update(id, { departed_at: at }, { departed_at: at })
      : update(id, { status: "done", departed_at: at }, { status: "done", done_at: at, departed_at: at });

  // ── GPS: record the trail and detect arrivals and departures ──
  const detector = useRef<GeofenceDetector | null>(null);
  const buffer = useRef<GpsPoint[]>([]);
  const last = useRef<Fix | null>(null);
  const lastSend = useRef(Date.now());
  useEffect(() => {
    const stops = visits.filter((v) => v.properties?.lat != null && v.properties?.lng != null).map((v) => ({ id: v.id, lat: v.properties!.lat!, lng: v.properties!.lng! }));
    if (!detector.current) {
      detector.current = new GeofenceDetector(stops);
      for (const v of visits) {
        if (v.status === "done" || v.departed_at) detector.current.markVisited(v.id);
      }
    } else detector.current.setStops(stops);
  }, [visits]);

  useEffect(() => {
    const sendBuffer = async () => {
      lastSend.current = Date.now();
      if (!buffer.current.length) return;
      const points = buffer.current.splice(0);
      await outbox.enqueue<GpsBatch>("gps.batch", { points }, { kind: "gps" });
      const n = loadJson<number>(SENT_KEY, 0) + points.length;
      saveJson(SENT_KEY, n);
      setSent(n);
      void flush();
    };
    const stop = watch((fix) => {
      // Keep a point every 15 s or 25 m, whichever comes first: enough for km, light on data.
      const p = last.current;
      if (!p || fix.at - p.at >= 15_000 || kmBetween(p, fix) * 1000 >= 25) {
        last.current = fix;
        buffer.current.push({
          client_id: crypto.randomUUID(), company_id: me.company_id, crew_id: me.crew_id, shift_id: shift.id, recorded_at: new Date(fix.at).toISOString(),
          lat: fix.lat, lng: fix.lng, accuracy_m: fix.accuracyM ?? null, speed_mps: fix.speedMps, heading_deg: fix.headingDeg,
        });
        // Timers slow down when the app is in the background; new points arriving keep the upload going.
        if (Date.now() - lastSend.current > 30_000) void sendBuffer();
      }
      for (const e of detector.current?.feed(fix) ?? []) {
        const v = visitsRef.current.find((x) => x.id === e.stopId);
        if (!v) continue;
        const at = new Date(e.at).toISOString();
        if (e.kind === "arrived" && !v.arrived_at) void arrive(v.id, at, "geofence");
        if (e.kind === "departed" && !v.departed_at && v.status !== "done") void depart(v.id, at);
      }
    }, onLocationOff, { title: t(lang, "gpsNoticeT"), message: t(lang, "gpsNoticeP") });
    // Every 30 s, so the dispatcher's live map stays close to real time.
    const timer = setInterval(() => void sendBuffer(), 30_000);
    return () => {
      stop();
      clearInterval(timer);
      void sendBuffer();
    };
  }, [me.company_id, me.crew_id, shift.id]);

  async function endDay(odoEnd: string) {
    const now = new Date().toISOString();
    if (me.truck_id && odoEnd) {
      await outbox.enqueue<OdometerRead>("odometer.read", { id: crypto.randomUUID(), company_id: me.company_id, truck_id: me.truck_id, crew_id: me.crew_id, reading_km: Number(odoEnd), read_at: now });
    }
    await outbox.enqueue<ClockOut>("shift.clock_out", { id: shift.id, clock_out_at: now });
    onEnd({ ...shift, ended: true });
    void flush();
  }

  if (ending) return <EndDay lang={lang} me={me} shift={shift} onBack={() => setEnding(false)} onEnd={(o) => void endDay(o)} />;

  const mins = minsBetween(shift.clockInAt, null);
  const done = visits.filter((v) => v.status === "done" || (!full && v.departed_at)).length;
  const current = visits.find((v) => v.status === "on_site" && !v.departed_at);
  const next = visits.find((v) => v !== current && v.status !== "done" && !v.departed_at && v.status !== "blocked");
  return (
    <main className="stack">
      <header className="row-between">
        <div>
          <h1>{me.crew_name}</h1>
          <p className="muted">{me.full_name}</p>
        </div>
        <span className="pill ok">
          {t(lang, "onClock")} {Math.floor(mins / 60)}:{String(mins % 60).padStart(2, "0")}
        </span>
      </header>
      {!online && (
        <div className="card warn" role="status">
          <b>{t(lang, "offT")}</b> {t(lang, "offP")}
        </div>
      )}
      <p className="muted small"><span className="ok">●</span> {t(lang, "slGps", { n: sent })}{waiting > 0 ? ` · ${online ? t(lang, "netSync", { n: waiting }) : t(lang, "netOff", { n: waiting })}` : ""}</p>

      {current ? (
        <section className="card now at">
          <span className="eyebrow">{t(lang, "slAt")}</span>
          <h2>{current.properties?.address}</h2>
          <p>{t(lang, current.arrival_source === "geofence" ? "slArr" : "slArrTap", { t: hhmm(current.arrived_at) })} · {t(lang, "slOnSite", { m: minsBetween(current.arrived_at, null) })}</p>
          <button className="primary big" onClick={() => void depart(current.id, new Date().toISOString())}>
            {full ? t(lang, "slLeaveBtn") : t(lang, "finish")}
          </button>
        </section>
      ) : next ? (
        <section className="card now">
          <span className="eyebrow">{t(lang, "slDriving")}</span>
          <h2>{next.properties?.address}</h2>
          <p className="muted">{t(lang, "slLeft", { d: visits.length - done })}</p>
          <button className="primary big" onClick={() => void arrive(next.id, new Date().toISOString(), "manual")}>{t(lang, "slHereBtn")}</button>
        </section>
      ) : (
        <section className="card now">
          <h2>{t(lang, "slAllDone")}</h2>
          <p className="muted">{t(lang, "slHome")}</p>
        </section>
      )}

      <p className="headline">{t(lang, "slStops")} · {t(lang, "ofDone", { d: done, n: visits.length })}</p>
      <ul className="rows card">
        {visits.map((v, i) => {
          const finished = v.status === "done" || (!full && !!v.departed_at);
          return (
            <li key={v.id} className={finished ? "finished" : v === current ? "here" : ""}>
              <b>{i + 1}. {v.properties?.address}</b>
              <span className="muted small">
                {finished && v.arrived_at
                  ? t(lang, "slDone", { a: hhmm(v.arrived_at), l: hhmm(v.departed_at), m: minsBetween(v.arrived_at, v.departed_at) })
                  : v === current
                    ? t(lang, "slOnSite", { m: minsBetween(v.arrived_at, null) })
                    : v === next
                      ? t(lang, "slNext")
                      : ""}
              </span>
              {full && v.status === "on_site" && v.departed_at && (
                <button className="primary" style={{ padding: "0 16px" }} onClick={() => void update(v.id, { status: "done" }, { status: "done", done_at: new Date().toISOString() })}>
                  {t(lang, "finish")}
                </button>
              )}
            </li>
          );
        })}
      </ul>
      <button className="big secondary" onClick={() => setEnding(true)}>{t(lang, "slEnd")}</button>
    </main>
  );
}

/** Fields the tablet may know before the server does. */
function pick(v: Visit): Partial<Visit> {
  return { status: v.status, arrived_at: v.arrived_at, departed_at: v.departed_at, arrival_source: v.arrival_source };
}

// ───────────────────────────── 4. End the day ─────────────────────────────
function EndDay({ lang, me, shift, onBack, onEnd }: { lang: Lang; me: Me; shift: Shift; onBack: () => void; onEnd: (odo: string) => void }) {
  const [odo, setOdo] = useState("");
  const low = shift.odoStart !== null && odo !== "" && Number(odo) < shift.odoStart;
  const ok = !me.truck_id || (odo.length > 0 && !low);
  return (
    <main className="stack">
      <h1>{t(lang, "slEnd")}</h1>
      <p className="muted">{t(lang, "slEndP")}</p>
      {me.truck_id && (
        <section className="card">
          <OdometerInput lang={lang} me={me} value={odo} onChange={setOdo} min={shift.odoStart} />
        </section>
      )}
      <button className="primary big" disabled={!ok} onClick={() => onEnd(odo)}>{t(lang, "slEnd")}</button>
      <button className="link center" onClick={onBack}>{t(lang, "slBack")}</button>
    </main>
  );
}
