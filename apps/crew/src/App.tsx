// Crew tablet app. First slice: sign in as the crew's tablet, see today's route, and move each
// job along (On my way → I'm here) with every change saved on the tablet and uploaded in order.
// The full crew flow (shift checklist, photos, Done rules, breaks) follows the demo in /demo.
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import type { Session } from "@supabase/supabase-js";
import { Outbox, t, type Lang, type OutboxItem, type SendResult } from "@zentek/shared";
import { supabase } from "./supabase";
import { loadJson, localOutboxStore, saveJson } from "./localStore";

type Visit = { id: string; status: string; route_order: number | null; properties: { address: string } | null };
type VisitUpdate = { visitId: string; patch: Record<string, unknown> };

const TODAY_KEY = "zentek.today.v1";

async function sendItem(item: OutboxItem): Promise<SendResult> {
  if (!supabase || !navigator.onLine) return "retry";
  if (item.op === "visit.update") {
    const { visitId, patch } = item.payload as VisitUpdate;
    const { error } = await supabase.from("visits").update(patch).eq("id", visitId);
    if (!error) return "ok";
    // Row-level security or the crew guard said no: retrying will not help.
    return error.code === "42501" ? "drop" : "retry";
  }
  return "drop"; // unknown operation from an older app version
}

export function App() {
  const [lang, setLang] = useState<Lang>("es");
  const [session, setSession] = useState<Session | null>(null);

  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);

  if (!supabase) return <main className="shell"><p className="card">Connect Supabase: copy apps/crew/.env.example to .env.local.</p></main>;
  return (
    <div className="shell">
      <header className="top">
        <strong>Zentek Crew</strong>
        <div className="seg" role="group" aria-label="Language">
          {(["en", "es"] as const).map((l) => (
            <button key={l} aria-pressed={lang === l} onClick={() => setLang(l)}>
              {l.toUpperCase()}
            </button>
          ))}
        </div>
      </header>
      {session ? <Route lang={lang} /> : <TabletSignIn />}
    </div>
  );
}

function TabletSignIn() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  async function submit(e: FormEvent) {
    e.preventDefault();
    const { error } = await supabase!.auth.signInWithPassword({ email, password });
    setError(error ? error.message : "");
  }
  return (
    <form className="card narrow stack" onSubmit={submit}>
      <h1>Set up this tablet</h1>
      <p className="muted">The owner gives each crew tablet its own login.</p>
      <label htmlFor="em">Tablet login</label>
      <input id="em" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
      <label htmlFor="pw">Password</label>
      <input id="pw" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
      <button className="primary" type="submit">Sign in</button>
      {error && <p className="error">{error}</p>}
    </form>
  );
}

function Route({ lang }: { lang: Lang }) {
  const [visits, setVisits] = useState<Visit[]>(() => loadJson<Visit[]>(TODAY_KEY, []));
  const [online, setOnline] = useState(navigator.onLine);
  const [waiting, setWaiting] = useState(0);
  const outbox = useMemo(() => new Outbox(localOutboxStore, sendItem), []);

  const flush = useCallback(async () => {
    await outbox.flush();
    setWaiting(outbox.pending.length);
  }, [outbox]);

  // Load the saved queue, then today's route (the saved copy is shown first if there's no signal).
  useEffect(() => {
    (async () => {
      await outbox.load();
      setWaiting(outbox.pending.length);
      const today = new Date().toISOString().slice(0, 10);
      const { data, error } = await supabase!
        .from("visits")
        .select("id, status, route_order, properties(address)")
        .eq("scheduled_on", today)
        .order("route_order", { ascending: true, nullsFirst: false })
        .returns<Visit[]>();
      if (!error && data) {
        // Keep local progress the server hasn't seen yet.
        const local = new Map(loadJson<Visit[]>(TODAY_KEY, []).map((v) => [v.id, v.status]));
        const merged = data.map((v) => (outbox.pending.length && local.has(v.id) ? { ...v, status: local.get(v.id)! } : v));
        setVisits(merged);
        saveJson(TODAY_KEY, merged);
      }
      await flush();
    })();
  }, [outbox, flush]);

  // Upload when signal returns, and try again every 30 s.
  useEffect(() => {
    const up = () => (setOnline(true), void flush());
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    const timer = setInterval(() => void flush(), 30_000);
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
    // 1. Update the screen and the tablet's copy at once (works with no signal).
    const next = visits.map((x) => (x.id === v.id ? { ...x, status: patch.status as string } : x));
    setVisits(next);
    saveJson(TODAY_KEY, next);
    // 2. Queue it for the office, then try to send.
    await outbox.enqueue<VisitUpdate>("visit.update", { visitId: v.id, patch });
    setWaiting(outbox.pending.length);
    void flush();
  }

  const done = visits.filter((v) => v.status === "done").length;
  return (
    <main className="stack">
      {!online && (
        <div className="card" role="status" style={{ background: "var(--warn-soft)" }}>
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
