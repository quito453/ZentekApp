// Office app for owners and dispatchers (web, and wrapped as a desktop app in apps/desktop).
import { useEffect, useState, type FormEvent } from "react";
import type { Session } from "@supabase/supabase-js";
import type { Lang } from "@zentek/shared";
import { supabase } from "./supabase";
import { LOGIN_DOMAIN, signInEmail } from "./lib";
import { Today } from "./Today";
import { Team } from "./Team";
import { Admin } from "./Admin";
import { Finance } from "./finance/Finance";
import { Routes } from "./Routes";

type Membership = { company_id: string; role: "owner" | "dispatcher" | "crew"; companies: { name: string } | null };
type Tab = "finance" | "today" | "routes" | "team" | "admin";

export function App() {
  const [lang, setLang] = useState<Lang>("en");
  const [session, setSession] = useState<Session | null | undefined>(undefined);

  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);

  if (!supabase || !LOGIN_DOMAIN)
    return (
      <main className="shell">
        <div className="card narrow">
          <h1>Setup needed</h1>
          <p>Copy <code>apps/office/.env.example</code> to <code>.env.local</code> and fill it in.</p>
        </div>
      </main>
    );

  return (
    <div className="shell">
      <header className="top">
        <strong>Cutting Cost</strong>
        <div className="row">
          <div className="seg" role="group" aria-label="Language">
            {(["en", "es"] as const).map((l) => (
              <button key={l} aria-pressed={lang === l} onClick={() => setLang(l)}>
                {l.toUpperCase()}
              </button>
            ))}
          </div>
          {session && (
            <button className="link" onClick={() => void supabase!.auth.signOut()}>
              Sign out
            </button>
          )}
        </div>
      </header>
      {session === undefined ? <p className="muted">Loading…</p> : session ? <Office lang={lang} userId={session.user.id} /> : <SignIn />}
    </div>
  );
}

function SignIn() {
  const [user, setUser] = useState("");
  const [pw, setPw] = useState("");
  const [error, setError] = useState("");
  const [forgot, setForgot] = useState<"no" | "form" | "sent">("no");

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    const { error } = await supabase!.auth.signInWithPassword({ email: signInEmail(user), password: pw });
    if (error) setError("Wrong username or password.");
  }

  async function requestReset(e: FormEvent) {
    e.preventDefault();
    await supabase!.rpc("request_password_reset", { p_username: user.includes("@") ? "" : user });
    setForgot("sent");
  }

  if (forgot !== "no")
    return (
      <main className="card narrow stack">
        <h1>Forgot password</h1>
        {forgot === "sent" ? (
          <p className="ok">Your request was sent. A company owner will set a new password and tell you. Owners: contact your Cutting Cost administrator.</p>
        ) : (
          <form className="stack" onSubmit={requestReset}>
            <label htmlFor="fu">Username</label>
            <input id="fu" value={user} onChange={(e) => setUser(e.target.value)} autoCapitalize="none" spellCheck={false} required />
            <button className="primary">Send request</button>
          </form>
        )}
        <button className="link" onClick={() => setForgot("no")}>Back</button>
      </main>
    );

  return (
    <main className="card narrow stack">
      <h1>Sign in</h1>
      <form className="stack" onSubmit={submit}>
        <label htmlFor="u">Username or email</label>
        <input id="u" value={user} onChange={(e) => setUser(e.target.value)} autoCapitalize="none" spellCheck={false} autoComplete="username" required />
        <label htmlFor="p">Password</label>
        <input id="p" type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="current-password" required />
        {error && <p className="error" role="alert">{error}</p>}
        <button className="primary" type="submit">Sign in</button>
      </form>
      <button className="link" onClick={() => setForgot("form")}>Forgot password?</button>
    </main>
  );
}

function Office({ lang, userId }: { lang: Lang; userId: string }) {
  const [membership, setMembership] = useState<Membership | null | undefined>(undefined);
  const [isAdmin, setIsAdmin] = useState(false);
  const [tab, setTab] = useState<Tab>("today");

  useEffect(() => {
    (async () => {
      const [m, a] = await Promise.all([
        supabase!.from("memberships").select("company_id, role, companies(name)").eq("user_id", userId).limit(1).maybeSingle<Membership>(),
        supabase!.rpc("is_platform_admin"),
      ]);
      setMembership(m.data ?? null);
      setIsAdmin(a.data === true);
      if (!m.data && a.data === true) setTab("admin");
    })();
  }, [userId]);

  if (membership === undefined) return <p className="muted">Loading…</p>;
  if (membership?.role === "crew") return <main className="card"><p>This login is a technician. Use the Cutting Cost crew app.</p></main>;
  if (!membership && !isAdmin) return <main className="card"><p className="muted">This login isn't linked to a company yet.</p></main>;

  const tabs: [Tab, string][] = [
    ...(membership ? ([["today", "Today"], ["routes", "Routes"]] as [Tab, string][]) : []),
    ...(membership?.role === "owner" ? ([["finance", "Finance"]] as [Tab, string][]) : []),
    ...(membership ? ([["team", "Team"]] as [Tab, string][]) : []),
    ...(isAdmin ? ([["admin", "App owner"]] as [Tab, string][]) : []),
  ];
  return (
    <>
      <nav className="tabs" role="tablist">
        {tabs.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>
            {label}
          </button>
        ))}
      </nav>
      {tab === "finance" && membership?.role === "owner" && <Finance companyId={membership.company_id} companyName={membership.companies?.name ?? ""} />}
      {tab === "today" && membership && <Today lang={lang} companyId={membership.company_id} companyName={membership.companies?.name ?? ""} />}
      {tab === "routes" && membership && <Routes companyId={membership.company_id} />}
      {tab === "team" && membership && <Team companyId={membership.company_id} myRole={membership.role} myId={userId} />}
      {tab === "admin" && isAdmin && <Admin />}
    </>
  );
}
