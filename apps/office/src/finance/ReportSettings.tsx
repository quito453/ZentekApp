// The owner chooses when the report email arrives and who gets it, or asks for one now.
import { useEffect, useState, type FormEvent } from "react";
import { supabase } from "../supabase";

type Settings = { weekly: boolean; weekly_day: number; monthly: boolean; recipients: string[] };
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const ERR: Record<string, string> = {
  email_not_configured: "Email sending isn't set up yet on the server (RESEND_API_KEY and REPORT_FROM).",
  no_recipients: "Add at least one email address first.",
  owner_only: "Only the company owner can get financial reports.",
};

export function ReportSettings({ companyId }: { companyId: string }) {
  const [s, setS] = useState<Settings>({ weekly: false, weekly_day: 1, monthly: true, recipients: [] });
  const [emails, setEmails] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    supabase!
      .from("report_settings")
      .select("weekly, weekly_day, monthly, recipients")
      .eq("company_id", companyId)
      .maybeSingle<Settings>()
      .then(({ data }) => {
        if (data) {
          setS(data);
          setEmails(data.recipients.join(", "));
        }
      });
  }, [companyId]);

  async function save(e: FormEvent) {
    e.preventDefault();
    const recipients = emails.split(/[,\s;]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
    const bad = recipients.find((x) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x));
    if (bad) return setMsg({ ok: false, text: `"${bad}" doesn't look like an email address.` });
    const { error } = await supabase!.from("report_settings").upsert({ company_id: companyId, ...s, recipients });
    setMsg(error ? { ok: false, text: error.message } : { ok: true, text: "Saved." });
  }

  async function sendNow(kind: "week" | "month") {
    setBusy(true);
    const { data, error } = await supabase!.functions.invoke("finance-report", { body: { company_id: companyId, kind } });
    setBusy(false);
    if (error) {
      const code = (await (error as { context?: Response })?.context?.json?.().catch(() => null))?.error ?? error.message;
      return setMsg({ ok: false, text: ERR[code] ?? code });
    }
    setMsg({ ok: true, text: `Sent: ${data.subject}` });
  }

  return (
    <section className="card stack">
      <h2>Email reports</h2>
      <p className="muted">
        A short email with profit, revenue, costs, where revenue came from, crews and anything that needs a look. Weekly reports cover the last full week (Monday to Sunday); monthly reports arrive on the 1st and cover last month.
      </p>
      <form className="inline-form" onSubmit={save}>
        <label className="check-row">
          <input type="checkbox" checked={s.weekly} onChange={(e) => setS({ ...s, weekly: e.target.checked })} />
          Weekly report
        </label>
        {s.weekly && (
          <label>
            Send it on
            <select value={s.weekly_day} onChange={(e) => setS({ ...s, weekly_day: Number(e.target.value) })}>
              {DAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
            </select>
          </label>
        )}
        <label className="check-row">
          <input type="checkbox" checked={s.monthly} onChange={(e) => setS({ ...s, monthly: e.target.checked })} />
          Monthly report (on the 1st)
        </label>
        <label>
          Send to (separate several addresses with commas)
          <input value={emails} onChange={(e) => setEmails(e.target.value)} placeholder="you@yourcompany.com, accountant@firm.com" />
        </label>
        <button className="small primary">Save</button>
      </form>
      <div className="row">
        <button className="small" disabled={busy} onClick={() => void sendNow("week")}>Email me last week's report now</button>
        <button className="small" disabled={busy} onClick={() => void sendNow("month")}>Email me last month's report now</button>
      </div>
      {msg && <p className={msg.ok ? "ok" : "error"} role="status">{msg.text}</p>}
    </section>
  );
}
