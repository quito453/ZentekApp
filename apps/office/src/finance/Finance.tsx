// Finance (owners only): how the business is doing today, this week or this month.
// The database works out every number (public.finance_summary, public.job_profit); this screen
// lays them out so the owner can read the answer in seconds.
import { useEffect, useState } from "react";
import { change, costs, money, pct, periodContaining, periodLabel, shiftPeriod, toCsv, type FinanceSummary, type Period, type PeriodKind } from "@zentek/shared";
import { supabase } from "../supabase";
import { download } from "./download";
import { Payroll } from "./Payroll";
import { CostSettings } from "./CostSettings";
import { ReportSettings } from "./ReportSettings";

type Job = {
  visit_id: string; day: string; address: string; customer: string; crew: string | null; source: string;
  revenue_cents: number; labour_cents: number; fuel_cents: number; materials_cents: number; truck_cents: number;
  profit_cents: number; minutes: number; complaint: boolean;
};
type View = "overview" | "payroll" | "costs" | "email";

const today = () => new Date().toLocaleDateString("en-CA");
const SOURCE: Record<string, string> = { plan: "Regular", new_customer: "New customer", lead_won: "Lead won", crew_recommended: "Crew recommended", redo: "Redo", rescheduled: "Rescheduled" };

export function Finance({ companyId, companyName }: { companyId: string; companyName: string }) {
  const [view, setView] = useState<View>("overview");
  return (
    <div className="stack">
      <nav className="subtabs" aria-label="Finance">
        {(
          [
            ["overview", "Overview"],
            ["payroll", "Payroll"],
            ["costs", "Costs and rates"],
            ["email", "Email reports"],
          ] as [View, string][]
        ).map(([k, label]) => (
          <button key={k} aria-pressed={view === k} onClick={() => setView(k)}>
            {label}
          </button>
        ))}
      </nav>
      {view === "overview" && <Overview companyId={companyId} companyName={companyName} />}
      {view === "payroll" && <Payroll companyId={companyId} />}
      {view === "costs" && <CostSettings companyId={companyId} />}
      {view === "email" && <ReportSettings companyId={companyId} />}
    </div>
  );
}

function Overview({ companyId, companyName }: { companyId: string; companyName: string }) {
  const [period, setPeriod] = useState<Period>(() => periodContaining("week", today()));
  const [now, setNow] = useState<FinanceSummary | null>(null);
  const [prev, setPrev] = useState<FinanceSummary | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    (async () => {
      const before = shiftPeriod(period, -1);
      const [a, b, j] = await Promise.all([
        supabase!.rpc("finance_summary", { p_company: companyId, p_from: period.from, p_to: period.to }),
        supabase!.rpc("finance_summary", { p_company: companyId, p_from: before.from, p_to: before.to }),
        supabase!.rpc("job_profit", { p_company: companyId, p_from: period.from, p_to: period.to }),
      ]);
      if (!live) return;
      if (a.error) return setError(a.error.message);
      setError("");
      setNow(a.data as FinanceSummary);
      setPrev((b.data as FinanceSummary) ?? null);
      setJobs(((j.data as Job[]) ?? []).sort((x, y) => x.profit_cents - y.profit_cents));
    })();
    return () => {
      live = false;
    };
  }, [companyId, period]);

  const setKind = (k: PeriodKind) => setPeriod(periodContaining(k, today()));
  const isCurrent = period.to >= today();

  function exportJobs() {
    download(
      `${companyName} jobs ${period.from} to ${period.to}.csv`,
      toCsv(
        ["Date", "Address", "Customer", "Crew", "Type", "Revenue", "Labour", "Fuel", "Materials", "Truck wear", "Profit", "Minutes on site", "Complaint"],
        jobs.map((j) => [j.day, j.address, j.customer, j.crew, SOURCE[j.source] ?? j.source, j.revenue_cents / 100, j.labour_cents / 100, j.fuel_cents / 100, j.materials_cents / 100, j.truck_cents / 100, j.profit_cents / 100, j.minutes, j.complaint ? "yes" : ""]),
      ),
    );
  }

  return (
    <div className="stack">
      <div className="row-between wrap">
        <div className="seg big-seg" role="group" aria-label="Period">
          {(["day", "week", "month"] as PeriodKind[]).map((k) => (
            <button key={k} aria-pressed={period.kind === k} onClick={() => setKind(k)}>
              {k === "day" ? "Day" : k === "week" ? "Week" : "Month"}
            </button>
          ))}
        </div>
        <div className="row">
          <button className="small" aria-label="Previous period" onClick={() => setPeriod(shiftPeriod(period, -1))}>
            ‹
          </button>
          <strong>{periodLabel(period)}</strong>
          <button className="small" aria-label="Next period" disabled={isCurrent} onClick={() => setPeriod(shiftPeriod(period, 1))}>
            ›
          </button>
        </div>
      </div>
      {error && <p className="error">{error}</p>}
      {now && <Report s={now} prev={prev} period={period} />}
      <section className="card">
        <div className="row-between">
          <h2>Jobs, least profitable first</h2>
          <button className="small" onClick={exportJobs} disabled={!jobs.length}>
            Download (Excel/CSV)
          </button>
        </div>
        {jobs.length === 0 ? (
          <p className="muted">No finished jobs in this period.</p>
        ) : (
          <div className="table-wrap">
            <table className="fin">
              <thead>
                <tr>
                  <th>Job</th><th>Crew</th><th className="n">Revenue</th><th className="n">Labour</th><th className="n">Fuel</th><th className="n">Materials</th><th className="n">Truck</th><th className="n">Profit</th>
                </tr>
              </thead>
              <tbody>
                {jobs.slice(0, 50).map((j) => (
                  <tr key={j.visit_id} className={j.profit_cents < 0 ? "loss" : ""}>
                    <td>
                      <b>{j.address}</b>
                      <div className="muted small-text">
                        {j.day} · {SOURCE[j.source] ?? j.source}
                        {j.complaint && <span className="tag bad">Complaint</span>}
                      </div>
                    </td>
                    <td>{j.crew ?? "–"}</td>
                    <td className="n">{money(j.revenue_cents)}</td>
                    <td className="n">{money(j.labour_cents)}</td>
                    <td className="n">{money(j.fuel_cents)}</td>
                    <td className="n">{money(j.materials_cents)}</td>
                    <td className="n">{money(j.truck_cents)}</td>
                    <td className="n strong">{money(j.profit_cents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {jobs.length > 50 && <p className="muted">Showing the 50 least profitable of {jobs.length}. Download for all.</p>}
          </div>
        )}
      </section>
    </div>
  );
}

function Delta({ now, before, invert }: { now: number; before?: number; invert?: boolean }) {
  const c = before === undefined ? null : change(now, before);
  if (!c) return <span className="muted small-text">no earlier data</span>;
  const up = !c.startsWith("-");
  return <span className={`delta ${up !== !!invert ? "good" : "bad"}`}>{up ? "▲" : "▼"} {c.replace("-", "")} vs previous</span>;
}

function Report({ s, prev, period }: { s: FinanceSummary; prev: FinanceSummary | null; period: Period }) {
  const totalCost = costs(s);
  const margin = pct(s.profit_cents, s.revenue_cents);
  const complaintRate = pct(s.complaint_jobs, s.jobs);
  const costParts = [
    { key: "Labour", v: s.labour_cents },
    { key: "Fuel", v: s.fuel_cents },
    { key: "Materials", v: s.materials_cents },
    { key: "Truck wear", v: s.truck_cents },
  ];
  const mixParts = [
    { key: "Regular customers", v: s.mix.regular_cents },
    { key: "New customers", v: s.mix.new_customer_cents },
    { key: "Extra work from crew leads", v: s.mix.upsell_cents },
    { key: "Redo and rescheduled", v: s.mix.other_cents },
  ];
  const watch: { text: string; level: "bad" | "warn" }[] = [];
  if (s.losing_jobs) watch.push({ text: `${s.losing_jobs} job${s.losing_jobs === 1 ? "" : "s"} lost money. They're at the top of the jobs list below.`, level: "bad" });
  if (complaintRate >= 5) watch.push({ text: `Complaints on ${complaintRate}% of jobs (${s.complaint_jobs}).`, level: complaintRate >= 10 ? "bad" : "warn" });
  if (s.leads.open) watch.push({ text: `${s.leads.open} lead${s.leads.open === 1 ? "" : "s"} from crews still open. Quote them before they go cold.`, level: "warn" });
  if (s.jobs && !s.labour_cents) watch.push({ text: "No pay rates set, so labour shows as $0. Add them under Costs and rates.", level: "warn" });

  return (
    <>
      <section className="hero card">
        <div>
          <p className="eyebrow">Profit</p>
          <p className="hero-num">{money(s.profit_cents, { whole: true })}</p>
          <Delta now={s.profit_cents} before={prev?.profit_cents} />
        </div>
        <dl className="hero-side">
          <div><dt>Revenue</dt><dd>{money(s.revenue_cents, { whole: true })}</dd><Delta now={s.revenue_cents} before={prev?.revenue_cents} /></div>
          <div><dt>Costs</dt><dd>{money(totalCost, { whole: true })}</dd><Delta now={totalCost} before={prev ? costs(prev) : undefined} invert /></div>
          <div><dt>Margin</dt><dd>{margin}%</dd></div>
          <div><dt>Jobs done</dt><dd>{s.jobs}</dd></div>
        </dl>
        {period.kind === "month" && s.monthly_target_cents ? (
          <div className="target">
            <div className="row-between">
              <span>Monthly target {money(s.monthly_target_cents, { whole: true })}</span>
              <strong>{pct(s.revenue_cents, s.monthly_target_cents)}%</strong>
            </div>
            <div className="meter" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, pct(s.revenue_cents, s.monthly_target_cents))}>
              <span style={{ width: `${Math.min(100, pct(s.revenue_cents, s.monthly_target_cents))}%` }} />
            </div>
          </div>
        ) : null}
      </section>

      {watch.length > 0 && (
        <section className="card">
          <h2>Needs a look</h2>
          <ul className="watch">
            {watch.map((w) => (
              <li key={w.text} className={w.level}>
                <span className="dot" aria-hidden="true" />
                {w.text}
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="grid2">
        <SplitBar title="Where the money went" total={totalCost} parts={costParts} emptyText="No costs recorded yet." />
        <SplitBar title="Where revenue came from" total={s.revenue_cents} parts={mixParts} emptyText="No revenue in this period." />
      </div>

      <section className="card">
        <h2>Crews</h2>
        <div className="table-wrap">
          <table className="fin">
            <thead>
              <tr>
                <th>Crew</th><th className="n">Jobs</th><th className="n">Revenue</th><th className="n">Profit</th><th className="n">Profit per hour on site</th><th className="n">Leads won / spotted</th><th className="n">Complaints</th>
              </tr>
            </thead>
            <tbody>
              {s.crews.map((c) => (
                <tr key={c.crew_id}>
                  <td><b>{c.name}</b></td>
                  <td className="n">{c.jobs}</td>
                  <td className="n">{money(c.revenue_cents, { whole: true })}</td>
                  <td className="n">{money(c.profit_cents, { whole: true })}</td>
                  <td className="n">{c.minutes ? money(Math.round((c.profit_cents / c.minutes) * 60), { whole: true }) : "–"}</td>
                  <td className="n">{c.leads_won} / {c.leads_created}</td>
                  <td className={`n ${pct(c.complaints, c.jobs) >= 10 ? "bad-text" : ""}`}>{c.jobs ? `${pct(c.complaints, c.jobs)}%` : "–"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="muted small-text">
          Leads: {s.leads.created} spotted by crews, {s.leads.won} won, {s.leads.open} still open.
        </p>
      </section>
    </>
  );
}

/** One stacked bar plus a legend that doubles as the table of values. */
function SplitBar({ title, total, parts, emptyText }: { title: string; total: number; parts: { key: string; v: number }[]; emptyText: string }) {
  const shown = parts.filter((p) => p.v > 0);
  return (
    <section className="card">
      <h2>{title}</h2>
      {total <= 0 ? (
        <p className="muted">{emptyText}</p>
      ) : (
        <>
          <div className="splitbar" role="img" aria-label={`${title}: ${shown.map((p) => `${p.key} ${money(p.v, { whole: true })}`).join(", ")}`}>
            {parts.map((p, i) =>
              p.v > 0 ? <span key={p.key} className={`seg-${i + 1}`} style={{ flexGrow: p.v }} title={`${p.key}: ${money(p.v, { whole: true })} (${pct(p.v, total)}%)`} /> : null,
            )}
          </div>
          <table className="legend-table">
            <tbody>
              {parts.map((p, i) => (
                <tr key={p.key}>
                  <td><span className={`swatch seg-${i + 1}`} aria-hidden="true" />{p.key}</td>
                  <td className="n">{money(p.v, { whole: true })}</td>
                  <td className="n muted">{pct(p.v, total)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
