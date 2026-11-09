// Finance (owners only): how the business is doing today, this week, this month or this season.
// The database works out every number (public.finance_summary, public.job_profit); this screen
// lays them out so the owner can read the answer in seconds.
import { useEffect, useState } from "react";
import { change, costs, money, pct, periodContaining, periodLabel, shiftPeriod, toCsv, DEFAULT_SEASON, type FinanceSummary, type Period, type PeriodKind, type Season } from "@zentek/shared";
import { supabase } from "../supabase";
import { download } from "./download";
import { Payroll } from "./Payroll";
import { CostSettings } from "./CostSettings";
import { ReportSettings } from "./ReportSettings";
import { Customers } from "./Customers";
import { FuelKm } from "./FuelKm";
import { Connections } from "./Connections";

type Job = {
  visit_id: string; day: string; address: string; customer: string; crew: string | null; source: string;
  revenue_cents: number; labour_cents: number; fuel_cents: number; materials_cents: number; maintenance_cents: number;
  profit_cents: number; minutes: number; complaint: boolean; fixed_share_cents: number; net_cents: number;
};
type View = "overview" | "customers" | "payroll" | "fuel" | "costs" | "connect" | "email";

const today = () => new Date().toLocaleDateString("en-CA");
const SOURCE: Record<string, string> = { plan: "Regular", new_customer: "New customer", lead_won: "Lead won", crew_recommended: "Crew recommended", redo: "Redo", rescheduled: "Rescheduled" };

// The fixed-cost slider and period are kept per browser so the owner's view sticks.
const remember = <T,>(k: string, v: T) => {
  try {
    localStorage.setItem(`cc.${k}`, JSON.stringify(v));
  } catch {
    /* private mode */
  }
};
const recall = <T,>(k: string, fallback: T): T => {
  try {
    const v = localStorage.getItem(`cc.${k}`);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
};

export function Finance({ companyId, companyName }: { companyId: string; companyName: string }) {
  const [view, setView] = useState<View>("overview");
  const [season, setSeason] = useState<Season>(DEFAULT_SEASON);
  useEffect(() => {
    supabase!
      .from("companies")
      .select("season_start_month, season_end_month")
      .eq("id", companyId)
      .single<{ season_start_month: number; season_end_month: number }>()
      .then(({ data }) => data && setSeason({ start: data.season_start_month, end: data.season_end_month }));
  }, [companyId]);
  return (
    <div className="stack">
      <nav className="subtabs" aria-label="Finance">
        {(
          [
            ["overview", "Overview"],
            ["customers", "Customers"],
            ["payroll", "Payroll"],
            ["fuel", "Fuel & km"],
            ["costs", "Costs"],
            ["connect", "Connections"],
            ["email", "Email reports"],
          ] as [View, string][]
        ).map(([k, label]) => (
          <button key={k} aria-pressed={view === k} onClick={() => setView(k)}>
            {label}
          </button>
        ))}
      </nav>
      {view === "overview" && <Overview companyId={companyId} companyName={companyName} season={season} />}
      {view === "customers" && <Customers companyId={companyId} companyName={companyName} season={season} />}
      {view === "payroll" && <Payroll companyId={companyId} />}
      {view === "fuel" && <FuelKm companyId={companyId} companyName={companyName} season={season} />}
      {view === "costs" && <CostSettings companyId={companyId} />}
      {view === "connect" && <Connections companyId={companyId} />}
      {view === "email" && <ReportSettings companyId={companyId} />}
    </div>
  );
}

/** Day / Week / Month / Season, with back and forward. Shared by the finance screens. */
export function PeriodBar({ period, setPeriod, season }: { period: Period; setPeriod: (p: Period) => void; season: Season }) {
  const isCurrent = period.to >= today();
  return (
    <div className="row-between wrap">
      <div className="seg big-seg" role="group" aria-label="Period">
        {(["day", "week", "month", "season"] as PeriodKind[]).map((k) => (
          <button key={k} aria-pressed={period.kind === k} onClick={() => setPeriod(periodContaining(k, today(), season))}>
            {{ day: "Day", week: "Week", month: "Month", season: "Season" }[k]}
          </button>
        ))}
      </div>
      <div className="row">
        <button className="small" aria-label="Previous period" onClick={() => setPeriod(shiftPeriod(period, -1))}>‹</button>
        <strong>{periodLabel(period)}</strong>
        <button className="small" aria-label="Next period" disabled={isCurrent} onClick={() => setPeriod(shiftPeriod(period, 1))}>›</button>
      </div>
    </div>
  );
}

export function usePeriod(season: Season, key: string): [Period, (p: Period) => void] {
  const [kind, setKind] = useState<PeriodKind>(() => recall<PeriodKind>(`${key}.kind`, "week"));
  const [period, setPeriodState] = useState<Period>(() => periodContaining(kind, today(), season));
  useEffect(() => setPeriodState(periodContaining(kind, today(), season)), [season.start, season.end]);
  return [
    period,
    (p: Period) => {
      setPeriodState(p);
      setKind(p.kind);
      remember(`${key}.kind`, p.kind);
    },
  ];
}

/**
 * How much of the fixed costs to count. Overview shows true profit (100%) by default; owners can try
 * other shares in a folded panel. Customers always use profit from the job (0%): dropping a customer
 * doesn't lower the rent, so fixed costs shouldn't decide who to keep.
 */
export function FixedSlider({ value, onChange, fixed }: { value: number; onChange: (n: number) => void; fixed: number }) {
  return (
    <section className="card fixbar">
      <label className="fixbar-label" htmlFor="fixpct">
        <span>
          <b>Fixed costs counted: {value}%</b>
          <span className="muted small-text">
            {value === 0 ? " Profit from the jobs alone." : value === 100 ? " True profit: everything paid." : ` ${money(Math.round((fixed * value) / 100), { whole: true })} of ${money(fixed, { whole: true })}.`}
          </span>
        </span>
        <span className="row">
          <button type="button" className="small" aria-pressed={value === 0} onClick={() => onChange(0)}>Jobs only</button>
          <button type="button" className="small" aria-pressed={value === 100} onClick={() => onChange(100)}>True profit</button>
        </span>
      </label>
      <input id="fixpct" type="range" min={0} max={100} step={5} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </section>
  );
}

export function useFixedPct(): [number, (n: number) => void] {
  const [v, setV] = useState(() => recall("fixPct2", 100));
  return [v, (n) => { setV(n); remember("fixPct2", n); }];
}

function Overview({ companyId, companyName, season }: { companyId: string; companyName: string; season: Season }) {
  const [period, setPeriod] = usePeriod(season, "overview");
  const [fixPct, setFixPct] = useFixedPct();
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
      setJobs((j.data as Job[]) ?? []);
    })();
    return () => {
      live = false;
    };
  }, [companyId, period]);

  const share = fixPct / 100;
  const net = (j: Job) => j.profit_cents - Math.round(j.fixed_share_cents * share);

  const sorted = [...jobs].sort((x, y) => net(x) - net(y));
  function exportJobs() {
    download(
      `${companyName} jobs ${period.from} to ${period.to}.csv`,
      toCsv(
        ["Date", "Address", "Customer", "Crew", "Type", "Revenue", "Labour", "Fuel", "Materials", "Maintenance", "Profit from the job", "Share of fixed costs", "Profit after fixed costs", "Minutes on site", "Complaint"],
        jobs.map((j) => [j.day, j.address, j.customer, j.crew, SOURCE[j.source] ?? j.source, j.revenue_cents / 100, j.labour_cents / 100, j.fuel_cents / 100, j.materials_cents / 100, j.maintenance_cents / 100, j.profit_cents / 100, j.fixed_share_cents / 100, j.net_cents / 100, j.minutes, j.complaint ? "yes" : ""]),
      ),
    );
  }

  return (
    <div className="stack">
      <PeriodBar period={period} setPeriod={setPeriod} season={season} />
      {error && <p className="error">{error}</p>}
      {now && <Report s={now} prev={prev} period={period} share={share} />}
      <details className="card try-fixed" open={fixPct !== 100}>
        <summary>Try counting only part of the fixed costs</summary>
        <FixedSlider value={fixPct} onChange={setFixPct} fixed={now?.fixed_cents ?? 0} />
      </details>
      <section className="card">
        <div className="row-between">
          <h2>Jobs, least profitable first</h2>
          <button className="small" onClick={exportJobs} disabled={!jobs.length}>
            Download (Excel/CSV)
          </button>
        </div>
        {sorted.length === 0 ? (
          <p className="muted">No finished jobs in this period.</p>
        ) : (
          <div className="table-wrap">
            <table className="fin">
              <thead>
                <tr>
                  <th>Job</th><th>Crew</th><th className="n">Revenue</th><th className="n">Labour</th><th className="n">Fuel</th><th className="n">Materials</th><th className="n">Maint.</th><th className="n">Job profit</th>{share > 0 && <><th className="n">Fixed share</th><th className="n">After fixed</th></>}
                </tr>
              </thead>
              <tbody>
                {sorted.slice(0, 50).map((j) => (
                  <tr key={j.visit_id} className={net(j) < 0 ? "loss" : ""}>
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
                    <td className="n">{money(j.maintenance_cents)}</td>
                    <td className={`n ${share ? "" : "strong"}`}>{money(j.profit_cents)}</td>
                    {share > 0 && (
                      <>
                        <td className="n muted">{money(Math.round(j.fixed_share_cents * share))}</td>
                        <td className="n strong">{money(net(j))}</td>
                      </>
                    )}
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

const PERIOD_WORD: Record<PeriodKind, string> = { day: "Today", week: "This week", month: "This month", season: "This season" };

function Report({ s, prev, period, share }: { s: FinanceSummary; prev: FinanceSummary | null; period: Period; share: number }) {
  const totalCost = costs(s);
  const fixedAll = s.fixed_cents ?? 0;
  const fixed = Math.round(fixedAll * share);
  const net = s.profit_cents - fixed;
  const prevNet = prev ? prev.profit_cents - Math.round((prev.fixed_cents ?? 0) * share) : undefined;
  const margin = pct(net, s.revenue_cents);
  const per100 = s.revenue_cents ? Math.round((net / s.revenue_cents) * 100) : 0;
  const isPast = period.to < new Date().toLocaleDateString("en-CA");
  const when = isPast ? `In ${periodLabel(period)}` : PERIOD_WORD[period.kind];
  const sentence = !s.revenue_cents
    ? `${when}: no finished jobs yet.`
    : net >= 0
      ? `${when} you kept ${money(per100 * 100, { whole: true })} of every $100 you charged, after paying crews, fuel, materials and maintenance${share === 1 ? " and all your fixed costs" : fixed ? ` and ${Math.round(share * 100)}% of your fixed costs` : ""}.`
      : `${when} you lost ${money(-per100 * 100, { whole: true })} on every $100 you charged. Costs were higher than what the jobs brought in.`;
  const complaintRate = pct(s.complaint_jobs, s.jobs);
  const costParts = [
    { key: "Labour", v: s.labour_cents },
    { key: "Fuel", v: s.fuel_cents },
    { key: "Materials", v: s.materials_cents },
    { key: "Maintenance", v: s.maintenance_cents },
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
  if (s.jobs && !s.labour_cents) watch.push({ text: "No pay rates set, so labour shows as $0. Add them under Costs.", level: "warn" });
  if (s.jobs && !fixedAll) watch.push({ text: "No fixed costs entered (insurance, rent, software, depreciation…). Add them under Costs to see true profit.", level: "warn" });

  return (
    <>
      <p className="plain">{sentence}</p>
      <section className="hero card">
        <div>
          <p className="eyebrow">{share === 0 ? "Profit from jobs" : share === 1 ? "True profit (after fixed costs)" : `Profit after ${Math.round(share * 100)}% of fixed costs`}</p>
          <p className="hero-num">{money(net, { whole: true })}</p>
          <Delta now={net} before={prevNet} />
          {fixed > 0 && (
            <p className="muted small-text">
              Jobs made {money(s.profit_cents, { whole: true })} → {money(net, { whole: true })} left after {share === 1 ? "bills" : `${Math.round(share * 100)}% of bills`}
            </p>
          )}
        </div>
        <dl className="hero-side">
          <div><dt>Revenue</dt><dd>{money(s.revenue_cents, { whole: true })}</dd><Delta now={s.revenue_cents} before={prev?.revenue_cents} /></div>
          <div><dt>Job costs</dt><dd>{money(totalCost, { whole: true })}</dd><Delta now={totalCost} before={prev ? costs(prev) : undefined} invert /></div>
          <div><dt>Fixed costs{share < 1 ? ` (${Math.round(share * 100)}% counted)` : ""}</dt><dd>{money(fixed, { whole: true })}</dd></div>
          <div><dt>Jobs done</dt><dd>{s.jobs}</dd></div>
          <div><dt>Per hour on site</dt><dd>{perHour(net, s.crews.reduce((a, c) => a + c.minutes, 0))}</dd></div>
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

      {s.revenue_cents > 0 && <WhatIf s={s} fixed={fixed} net={net} />}
      <Glossary fuel={s} />
    </>
  );
}

/** Every $100 charged, split into job costs, fixed costs and what's kept. */
function Per100({ revenue, jobCosts, fixed }: { revenue: number; jobCosts: number; fixed: number }) {
  const kept = revenue - jobCosts - fixed;
  const parts = [
    { key: "Job costs (crews, fuel, materials, maintenance)", v: jobCosts, cls: "seg-1" },
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
function WhatIf({ s, fixed, net: now }: { s: FinanceSummary; fixed: number; net: number }) {
  const [f, setF] = useState({ fuel: 0, labour: 0, fixed: 0, prices: 0 });
  const k = (n: number) => 1 + n / 100;
  const revenue = s.revenue_cents * k(f.prices);
  const net = revenue - s.labour_cents * k(f.labour) - s.fuel_cents * k(f.fuel) - s.materials_cents - s.maintenance_cents - fixed * k(f.fixed);
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
        <dt>Variable costs (job costs)</dt><dd>Costs that grow with every job: crew pay (including drive time), fuel, maintenance and materials.</dd>
        <dt>Fixed costs</dt><dd>What you pay every month no matter how many jobs you do: insurance, subscriptions, marketing, licences, rent, and depreciation of trucks and mowers. Each job carries a share in proportion to what it earns.</dd>
        <dt>The fixed-cost slider</dt><dd>At 0% you see what the jobs themselves earn. Slide to 100% for true profit after every bill.</dd>
        <dt>Maintenance</dt><dd>Wear and tear: a set amount per km driven plus per mower engine hour (oil, blades, tires, repairs).</dd>
        <dt>Depreciation</dt><dd>What a truck or mower loses in value each month: its price ÷ years you'll keep it ÷ 12.</dd>
        <dt>Fuel</dt><dd>Truck: kilometres from GPS × litres per 100 km × the fuel price. Mowers: hours on site × how much they run × litres per hour. This period used {price}, from {from}.</dd>
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

export function perHour(cents: number, minutes: number) {
  return minutes ? `${money(Math.round((cents / minutes) * 60), { whole: true })}/h` : "–";
}
