// Payroll download: hours per person per week, with unpaid lunch removed and overtime split out.
import { useEffect, useState } from "react";
import { money, periodContaining, periodLabel, shiftPeriod, toCsv, type Period } from "@zentek/shared";
import { supabase } from "../supabase";
import { download } from "./download";

type Row = {
  crew_member_id: string; full_name: string; crew: string | null; week_start: string;
  paid_hours: number; regular_hours: number; overtime_hours: number; hourly_cost_cents: number; cost_cents: number;
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
        ["Week starting", "Name", "Crew", "Paid hours", "Regular hours", "Overtime hours", "Hourly cost", "Total cost"],
        rows.map((r) => [r.week_start, r.full_name, r.crew, Number(r.paid_hours), Number(r.regular_hours), Number(r.overtime_hours), r.hourly_cost_cents / 100, r.cost_cents / 100]),
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
          <div className="table-wrap">
            <table className="fin">
              <thead>
                <tr>
                  <th>Week of</th><th>Name</th><th>Crew</th><th className="n">Paid h</th><th className="n">Regular h</th><th className="n">Overtime h</th><th className="n">Cost</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.crew_member_id + r.week_start}>
                    <td>{r.week_start}</td>
                    <td><b>{r.full_name}</b></td>
                    <td>{r.crew ?? "–"}</td>
                    <td className="n">{Number(r.paid_hours).toFixed(2)}</td>
                    <td className="n">{Number(r.regular_hours).toFixed(2)}</td>
                    <td className={`n ${Number(r.overtime_hours) > 0 ? "warn-text" : ""}`}>{Number(r.overtime_hours).toFixed(2)}</td>
                    <td className="n">{money(r.cost_cents)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={3}><b>Total</b></td>
                  <td className="n"><b>{totals.h.toFixed(2)}</b></td>
                  <td />
                  <td className="n"><b>{totals.ot.toFixed(2)}</b></td>
                  <td className="n"><b>{money(totals.cost)}</b></td>
                </tr>
              </tfoot>
            </table>
          </div>
          <button className="small primary" onClick={save}>
            Download payroll (Excel/CSV)
          </button>
        </>
      )}
      <p className="muted small-text">For now everyone on a crew gets the crew's clocked hours. Per-person clock-in comes later.</p>
    </section>
  );
}
