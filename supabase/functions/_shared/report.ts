// Report periods and the owner's email report. Plain TypeScript with no runtime imports, shared by
// the finance-report Edge Function (Deno) and the office app (re-exported by @zentek/shared).

export type PeriodKind = "day" | "week" | "month";
export interface Period {
  kind: PeriodKind;
  from: string; // YYYY-MM-DD, inclusive
  to: string; // YYYY-MM-DD, inclusive
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const parse = (s: string) => {
  const [y, m, d] = s.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d));
};
const plusDays = (s: string, n: number) => {
  const d = parse(s);
  d.setUTCDate(d.getUTCDate() + n);
  return iso(d);
};

/** The day, week (Monday–Sunday) or calendar month containing a date. */
export function periodContaining(kind: PeriodKind, date: string): Period {
  if (kind === "day") return { kind, from: date, to: date };
  const d = parse(date);
  if (kind === "week") {
    const back = (d.getUTCDay() + 6) % 7; // days since Monday
    const from = plusDays(date, -back);
    return { kind, from, to: plusDays(from, 6) };
  }
  const from = iso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)));
  const to = iso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)));
  return { kind, from, to };
}

/** The period before (n = -1) or after (n = 1). */
export function shiftPeriod(p: Period, n: number): Period {
  if (p.kind === "month") {
    const d = parse(p.from);
    return periodContaining("month", iso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1))));
  }
  return periodContaining(p.kind, plusDays(p.from, n * (p.kind === "week" ? 7 : 1)));
}

/** The last finished week or month before `today`: what a scheduled report covers. */
export function lastCompletePeriod(kind: "week" | "month", today: string): Period {
  return shiftPeriod(periodContaining(kind, today), -1);
}

export function periodLabel(p: Period, locale = "en-CA"): string {
  const f = (s: string, o: Intl.DateTimeFormatOptions) => parse(s).toLocaleDateString(locale, { timeZone: "UTC", ...o });
  if (p.kind === "day") return f(p.from, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  if (p.kind === "month") return f(p.from, { month: "long", year: "numeric" });
  return `${f(p.from, { month: "short", day: "numeric" })} – ${f(p.to, { month: "short", day: "numeric", year: "numeric" })}`;
}

/** Is a scheduled report due today? weeklyDay: 0 Sunday … 6 Saturday. */
export function reportsDue(
  today: string,
  s: { weekly: boolean; weekly_day: number; monthly: boolean; last_weekly_sent: string | null; last_monthly_sent: string | null },
): ("week" | "month")[] {
  const due: ("week" | "month")[] = [];
  if (s.weekly && parse(today).getUTCDay() === s.weekly_day && s.last_weekly_sent !== today) due.push("week");
  if (s.monthly && today.endsWith("-01") && s.last_monthly_sent !== today) due.push("month");
  return due;
}

// ───────────────────────────── the summary the database returns ─────────────────────────────
export interface CrewLine {
  crew_id: string;
  name: string;
  revenue_cents: number;
  profit_cents: number;
  jobs: number;
  minutes: number;
  complaints: number;
  leads_created: number;
  leads_won: number;
}
export interface FinanceSummary {
  from: string;
  to: string;
  jobs: number;
  revenue_cents: number;
  labour_cents: number;
  fuel_cents: number;
  materials_cents: number;
  truck_cents: number;
  profit_cents: number;
  losing_jobs: number;
  complaint_jobs: number;
  mix: { regular_cents: number; new_customer_cents: number; upsell_cents: number; other_cents: number };
  leads: { created: number; won: number; open: number };
  monthly_target_cents: number | null;
  crews: CrewLine[];
}

export const money = (cents: number, opts: { whole?: boolean } = {}) =>
  (cents / 100).toLocaleString("en-CA", { style: "currency", currency: "CAD", maximumFractionDigits: opts.whole ? 0 : 2, minimumFractionDigits: opts.whole ? 0 : 2 });

export const pct = (part: number, whole: number) => (whole ? Math.round((part / whole) * 1000) / 10 : 0);

/** Change from the previous period, e.g. "+12.5%"; null when there is nothing to compare. */
export function change(now: number, before: number): string | null {
  if (!before) return null;
  const c = Math.round(((now - before) / Math.abs(before)) * 1000) / 10;
  return `${c > 0 ? "+" : ""}${c}%`;
}

export function costs(s: FinanceSummary): number {
  return s.labour_cents + s.fuel_cents + s.materials_cents + s.truck_cents;
}

// ───────────────────────────── the email ─────────────────────────────
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function renderReport(s: FinanceSummary, opts: { companyName: string; period: Period; previous?: FinanceSummary; appUrl?: string }) {
  const margin = pct(s.profit_cents, s.revenue_cents);
  const label = periodLabel(opts.period);
  const subject = `${opts.companyName}: ${opts.period.kind === "month" ? "monthly" : "weekly"} report, ${label}`;
  const prev = opts.previous;
  const delta = (now: number, before?: number) => {
    const c = before === undefined ? null : change(now, before);
    return c ? ` <span style="color:${c.startsWith("-") ? "#b0402c" : "#2d7a4c"};font-size:13px">${c} vs previous</span>` : "";
  };
  const row = (k: string, v: string, note = "") =>
    `<tr><td style="padding:6px 0;color:#5a6962">${k}</td><td style="padding:6px 0;text-align:right;font-weight:600">${v}${note}</td></tr>`;
  const watch: string[] = [];
  if (s.losing_jobs) watch.push(`${s.losing_jobs} job${s.losing_jobs === 1 ? "" : "s"} lost money`);
  if (s.complaint_jobs) watch.push(`Complaints on ${pct(s.complaint_jobs, s.jobs)}% of jobs (${s.complaint_jobs})`);
  if (s.leads.open) watch.push(`${s.leads.open} lead${s.leads.open === 1 ? "" : "s"} from crews not closed yet`);
  const target =
    opts.period.kind === "month" && s.monthly_target_cents
      ? `<p style="margin:12px 0 0">Monthly target: ${money(s.monthly_target_cents, { whole: true })}, reached ${pct(s.revenue_cents, s.monthly_target_cents)}%.</p>`
      : "";
  const best = s.crews.filter((c) => c.jobs > 0);
  const crewRows = best
    .map(
      (c) =>
        `<tr><td style="padding:6px 8px 6px 0">${esc(c.name)}</td><td style="text-align:right">${c.jobs}</td><td style="text-align:right">${money(c.revenue_cents, { whole: true })}</td><td style="text-align:right">${money(c.profit_cents, { whole: true })}</td><td style="text-align:right">${c.minutes ? money(Math.round((c.profit_cents / c.minutes) * 60), { whole: true }) : "–"}</td><td style="text-align:right">${c.leads_won}/${c.leads_created}</td><td style="text-align:right">${pct(c.complaints, c.jobs)}%</td></tr>`,
    )
    .join("");

  const html = `<!doctype html><html><body style="margin:0;background:#f4f6f4;font-family:Segoe UI,Helvetica,Arial,sans-serif;color:#16201c">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:12px;padding:24px">
<tr><td>
<p style="margin:0;color:#5a6962;font-size:13px;text-transform:uppercase;letter-spacing:.06em">${esc(opts.companyName)} · ${esc(label)}</p>
<h1 style="margin:6px 0 4px;font-size:26px">Profit ${money(s.profit_cents, { whole: true })}${delta(s.profit_cents, prev?.profit_cents)}</h1>
<p style="margin:0 0 16px;color:#5a6962">${margin}% margin on ${money(s.revenue_cents, { whole: true })} revenue from ${s.jobs} jobs.</p>
<table role="presentation" width="100%" style="border-collapse:collapse;font-size:15px">
${row("Revenue", money(s.revenue_cents, { whole: true }), delta(s.revenue_cents, prev?.revenue_cents))}
${row("Labour", money(s.labour_cents, { whole: true }))}
${row("Fuel", money(s.fuel_cents, { whole: true }))}
${row("Materials", money(s.materials_cents, { whole: true }))}
${row("Truck wear", money(s.truck_cents, { whole: true }))}
${row("Profit", money(s.profit_cents, { whole: true }))}
</table>
${target}
<h2 style="font-size:17px;margin:24px 0 6px">Where revenue came from</h2>
<table role="presentation" width="100%" style="border-collapse:collapse;font-size:15px">
${row("Regular customers", money(s.mix.regular_cents, { whole: true }))}
${row("New customers", money(s.mix.new_customer_cents, { whole: true }))}
${row("Extra work from crew leads", money(s.mix.upsell_cents, { whole: true }))}
${s.mix.other_cents ? row("Redo and rescheduled", money(s.mix.other_cents, { whole: true })) : ""}
</table>
${watch.length ? `<h2 style="font-size:17px;margin:24px 0 6px">Needs a look</h2><ul style="margin:0;padding-left:20px">${watch.map((w) => `<li style="margin:4px 0">${esc(w)}</li>`).join("")}</ul>` : ""}
${
  crewRows
    ? `<h2 style="font-size:17px;margin:24px 0 6px">Crews</h2>
<table role="presentation" width="100%" style="border-collapse:collapse;font-size:14px">
<tr style="color:#5a6962;font-size:12px;text-transform:uppercase"><td>Crew</td><td style="text-align:right">Jobs</td><td style="text-align:right">Revenue</td><td style="text-align:right">Profit</td><td style="text-align:right">Profit/h</td><td style="text-align:right">Leads won</td><td style="text-align:right">Complaints</td></tr>
${crewRows}</table>`
    : ""
}
${opts.appUrl ? `<p style="margin:24px 0 0"><a href="${esc(opts.appUrl)}" style="color:#2c6a55;font-weight:600">Open Finance in Zentek</a></p>` : ""}
<p style="margin:24px 0 0;color:#5a6962;font-size:12px">Costs use the rates in Finance settings. Payroll and job details are in the app.</p>
</td></tr></table></td></tr></table></body></html>`;

  const text = [
    `${opts.companyName} · ${label}`,
    `Profit ${money(s.profit_cents, { whole: true })} (${margin}% margin) on ${money(s.revenue_cents, { whole: true })} from ${s.jobs} jobs.`,
    `Labour ${money(s.labour_cents, { whole: true })}, fuel ${money(s.fuel_cents, { whole: true })}, materials ${money(s.materials_cents, { whole: true })}, truck wear ${money(s.truck_cents, { whole: true })}.`,
    ...watch,
  ].join("\n");

  return { subject, html, text };
}
