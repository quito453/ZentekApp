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
  profit_cents: number; minutes: number; complaint: boolean; fixed_share_cents: number; net_cents: number;
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
      setJobs(((j.data as Job[]) ?? []).sort((x, y) => x.net_cents - y.net_cents));
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
        ["Date", "Address", "Customer", "Crew", "Type", "Revenue", "Labour", "Fuel", "Materials", "Truck wear", "Profit from the job", "Share of fixed costs", "Profit after fixed costs", "Minutes on site", "Complaint"],
        jobs.map((j) => [j.day, j.address, j.customer, j.crew, SOURCE[j.source] ?? j.source, j.revenue_cents / 100, j.labour_cents / 100, j.fuel_cents / 100, j.materials_cents / 100, j.truck_cents / 100, j.profit_cents / 100, j.fixed_share_cents / 100, j.net_cents / 100, j.minutes, j.complaint ? "yes" : ""]),
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
                  <th>Job</th><th>Crew</th><th className="n">Revenue</th><th className="n">Labour</th><th className="n">Fuel</th><th className="n">Materials</th><th className="n">Truck</th><th className="n">Job profit</th><th className="n">Fixed share</th><th className="n">After fixed</th>
                </tr>
              </thead>
              <tbody>
                {jobs.slice(0, 50).map((j) => (
                  <tr key={j.visit_id} className={j.net_cents < 0 ? "loss" : ""}>
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
                    <td className="n">{money(j.profit_cents)}</td>
                    <td className="n muted">{money(j.fixed_share_cents)}</td>
                    <td className="n strong">{money(j.net_cents)}</td>
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

const PERIOD_WORD: Record<PeriodKind, string> = { day: "Today", week: "This week", month: "This month" };

function Report({ s, prev, period }: { s: FinanceSummary; prev: FinanceSummary | null; period: Period }) {
  const totalCost = costs(s);
  const fixed = s.fixed_cents ?? 0;
  const net = s.net_profit_cents ?? s.profit_cents - fixed;
  const margin = pct(net, s.revenue_cents);
  const per100 = s.revenue_cents ? Math.round((net / s.revenue_cents) * 100) : 0;
  const isPast = period.to < new Date().toLocaleDateString("en-CA");
  const when = isPast ? `In ${periodLabel(period)}` : PERIOD_WORD[period.kind];
  const sentence = !s.revenue_cents
    ? `${when}: no finished jobs yet.`
    : net >= 0
      ? `${when} you kept ${money(per100 * 100, { whole: true })} of every $100 you charged, after paying crews, fuel, materials, truck wear${fixed ? " and your fixed costs" : ""}.`
      : `${when} you lost ${money(-per100 * 100, { whole: true })} on every $100 you charged. Costs were higher than what the jobs brought in.`;
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
  if (s.jobs && !fixed) watch.push({ text: "No fixed costs entered (insurance, rent, phones…), so profit looks higher than it is. Add them under Costs and rates.", level: "warn" });

  return (
    <>
      <p className="plain">{sentence}</p>
      <section className="hero card">
        <div>
          <p className="eyebrow">{fixed ? "Profit after fixed costs" : "Profit"}</p>
          <p className="hero-num">{money(net, { whole: true })}</p>
          <Delta now={net} before={prev ? prev.net_profit_cents ?? prev.profit_cents : undefined} />
        </div>
        <dl className="hero-side">
          <div><dt>Revenue</dt><dd>{money(s.revenue_cents, { whole: true })}</dd><Delta now={s.revenue_cents} before={prev?.revenue_cents} /></div>
          <div><dt>Job costs</dt><dd>{money(totalCost, { whole: true })}</dd><Delta now={totalCost} before={prev ? costs(prev) : undefined} invert /></div>
          <div><dt>Fixed costs</dt><dd>{money(fixed, { whole: true })}</dd></div>
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

      {s.revenue_cents > 0 && <Per100 revenue={s.revenue_cents} jobCosts={totalCost} fixed={fixed} />}

      <div className="grid2">
        <SplitBar title="Job costs: where the money went" total={totalCost} parts={costParts} emptyText="No costs recorded yet." />
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

      {s.revenue_cents > 0 && <WhatIf s={s} fixed={fixed} />}
      <Glossary fuel={s} />
    </>
  );
}

/** Every $100 charged, split into job costs, fixed costs and what's kept. */
function Per100({ revenue, jobCosts, fixed }: { revenue: number; jobCosts: number; fixed: number }) {
  const kept = revenue - jobCosts - fixed;
  const parts = [
    { key: "Job costs (crews, fuel, materials, truck wear)", v: jobCosts, cls: "seg-1" },
    { key: "Fixed costs (insurance, rent, phones…)", v: fixed, cls: "seg-4" },
    { key: kept >= 0 ? "Kept" : "Lost", v: Math.abs(kept), cls: kept >= 0 ? "seg-3" : "seg-2" },
  ];
  const d = (v: number) => `$${Math.round((v / revenue) * 100)}`;
  return (
    <section className="card">
      <h2>Every $100 you charged</h2>
      <div className="splitbar tall" role="img" aria-label={parts.map((p) => `${p.key} ${d(p.v)}`).join(", ")}>
        {parts.map((p) => (p.v > 0 ? <span key={p.key} className={p.cls} style={{ flexGrow: p.v }} /> : null))}
      </div>
      <table className="legend-table">
        <tbody>
          {parts.map((p) => (
            <tr key={p.key}><td><span className={`swatch ${p.cls}`} aria-hidden="true" />{p.key}</td><td className="n strong">{d(p.v)}</td></tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/** Move the sliders to see what profit would be if costs or prices changed. Nothing is saved. */
function WhatIf({ s, fixed }: { s: FinanceSummary; fixed: number }) {
  const [f, setF] = useState({ fuel: 0, labour: 0, fixed: 0, prices: 0 });
  const k = (n: number) => 1 + n / 100;
  const revenue = s.revenue_cents * k(f.prices);
  const net = revenue - s.labour_cents * k(f.labour) - s.fuel_cents * k(f.fuel) - s.materials_cents - s.truck_cents - fixed * k(f.fixed);
  const now = s.net_profit_cents ?? s.profit_cents - fixed;
  const sliders: [keyof typeof f, string, number, number][] = [
    ["fuel", "Fuel price", -30, 60],
    ["labour", "Crew pay", -10, 30],
    ["fixed", "Fixed costs", -30, 50],
    ["prices", "Your prices", -10, 25],
  ];
  const changed = Object.values(f).some((v) => v !== 0);
  return (
    <section className="card stack">
      <div className="row-between wrap">
        <h2>What if…</h2>
        {changed && <button className="small" onClick={() => setF({ fuel: 0, labour: 0, fixed: 0, prices: 0 })}>Reset</button>}
      </div>
      <p className="muted">Slide to see what this period would look like if costs or prices changed. Nothing is saved.</p>
      <div className="whatif">
        {sliders.map(([key, label, min, max]) => (
          <label key={key}>
            <span className="row-between"><span>{label}</span><b>{f[key] > 0 ? "+" : ""}{f[key]}%</b></span>
            <input type="range" min={min} max={max} step={5} value={f[key]} onChange={(e) => setF({ ...f, [key]: Number(e.target.value) })} />
          </label>
        ))}
      </div>
      <p className="plain small">
        {changed ? (
          <>You'd keep <b>{money(Math.round(net), { whole: true })}</b> instead of {money(now, { whole: true })} ({net >= now ? "+" : "−"}{money(Math.abs(Math.round(net - now)), { whole: true })}).</>
        ) : (
          <>Move a slider to compare with the {money(now, { whole: true })} you kept.</>
        )}
      </p>
    </section>
  );
}

function Glossary({ fuel }: { fuel: FinanceSummary }) {
  const price = fuel.fuel_price_per_l ? `$${Number(fuel.fuel_price_per_l).toFixed(3)} per litre` : "not set";
  const from = fuel.fuel_price_from === "receipts" ? "your crews' fuel receipts" : fuel.fuel_price_from === "manual" || !fuel.fuel_price_from ? "the price you typed in" : fuel.fuel_price_from;
  return (
    <details className="card glossary">
      <summary>What do these words mean?</summary>
      <dl>
        <dt>Revenue</dt><dd>Everything you charged for finished jobs.</dd>
        <dt>Job costs</dt><dd>Costs that grow with every job: crew pay (including drive time), fuel, materials and truck wear.</dd>
        <dt>Fixed costs</dt><dd>What you pay every month no matter how many jobs you do: insurance, rent, phones, software, loans. Each job carries a share in proportion to what it earns.</dd>
        <dt>Profit after fixed costs</dt><dd>What's left for you after all of the above.</dd>
        <dt>Truck wear</dt><dd>What the truck loses in value for every hour it's out: its price ÷ years you'll keep it ÷ hours it works a year.</dd>
        <dt>Fuel</dt><dd>Kilometres from GPS × the truck's litres per 100 km × the fuel price. This period used {price}, from {from}.</dd>
      </dl>
    </details>
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
