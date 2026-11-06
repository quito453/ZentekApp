// What each customer (or area) brings in, what it costs to serve, and the time it takes:
// on site and driving there. Tap a customer for their visit history and a suggested price.
import { useEffect, useMemo, useState } from "react";
import { money, needsPriceReview, profitPerHour, suggestedPrice, toCsv, type Season } from "@zentek/shared";
import { supabase } from "../supabase";
import { download } from "./download";
import { FixedSlider, PeriodBar, useFixedPct, usePeriod } from "./Finance";

type Row = {
  customer_id: string; customer: string; property_id: string; address: string; area: string | null; crew: string | null;
  visits: number; revenue_cents: number; costs_cents: number; profit_cents: number; fixed_share_cents: number; net_cents: number;
  site_minutes: number; drive_minutes: number;
};
type Line = Omit<Row, "customer_id" | "property_id" | "address" | "crew"> & { key: string; title: string; sub: string; properties?: number };
type Visit = { visit_id: string; day: string; property_id: string; revenue_cents: number; labour_cents: number; fuel_cents: number; materials_cents: number; maintenance_cents: number; profit_cents: number; fixed_share_cents: number; minutes: number; km: number };

const hm = (m: number) => (m >= 60 ? `${Math.floor(m / 60)} h ${String(Math.round(m % 60)).padStart(2, "0")}` : `${Math.round(m)} min`);

export function Customers({ companyId, companyName, season }: { companyId: string; companyName: string; season: Season }) {
  const [period, setPeriod] = usePeriod(season, "customers");
  const [fixPct, setFixPct] = useFixedPct();
  const [rows, setRows] = useState<Row[]>([]);
  const [by, setBy] = useState<"customer" | "area">("customer");
  const [open, setOpen] = useState<Row | null>(null);
  const [error, setError] = useState("");
  const [q, setQ] = useState("");
  const share = fixPct / 100;

  useEffect(() => {
    supabase!.rpc("customer_profit", { p_company: companyId, p_from: period.from, p_to: period.to }).then(({ data, error }) => {
      setError(error?.message ?? "");
      setRows((data as Row[]) ?? []);
    });
  }, [companyId, period.from, period.to]);

  const net = (r: { profit_cents: number; fixed_share_cents: number }) => r.profit_cents - Math.round(r.fixed_share_cents * share);
  const totals = rows.reduce((a, r) => ({ net: a.net + net(r), mins: a.mins + r.site_minutes }), { net: 0, mins: 0 });
  const avgPerHour = profitPerHour(totals.net, totals.mins);

  const lines: Line[] = useMemo(() => {
    if (by === "customer")
      return rows.map((r) => ({ ...r, key: r.property_id, title: r.customer, sub: [r.address, r.area, r.crew].filter(Boolean).join(" · ") }));
    const g = new Map<string, Line>();
    for (const r of rows) {
      const k = r.area || "No area set";
      const l = g.get(k) ?? { key: k, title: k, sub: "", area: r.area, properties: 0, visits: 0, revenue_cents: 0, costs_cents: 0, profit_cents: 0, fixed_share_cents: 0, net_cents: 0, site_minutes: 0, drive_minutes: 0, customer: "" };
      l.properties! += 1;
      for (const f of ["visits", "revenue_cents", "costs_cents", "profit_cents", "fixed_share_cents", "net_cents", "site_minutes", "drive_minutes"] as const) l[f] += r[f];
      g.set(k, l);
    }
    return [...g.values()].map((l) => ({ ...l, sub: `${l.properties} propert${l.properties === 1 ? "y" : "ies"}` }));
  }, [rows, by]);

  const shown = lines
    .filter((l) => !q || `${l.title} ${l.sub}`.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => profitPerHour(net(a), a.site_minutes) - profitPerHour(net(b), b.site_minutes));

  function save() {
    download(
      `${companyName} ${by === "customer" ? "customers" : "areas"} ${period.from} to ${period.to}.csv`,
      toCsv(
        [by === "customer" ? "Customer" : "Area", by === "customer" ? "Address" : "Properties", "Visits", "Revenue", "Job costs", "Share of fixed costs", "Profit", "Minutes on site", "Minutes driving", "Profit per hour on site"],
        shown.map((l) => [l.title, by === "customer" ? l.sub : l.properties, l.visits, l.revenue_cents / 100, l.costs_cents / 100, Math.round(l.fixed_share_cents * share) / 100, net(l) / 100, l.site_minutes, l.drive_minutes, profitPerHour(net(l), l.site_minutes) / 100]),
      ),
    );
  }

  return (
    <div className="stack">
      <FixedSlider value={fixPct} onChange={setFixPct} fixed={rows.reduce((a, r) => a + r.fixed_share_cents, 0)} />
      <PeriodBar period={period} setPeriod={setPeriod} season={season} />
      {error && <p className="error">{error}</p>}
      <section className="card stack">
        <div className="row-between wrap">
          <div className="seg" role="group" aria-label="Group by">
            <button aria-pressed={by === "customer"} onClick={() => setBy("customer")}>By customer</button>
            <button aria-pressed={by === "area"} onClick={() => setBy("area")}>By area</button>
          </div>
          <div className="row">
            <input type="search" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search customers" />
            <button className="small" disabled={!shown.length} onClick={save}>Download (Excel/CSV)</button>
          </div>
        </div>
        <p className="muted small-text">
          Lowest profit per hour first. Your average is <b>{avgPerHour ? money(avgPerHour, { whole: true }) : "–"}</b> an hour on site. Rows in amber earn under 85% of it.
        </p>
        {shown.length === 0 ? (
          <p className="muted">No finished jobs in this period.</p>
        ) : (
          <div className="table-wrap">
            <table className="fin">
              <thead>
                <tr>
                  <th>{by === "customer" ? "Customer" : "Area"}</th><th className="n">Visits</th><th className="n">Revenue</th><th className="n">On site</th><th className="n">Driving</th><th className="n">Profit</th><th className="n">Per visit</th><th className="n">Per hour</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((l) => {
                  const ph = profitPerHour(net(l), l.site_minutes);
                  const row = by === "customer" ? rows.find((r) => r.property_id === l.key) ?? null : null;
                  return (
                    <tr key={l.key} className={net(l) < 0 ? "loss" : needsPriceReview(ph, avgPerHour) ? "review" : ""}>
                      <td>
                        {row ? <button className="link strong" onClick={() => setOpen(row)}>{l.title}</button> : <b>{l.title}</b>}
                        <div className="muted small-text">{l.sub}</div>
                      </td>
                      <td className="n">{l.visits}</td>
                      <td className="n">{money(l.revenue_cents, { whole: true })}</td>
                      <td className="n">{hm(l.site_minutes)}</td>
                      <td className="n">{l.drive_minutes ? hm(l.drive_minutes) : "–"}</td>
                      <td className="n strong">{money(net(l), { whole: true })}</td>
                      <td className="n">{money(Math.round(net(l) / Math.max(1, l.visits)), { whole: true })}</td>
                      <td className="n">{l.site_minutes ? money(ph, { whole: true }) : "–"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {open && <CustomerDetail companyId={companyId} row={open} share={share} avgPerHour={avgPerHour} season={season} onClose={() => setOpen(null)} />}
    </div>
  );
}

function CustomerDetail({ companyId, row, share, avgPerHour, season, onClose }: { companyId: string; row: Row; share: number; avgPerHour: number; season: Season; onClose: () => void }) {
  const [visits, setVisits] = useState<Visit[]>([]);
  // History covers this year's season (or the last one, off season).
  const [from, to] = useMemo(() => {
    const y = new Date().getFullYear();
    return [`${y - 1}-${String(season.start).padStart(2, "0")}-01`, new Date().toLocaleDateString("en-CA")];
  }, [season.start]);
  useEffect(() => {
    supabase!.rpc("job_profit", { p_company: companyId, p_from: from, p_to: to }).then(({ data }) => {
      setVisits(((data as Visit[]) ?? []).filter((v) => v.property_id === row.property_id).sort((a, b) => b.day.localeCompare(a.day)));
    });
  }, [companyId, row.property_id, from, to]);

  const net = (v: { profit_cents: number; fixed_share_cents: number }) => v.profit_cents - Math.round(v.fixed_share_cents * share);
  const total = visits.reduce(
    (a, v) => ({ n: a.n + 1, rev: a.rev + v.revenue_cents, net: a.net + net(v), cost: a.cost + (v.revenue_cents - net(v)), mins: a.mins + v.minutes }),
    { n: 0, rev: 0, net: 0, cost: 0, mins: 0 },
  );
  const ph = profitPerHour(total.net, total.mins);
  const price = suggestedPrice({ visits: total.n, costsCents: total.cost, siteMinutes: total.mins, avgPerHourCents: avgPerHour });
  const avgPrice = total.n ? Math.round(total.rev / total.n) : 0;

  return (
    <div className="sheet-back" role="dialog" aria-modal="true" aria-labelledby="cust-h" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <section className="card sheet stack">
        <div className="row-between">
          <h2 id="cust-h">{row.customer}</h2>
          <button className="small" onClick={onClose}>Close</button>
        </div>
        <p className="muted">{[row.address, row.area, row.crew].filter(Boolean).join(" · ")}</p>
        <dl className="kv">
          <div><dt>Revenue since last season</dt><dd>{money(total.rev, { whole: true })}</dd></div>
          <div><dt>Profit</dt><dd>{money(total.net, { whole: true })}</dd></div>
          <div><dt>Per visit</dt><dd>{total.n ? money(Math.round(total.net / total.n), { whole: true }) : "–"}</dd></div>
          <div><dt>Per hour on site</dt><dd>{total.mins ? money(ph, { whole: true }) : "–"}</dd></div>
        </dl>
        {price !== null && needsPriceReview(ph, avgPerHour) ? (
          <p className="plain small">
            This customer earns {money(ph, { whole: true })} an hour against your average of {money(avgPerHour, { whole: true })}. Charging{" "}
            <b>{money(price, { whole: true })}</b> a visit (now about {money(avgPrice, { whole: true })}) would bring it to your average.
          </p>
        ) : price !== null ? (
          <p className="plain small">At {money(ph, { whole: true })} an hour this customer is at or above your average of {money(avgPerHour, { whole: true })}.</p>
        ) : null}
        <h3>Visits</h3>
        <div className="table-wrap">
          <table className="fin">
            <thead><tr><th>Date</th><th className="n">Price</th><th className="n">On site</th><th className="n">Km</th><th className="n">Costs</th><th className="n">Profit</th></tr></thead>
            <tbody>
              {visits.map((v) => (
                <tr key={v.visit_id} className={net(v) < 0 ? "loss" : ""}>
                  <td>{v.day}</td>
                  <td className="n">{money(v.revenue_cents)}</td>
                  <td className="n">{v.minutes} min</td>
                  <td className="n">{Number(v.km).toFixed(1)}</td>
                  <td className="n">{money(v.revenue_cents - net(v))}</td>
                  <td className="n strong">{money(net(v))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
