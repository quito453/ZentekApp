// Office app (owner and dispatcher). First slice: sign in, then today's jobs from Supabase.
// The rest of the screens follow the clickable demo in /demo.
import { useEffect, useState, type FormEvent } from "react";
import type { Session } from "@supabase/supabase-js";
import { t, type Lang } from "@zentek/shared";
import { supabase } from "./supabase";

type Membership = { company_id: string; role: "owner" | "dispatcher" | "crew"; companies: { name: string } | null };
type VisitRow = {
  id: string;
  status: string;
  route_order: number | null;
  properties: { address: string } | null;
  crews: { name: string } | null;
};

export function App() {
  const [lang, setLang] = useState<Lang>("en");
  const [session, setSession] = useState<Session | null>(null);

  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);

  if (!supabase) return <SetupNeeded />;
  return (
    <div className="shell">
      <header className="top">
        <strong>Zentek</strong>
        <div className="seg" role="group" aria-label="Language">
          {(["en", "es"] as const).map((l) => (
            <button key={l} aria-pressed={lang === l} onClick={() => setLang(l)}>
              {l.toUpperCase()}
            </button>
          ))}
        </div>
      </header>
      {session ? <Today lang={lang} /> : <SignIn />}
    </div>
  );
}

function SetupNeeded() {
  return (
    <main className="card narrow">
      <h1>Connect Supabase</h1>
      <p>
        Copy <code>apps/office/.env.example</code> to <code>.env.local</code> and fill in your project URL and anon key.
      </p>
    </main>
  );
}

function SignIn() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    const { error } = await supabase!.auth.signInWithOtp({ email, options: { shouldCreateUser: false, emailRedirectTo: window.location.origin } });
    if (error) setError(error.message);
    else setSent(true);
  }

  return (
    <main className="card narrow">
      <h1>Sign in</h1>
      {sent ? (
        <p>Check your email for a sign-in link.</p>
      ) : (
        <form onSubmit={submit} className="stack">
          <label htmlFor="email">Work email</label>
          <input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
          <button className="primary" type="submit">
            Email me a sign-in link
          </button>
          {error && <p className="error">{error}</p>}
          <p className="muted">Only people your company invited can sign in.</p>
        </form>
      )}
    </main>
  );
}

function Today({ lang }: { lang: Lang }) {
  const [membership, setMembership] = useState<Membership | null>(null);
  const [visits, setVisits] = useState<VisitRow[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    (async () => {
      const m = await supabase!.from("memberships").select("company_id, role, companies(name)").limit(1).maybeSingle<Membership>();
      if (m.error) return setError(m.error.message);
      setMembership(m.data);
      if (!m.data || m.data.role === "crew") return;
      const today = new Date().toISOString().slice(0, 10);
      const v = await supabase!
        .from("visits")
        .select("id, status, route_order, properties(address), crews(name)")
        .eq("company_id", m.data.company_id)
        .eq("scheduled_on", today)
        .order("route_order", { ascending: true, nullsFirst: false })
        .returns<VisitRow[]>();
      if (v.error) setError(v.error.message);
      else setVisits(v.data ?? []);
    })();
  }, []);

  if (error) return <main className="card"><p className="error">{error}</p></main>;
  if (!membership) return <main className="card"><p className="muted">No company is linked to this login yet. Ask the owner for an invite.</p></main>;
  if (membership.role === "crew") return <main className="card"><p>This login is a crew tablet. Use the Zentek Crew app.</p></main>;

  const done = visits.filter((v) => v.status === "done").length;
  return (
    <main className="stack">
      <section className="card">
        <h1>{membership.companies?.name}</h1>
        <p className="headline">{t(lang, "hlJobs", { d: done, n: visits.length })}</p>
      </section>
      <section className="card">
        <h2>{t(lang, "tabToday")}</h2>
        {visits.length === 0 ? (
          <p className="muted">{t(lang, "allClear")}</p>
        ) : (
          <ul className="rows">
            {visits.map((v) => (
              <li key={v.id}>
                <b>{v.properties?.address}</b>
                <span>{v.crews?.name ?? t(lang, "notAssigned")}</span>
                <span className={`chip ${v.status}`}>{v.status.replace("_", " ")}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <button className="link" onClick={() => supabase!.auth.signOut()}>
        Sign out
      </button>
    </main>
  );
}
