// Fixed costs: what the business pays every month no matter how many jobs it does.
// Each job carries a share in proportion to what it earns (worked out in public.job_profit).
import { useEffect, useState, type FormEvent } from "react";
import { money } from "@zentek/shared";
import { supabase } from "../supabase";

type Fixed = { id: string; name: string; monthly_cents: number };
const IDEAS = ["Insurance", "Subscriptions and software", "Marketing", "Licences and permits", "Shop or yard rent", "Phones and internet", "Office pay", "Truck and equipment loans", "Accountant"];

export function FixedCosts({ companyId }: { companyId: string }) {
  const [rows, setRows] = useState<Fixed[]>([]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function load() {
    const { data } = await supabase!.from("fixed_costs").select("id, name, monthly_cents").eq("company_id", companyId).order("created_at");
    setRows((data as Fixed[]) ?? []);
  }
  useEffect(() => void load(), [companyId]);

  async function add(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const cents = Math.round(parseFloat(String(f.get("amount")).replace(/[$,\s]/g, "")) * 100);
    if (!Number.isFinite(cents) || cents < 0) return setMsg({ ok: false, text: "Enter a monthly amount like 450.00" });
    const { error } = await supabase!.from("fixed_costs").insert({ company_id: companyId, name: String(f.get("name")).trim(), monthly_cents: cents });
    setMsg(error ? { ok: false, text: error.message } : { ok: true, text: "Added." });
    if (!error) { form.reset(); void load(); }
  }
  async function remove(id: string) {
    const { error } = await supabase!.from("fixed_costs").delete().eq("id", id);
    setMsg(error ? { ok: false, text: error.message } : { ok: true, text: "Removed." });
    void load();
  }
  const total = rows.reduce((a, r) => a + r.monthly_cents, 0);

  return (
    <section className="card stack">
      <h2>Fixed costs</h2>
      <p className="muted">
        What you pay every month whether you do 10 jobs or 100. Each job carries a share in proportion to what it earns: a $2,000 job carries ten times the
        share of a $200 job.
      </p>
      <p className="muted small-text">Depreciation of trucks and mowers is added on its own from Trucks and mowers above. Don't add it here too.</p>
      <ul className="rows">
        {rows.map((r) => (
          <li key={r.id} className="team-row">
            <span><b>{r.name}</b> <span className="muted">· {money(r.monthly_cents)} a month</span></span>
            <button className="small danger" onClick={() => void remove(r.id)}>Remove</button>
          </li>
        ))}
        {rows.length > 0 && (
          <li className="team-row"><b>Total</b><b>{money(total)} a month</b></li>
        )}
      </ul>
      <form className="row" onSubmit={add}>
        <input name="name" list="fixed-ideas" placeholder="What it is, e.g. Insurance" required aria-label="What it is" />
        <datalist id="fixed-ideas">{IDEAS.map((i) => <option key={i} value={i} />)}</datalist>
        <input name="amount" className="num wide" inputMode="decimal" placeholder="$ a month" required aria-label="Amount per month" />
        <button className="small primary">Add</button>
      </form>
      {msg && <p className={msg.ok ? "ok" : "error"} role="status">{msg.text}</p>}
    </section>
  );
}
