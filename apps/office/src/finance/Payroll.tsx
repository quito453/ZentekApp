// Payroll: hours per person per week, with unpaid lunch removed, overtime split out, and paid time
// split into on site, driving and other (loading, the shop, waiting), grouped by crew.
import { useEffect, useState } from "react";
import { money, periodContaining, periodLabel, shiftPeriod, toCsv, type Period } from "@zentek/shared";
import { supabase } from "../supabase";
import { download } from "./download";

type Row = {
  crew_member_id: string; full_name: string; crew: string | null; week_start: string;
  paid_hours: number; regular_hours: number; overtime_hours: number; on_site_hours: number; driving_hours: number; other_hours: number;
  hourly_cost_cents: number; cost_cents: number;
};

const today = () => new Date().toLocaleDateString("en-CA");

export function Payroll({ companyId }: { companyId: string }) {
  const choices: [string, Period][] = [
    ["This week", periodContaining("week", today())],
    ["Last week", shiftPeriod(periodContaining("week", today()), -1)],
    ["This month", periodContaining("month", today())],
    ["Last month", shiftPeriod(periodContaining("month", today()), -1)],
  ];
  const [choice, setChoice] = useState(1);
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState("");
  const period = choices[choice]![1];

  useEffect(() => {
    supabase!.rpc("payroll", { p_company: companyId, p_from: period.from, p_to: period.to }).then(({ data, error }) => {
      setError(error?.message ?? "");
      setRows((data as Row[]) ?? []);
    });
  }, [companyId, period.from, period.to]);

  const totals = rows.reduce((a, r) => ({ h: a.h + Number(r.paid_hours), ot: a.ot + Number(r.overtime_hours), cost: a.cost + r.cost_cents }), { h: 0, ot: 0, cost: 0 });

  function save() {
    download(
      `Payroll ${period.from} to ${period.to}.csv`,
      toCsv(
        ["Week starting", "Name", "Crew", "Paid hours", "Regular hours", "Overtime hours", "On site hours", "Driving hours", "Other hours", "Hourly cost", "Total cost"],
        rows.map((r) => [r.week_start, r.full_name, r.crew, Number(r.paid_hours), Number(r.regular_hours), Number(r.overtime_hours), Number(r.on_site_hours), Number(r.driving_hours), Number(r.other_hours), r.hourly_cost_cents / 100, r.cost_cents / 100]),
      ),
    );
  }

  return (
    <section className="card stack">
      <div className="row-between wrap">
        <h2>Payroll</h2>
        <div className="seg" role="group" aria-label="Pay period">
          {choices.map(([label], i) => (
            <button key={label} aria-pressed={choice === i} onClick={() => setChoice(i)}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <p className="muted">
        {periodLabel(period)}. Paid hours are shift time minus lunch; breaks are paid. Overtime starts after the weekly hours set under Costs and rates.
      </p>
      {error && <p className="error">{error}</p>}
      {rows.length === 0 ? (
        <p className="muted">No finished shifts in this period.</p>
      ) : (
        <>
          <TimeSplit rows={rows} />
          {[...new Set(rows.map((r) => r.crew ?? "No crew"))].map((crew) => {
            const cr = rows.filter((r) => (r.crew ?? "No crew") === crew);
            return (
              <div key={crew} className="table-wrap">
                <h3 className="crew-head">{crew}</h3>
                <table className="fin">
                  <thead>
                    <tr>
                      <th>Week of</th><th>Name</th><th className="n">Paid h</th><th className="n">On site</th><th className="n">Driving</th><th className="n">Other</th><th className="n">Overtime h</th><th className="n">Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cr.map((r) => (
                      <tr key={r.crew_member_id + r.week_start}>
                        <td>{r.week_start}</td>
                        <td><b>{r.full_name}</b></td>
                        <td className="n">{h(r.paid_hours)}</td>
                        <td className="n">{h(r.on_site_hours)}</td>
                        <td className="n">{h(r.driving_hours)}</td>
                        <td className="n">{h(r.other_hours)}</td>
                        <td className={`n ${Number(r.overtime_hours) > 0 ? "warn-text" : ""}`}>{h(r.overtime_hours)}</td>
                        <td className="n">{money(r.cost_cents)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          })}
          <p className="row-between"><b>All crews</b><b>{totals.h.toFixed(2)} h · {totals.ot.toFixed(2)} h overtime · {money(totals.cost)}</b></p>
          <button className="small primary" onClick={save}>
            Download payroll (Excel/CSV)
          </button>
        </>
      )}
      <p className="muted small-text">Everyone on a crew gets the crew's clocked hours. On site and driving come from the tablet's arrivals and departures; other is the rest of the shift.</p>
    </section>
  );
}

const h = (v: number | string) => Number(v).toFixed(2);

/** Where the paid hours went, as one bar. */
function TimeSplit({ rows }: { rows: Row[] }) {
  const t = rows.reduce((a, r) => ({ site: a.site + Number(r.on_site_hours), drive: a.drive + Number(r.driving_hours), other: a.other + Number(r.other_hours) }), { site: 0, drive: 0, other: 0 });
  const all = t.site + t.drive + t.other;
  if (!all) return null;
  const parts = [
    { k: "On site (billable)", v: t.site, cls: "seg-3" },
    { k: "Driving between stops", v: t.drive, cls: "seg-1" },
    { k: "Other (loading, shop, waiting)", v: t.other, cls: "seg-4" },
  ];
  return (
    <div>
      <div className="splitbar" role="img" aria-label={parts.map((p) => `${p.k} ${Math.round((p.v / all) * 100)}%`).join(", ")}>
        {parts.map((p) => (p.v > 0 ? <span key={p.k} className={p.cls} style={{ flexGrow: p.v }} /> : null))}
      </div>
      <table className="legend-table">
        <tbody>
          {parts.map((p) => (
            <tr key={p.k}><td><span className={`swatch ${p.cls}`} aria-hidden="true" />{p.k}</td><td className="n">{p.v.toFixed(1)} h</td><td className="n muted">{Math.round((p.v / all) * 100)}%</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
