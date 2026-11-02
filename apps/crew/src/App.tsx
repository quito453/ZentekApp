// Technician app.
// 1. Sign in with username and password (Forgot password sends a request to the dispatcher).
// 2. Start-of-shift checklist, then Clock in.
// 3. Today's route: On my way → I'm here. Every change is saved on the tablet first and sent
//    through the outbox, so it works with no signal.
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { Session } from "@supabase/supabase-js";
import { loginEmail, t, type Lang } from "@zentek/shared";
import { supabase } from "./supabase";
import { loadJson, saveJson } from "./localStore";
import { outbox, type ClockIn, type VisitUpdate } from "./sync";

type Me = { company_id: string; crew_id: string; crew_name: string; full_name: string };
type Shift = { id: string; day: string; clockInAt: string };
type Visit = { id: string; status: string; route_order: number | null; properties: { address: string } | null };

const ME_KEY = "zentek.me.v1";
const SHIFT_KEY = "zentek.shift.v1";
const CHECK_KEY = "zentek.checklist.v1";
const TODAY_KEY = "zentek.today.v1";
const LANG_KEY = "zentek.lang.v1";
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

// ───────────────────────────── 2. Clock in ─────────────────────────────
function SignedIn({ lang }: { lang: Lang }) {
  const [me, setMe] = useState<Me | null>(() => loadJson<Me | null>(ME_KEY, null));
  const [notTech, setNotTech] = useState(false);
  const [shift, setShift] = useState<Shift | null>(() => {
    const s = loadJson<Shift | null>(SHIFT_KEY, null);
    return s && s.day === today() ? s : null;
  });

  useEffect(() => {
    (async () => {
      const { data: user } = await supabase!.auth.getUser();
      if (!user.user) return;
      const m = await supabase!.from("memberships").select("company_id, role, crew_id, crews(name)").eq("user_id", user.user.id).maybeSingle<{ company_id: string; role: string; crew_id: string | null; crews: { name: string } | null }>();
      if (m.error || !m.data) return; // no signal: keep the saved copy
      if (m.data.role !== "crew" || !m.data.crew_id) return setNotTech(true);
      const p = await supabase!.from("profiles").select("full_name").eq("user_id", user.user.id).maybeSingle<{ full_name: string }>();
      const next: Me = { company_id: m.data.company_id, crew_id: m.data.crew_id, crew_name: m.data.crews?.name ?? "", full_name: p.data?.full_name ?? "" };
      setMe(next);
      saveJson(ME_KEY, next);
    })();
  }, []);

  async function signOut() {
    await supabase!.auth.signOut({ scope: "local" });
    for (const k of [ME_KEY, SHIFT_KEY, CHECK_KEY, TODAY_KEY]) localStorage.removeItem(k);
  }

  if (notTech)
    return (
      <main className="card stack">
        <p>{t(lang, "notTechLogin")}</p>
        <button className="link" onClick={signOut}>{t(lang, "signOut")}</button>
      </main>
    );
  if (!me) return <p className="muted center">{t(lang, "loading")}</p>;
  if (!shift) return <ClockInScreen lang={lang} me={me} onClockIn={setShift} onSignOut={signOut} />;
  return <Route lang={lang} me={me} shift={shift} />;
}

function ClockInScreen({ lang, me, onClockIn, onSignOut }: { lang: Lang; me: Me; onClockIn: (s: Shift) => void; onSignOut: () => void }) {
  const [checks, setChecks] = useState<Record<string, boolean>>(() => loadJson(CHECK_KEY, {}));
  const done = CHECKLIST.filter((k) => checks[k]).length;
  const ready = done === CHECKLIST.length;

  function toggle(k: string) {
    const next = { ...checks, [k]: !checks[k] };
    setChecks(next);
    saveJson(CHECK_KEY, next);
  }

  async function clockIn() {
    const shift: Shift = { id: crypto.randomUUID(), day: today(), clockInAt: new Date().toISOString() };
    saveJson(SHIFT_KEY, shift); // 1. on the tablet
    onClockIn(shift);
    await outbox.enqueue<ClockIn>("shift.clock_in", { id: shift.id, company_id: me.company_id, crew_id: me.crew_id, clock_in_at: shift.clockInAt, checklist: checks }); // 2. queued for the office
    void outbox.flush();
  }

  return (
    <main className="stack">
      <header>
        <h1>{t(lang, "gmName", { n: me.full_name.split(" ")[0] || me.crew_name })}</h1>
        <p className="muted">{me.crew_name}</p>
      </header>
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
      <button className="primary big" disabled={!ready} onClick={() => void clockIn()}>
        {t(lang, "clockIn")}
      </button>
      {!ready && <p className="muted center">{t(lang, "preNeed")}</p>}
      <button className="link center" onClick={onSignOut}>{t(lang, "signOut")}</button>
    </main>
  );
}

// ───────────────────────────── 3. Route ─────────────────────────────
function Route({ lang, me, shift }: { lang: Lang; me: Me; shift: Shift }) {
  const [visits, setVisits] = useState<Visit[]>(() => loadJson<Visit[]>(TODAY_KEY, []));
  const [online, setOnline] = useState(navigator.onLine);
  const [waiting, setWaiting] = useState(0);
  const [, tick] = useState(0);

  const flush = useCallback(async () => {
    await outbox.flush();
    setWaiting(outbox.pending.length);
  }, []);

  useEffect(() => {
    (async () => {
      await outbox.load();
      setWaiting(outbox.pending.length);
      const { data, error } = await supabase!
        .from("visits")
        .select("id, status, route_order, properties(address)")
        .eq("crew_id", me.crew_id)
        .eq("scheduled_on", today())
        .order("route_order", { ascending: true, nullsFirst: false })
        .returns<Visit[]>();
      if (!error && data) {
        // Keep progress made on the tablet that the server hasn't received yet.
        const local = new Map(loadJson<Visit[]>(TODAY_KEY, []).map((v) => [v.id, v.status]));
        const merged = data.map((v) => (outbox.pending.length && local.has(v.id) ? { ...v, status: local.get(v.id)! } : v));
        setVisits(merged);
        saveJson(TODAY_KEY, merged);
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

  async function advance(v: Visit) {
    const now = new Date().toISOString();
    const patch: Record<string, unknown> =
      v.status === "scheduled" ? { status: "en_route", en_route_at: now } : v.status === "en_route" ? { status: "on_site", arrived_at: now } : {};
    if (!patch.status) return;
    const next = visits.map((x) => (x.id === v.id ? { ...x, status: patch.status as string } : x));
    setVisits(next);
    saveJson(TODAY_KEY, next);
    await outbox.enqueue<VisitUpdate>("visit.update", { visitId: v.id, patch });
    setWaiting(outbox.pending.length);
    void flush();
  }

  const mins = Math.max(0, Math.round((Date.now() - Date.parse(shift.clockInAt)) / 60000));
  const done = visits.filter((v) => v.status === "done").length;
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
      {waiting > 0 && <p className="muted">{online ? t(lang, "netSync", { n: waiting }) : t(lang, "netOff", { n: waiting })}</p>}
      <p className="headline">{t(lang, "ofDone", { d: done, n: visits.length })}</p>
      <ul className="rows card">
        {visits.map((v, i) => (
          <li key={v.id}>
            <b>
              {i + 1}. {v.properties?.address}
            </b>
            <span className={`chip ${v.status}`}>{v.status.replace("_", " ")}</span>
            {(v.status === "scheduled" || v.status === "en_route") && (
              <button className="primary" style={{ padding: "0 16px" }} onClick={() => void advance(v)}>
                {v.status === "scheduled" ? t(lang, "onWay") : t(lang, "imHere")}
              </button>
            )}
          </li>
        ))}
      </ul>
    </main>
  );
}
