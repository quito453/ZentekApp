// App owner only: companies, licences and logins. The admin-users Edge Function checks that the
// caller is a platform admin before doing anything; this screen is only shown to them as well.
import { useEffect, useState, type FormEvent } from "react";
import { isValidUsername, passwordProblem } from "@zentek/shared";
import { supabase } from "./supabase";
import { errorText } from "./lib";
import { SetPassword } from "./SetPassword";

type Company = { id: string; name: string; region: string; seat_limit: number; memberships: { count: number }[] };
type Crew = { id: string; name: string };
type Person = { user_id: string; username: string; full_name: string };

async function call(body: Record<string, unknown>): Promise<{ ok: boolean; text: string; data?: Record<string, unknown> }> {
  const { data, error } = await supabase!.functions.invoke("admin-users", { body });
  if (error) {
    const code = (await (error as { context?: Response })?.context?.json?.().catch(() => null))?.error ?? error.message;
    return { ok: false, text: errorText(code) };
  }
  return { ok: true, text: "Done.", data };
}

export function Admin() {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [reload, setReload] = useState(0);

  useEffect(() => {
    supabase!
      .from("companies")
      .select("id, name, region, seat_limit, memberships(count)")
      .order("name")
      .returns<Company[]>()
      .then(({ data }) => {
        setCompanies(data ?? []);
        if (!selected && data?.[0]) setSelected(data[0].id);
      });
  }, [reload, selected]);

  const company = companies.find((c) => c.id === selected);
  return (
    <div className="stack">
      <section className="card">
        <h2>Companies and licences</h2>
        <ul className="rows">
          {companies.map((c) => (
            <li key={c.id} className="team-row">
              <button className={`linkish ${c.id === selected ? "sel" : ""}`} onClick={() => setSelected(c.id)}>
                <b>{c.name}</b> <span className="muted">· {c.region}</span>
              </button>
              <Seats company={c} onSaved={() => setReload((n) => n + 1)} />
            </li>
          ))}
        </ul>
        <NewCompany onCreated={(id) => (setSelected(id), setReload((n) => n + 1))} />
      </section>
      {company && <CompanyUsers key={company.id} company={company} onChanged={() => setReload((n) => n + 1)} />}
    </div>
  );
}

function Seats({ company, onSaved }: { company: Company; onSaved: () => void }) {
  const [value, setValue] = useState(String(company.seat_limit));
  const [msg, setMsg] = useState("");
  const used = company.memberships[0]?.count ?? 0;
  async function save(e: FormEvent) {
    e.preventDefault();
    const r = await call({ action: "set_seats", company_id: company.id, seat_limit: Number(value) });
    setMsg(r.ok ? "Saved" : r.text);
    if (r.ok) onSaved();
  }
  return (
    <form className="row" onSubmit={save}>
      <span className="muted">{used} used of</span>
      <input className="num" type="number" min={used} value={value} onChange={(e) => setValue(e.target.value)} aria-label={`Licences for ${company.name}`} />
      <button className="small">Save</button>
      {msg && <small className="muted">{msg}</small>}
    </form>
  );
}

function NewCompany({ onCreated }: { onCreated: (id: string) => void }) {
  const [name, setName] = useState("");
  const [region, setRegion] = useState("ON");
  const [seats, setSeats] = useState("5");
  const [msg, setMsg] = useState("");
  async function submit(e: FormEvent) {
    e.preventDefault();
    const r = await call({ action: "create_company", name, region, seat_limit: Number(seats) });
    setMsg(r.ok ? "Company created." : r.text);
    if (r.ok) (setName(""), onCreated(String(r.data?.company_id)));
  }
  return (
    <form className="inline-form" onSubmit={submit}>
      <h3>New company</h3>
      <label>Name<input value={name} onChange={(e) => setName(e.target.value)} required /></label>
      <label>Province or state<input value={region} onChange={(e) => setRegion(e.target.value.toUpperCase())} maxLength={3} required /></label>
      <label>Licences<input type="number" min={0} value={seats} onChange={(e) => setSeats(e.target.value)} required /></label>
      <button className="small primary">Create company</button>
      {msg && <p className="muted">{msg}</p>}
    </form>
  );
}

function CompanyUsers({ company, onChanged }: { company: Company; onChanged: () => void }) {
  const [crews, setCrews] = useState<Crew[]>([]);
  const [people, setPeople] = useState<(Person & { role: string })[]>([]);
  const [tick, setTick] = useState(0);
  const [form, setForm] = useState({ role: "crew", full_name: "", username: "", password: "", crew_id: "", email: "", newCrew: "" });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    (async () => {
      const [c, m, p] = await Promise.all([
        supabase!.from("crews").select("id, name").eq("company_id", company.id).order("name").returns<Crew[]>(),
        supabase!.from("memberships").select("user_id, role").eq("company_id", company.id).returns<{ user_id: string; role: string }[]>(),
        supabase!.from("profiles").select("user_id, username, full_name").eq("company_id", company.id).returns<Person[]>(),
      ]);
      setCrews(c.data ?? []);
      const byId = new Map((p.data ?? []).map((x) => [x.user_id, x]));
      setPeople((m.data ?? []).map((x) => ({ role: x.role, user_id: x.user_id, username: byId.get(x.user_id)?.username ?? "", full_name: byId.get(x.user_id)?.full_name ?? "" })));
    })();
  }, [company.id, tick]);

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  async function addCrew() {
    if (!form.newCrew.trim()) return;
    const { data, error } = await supabase!.from("crews").insert({ company_id: company.id, name: form.newCrew.trim() }).select("id").single<{ id: string }>();
    if (error) return setMsg({ ok: false, text: error.message });
    setForm({ ...form, crew_id: data.id, newCrew: "" });
    setTick((n) => n + 1);
  }

  async function create(e: FormEvent) {
    e.preventDefault();
    if (!isValidUsername(form.username)) return setMsg({ ok: false, text: errorText("bad_username") });
    const problem = passwordProblem(form.password);
    if (problem) return setMsg({ ok: false, text: errorText(`password_${problem}`) });
    const r = await call({ action: "create_user", company_id: company.id, ...form, crew_id: form.role === "crew" ? form.crew_id : undefined, email: form.role === "crew" ? undefined : form.email || undefined });
    setMsg({ ok: r.ok, text: r.ok ? `Login created for ${form.full_name}. Username: ${form.username.trim().toLowerCase()}` : r.text });
    if (r.ok) {
      setForm({ ...form, full_name: "", username: "", password: "", email: "" });
      setTick((n) => n + 1);
      onChanged();
    }
  }

  async function deactivate(p: Person) {
    const r = await call({ action: "deactivate_user", user_id: p.user_id });
    setMsg({ ok: r.ok, text: r.ok ? `${p.full_name} can no longer sign in. Their licence is free.` : r.text });
    setTick((n) => n + 1);
    onChanged();
  }

  return (
    <section className="card stack">
      <h2>{company.name}: logins</h2>
      <ul className="rows">
        {people.map((p) => (
          <li key={p.user_id} className="team-row">
            <div>
              <b>{p.full_name}</b>
              <div className="muted">
                {p.role === "crew" ? "Technician" : p.role} · <code>{p.username}</code>
              </div>
            </div>
            <div className="row">
              <SetPassword userId={p.user_id} name={p.full_name} />
              <button className="small danger" onClick={() => void deactivate(p)}>
                Remove login
              </button>
            </div>
          </li>
        ))}
      </ul>
      <form className="inline-form" onSubmit={create}>
        <h3>New login</h3>
        <label>
          Role
          <select value={form.role} onChange={set("role")}>
            <option value="crew">Technician</option>
            <option value="dispatcher">Dispatcher</option>
            <option value="owner">Owner</option>
          </select>
        </label>
        <label>Full name<input value={form.full_name} onChange={set("full_name")} required /></label>
        <label>Username<input value={form.username} onChange={set("username")} autoCapitalize="none" spellCheck={false} required /></label>
        <label>Temporary password<input value={form.password} onChange={set("password")} required /></label>
        {form.role === "crew" ? (
          <>
            <label>
              Crew
              <select value={form.crew_id} onChange={set("crew_id")} required>
                <option value="">Choose…</option>
                {crews.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </label>
            <div className="row">
              <input placeholder="New crew name" value={form.newCrew} onChange={set("newCrew")} aria-label="New crew name" />
              <button className="small" type="button" onClick={() => void addCrew()}>Add crew</button>
            </div>
          </>
        ) : (
          <label>Email (optional; they can sign in with it instead of the username)<input type="email" value={form.email} onChange={set("email")} /></label>
        )}
        <button className="small primary">Create login</button>
        {msg && <p className={msg.ok ? "ok" : "error"} role="status">{msg.text}</p>}
      </form>
    </section>
  );
}
