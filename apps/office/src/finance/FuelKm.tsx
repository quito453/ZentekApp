// Fuel and kilometres: every drive from one stop to the next (from the tablets' GPS), what the fuel
// to get there cost, how long the crew spent at each client, and GPS compared with the odometer.
import { useEffect, useState } from "react";
import { money, toCsv, type Season } from "@zentek/shared";
import { supabase } from "../supabase";
import { download } from "./download";
import { PeriodBar, usePeriod } from "./Finance";

type Trip = {
  crew_id: string; crew: string | null; day: string; visit_id: string; from_address: string; to_address: string; customer: string;
  left_at: string | null; arrived_at: string; departed_at: string | null; drive_minutes: number | null; km: number | null;
  fuel_cents: number | null; site_minutes: number | null; arrival_source: string | null;
};
type Odo = { truck_id: string; truck: string; crew: string | null; day: string; start_km: number; end_km: number | null; odometer_km: number | null; gps_km: number; gap_pct: number | null };

const time = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit" }) : "–");
const hm = (m: number) => (m >= 60 ? `${Math.floor(m / 60)} h ${String(Math.round(m % 60)).padStart(2, "0")}` : `${Math.round(m)} min`);
const sum = <T,>(xs: T[], f: (x: T) => number | null | undefined) => xs.reduce((a, x) => a + Number(f(x) ?? 0), 0);

export function FuelKm({ companyId, companyName, season }: { companyId: string; companyName: string; season: Season }) {
  const [period, setPeriod] = usePeriod(season, "fuel");
  const [trips, setTrips] = useState<Trip[]>([]);
  const [odo, setOdo] = useState<Odo[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    (async () => {
      const [t, o] = await Promise.all([
        supabase!.rpc("crew_trips", { p_company: companyId, p_from: period.from, p_to: period.to }),
        supabase!.rpc("gps_vs_odometer", { p_company: companyId, p_from: period.from, p_to: period.to }),
      ]);
      setError(t.error?.message ?? o.error?.message ?? "");
      setTrips((t.data as Trip[]) ?? []);
      setOdo((o.data as Odo[]) ?? []);
    })();
  }, [companyId, period.from, period.to]);

  // Crew → day → trips
  const crews = [...new Set(trips.map((t) => t.crew ?? "No crew"))];

  function saveTrips() {
    download(
      `${companyName} trips ${period.from} to ${period.to}.csv`,
      toCsv(
        ["Date", "Crew", "From", "To", "Customer", "Left", "Arrived", "Drive minutes", "Km (GPS)", "Fuel to get there", "Minutes on site", "Arrival recorded by"],
        trips.map((t) => [t.day, t.crew, t.from_address, t.to_address, t.customer, time(t.left_at), time(t.arrived_at), t.drive_minutes, t.km === null ? null : Number(t.km), t.fuel_cents === null ? null : t.fuel_cents / 100, t.site_minutes, t.arrival_source === "geofence" ? "GPS" : t.arrival_source ?? "tap"]),
      ),
    );
  }
  function saveDays() {
    const keys = [...new Set(trips.map((t) => `${t.day}|${t.crew ?? ""}`))];
    download(
      `${companyName} fuel per day ${period.from} to ${period.to}.csv`,
      toCsv(
        ["Date", "Crew", "Stops", "Km (GPS)", "Drive time (min)", "Time on site (min)", "Fuel cost", "Odometer km"],
        keys.map((k) => {
          const [day, crew] = k.split("|");
          const ts = trips.filter((t) => t.day === day && (t.crew ?? "") === crew);
          const o = odo.find((x) => x.day === day && (x.crew ?? "") === crew);
          return [day, crew, ts.length, Math.round(sum(ts, (t) => t.km) * 10) / 10, sum(ts, (t) => t.drive_minutes), sum(ts, (t) => t.site_minutes), sum(ts, (t) => t.fuel_cents) / 100, o?.odometer_km ?? null];
        }),
      ),
    );
  }

  return (
    <div className="stack">
      <PeriodBar period={period} setPeriod={setPeriod} season={season} />
      {error && <p className="error">{error}</p>}
      <section className="card">
        <dl className="kv">
          <div><dt>Driven (GPS)</dt><dd>{sum(trips, (t) => t.km).toFixed(1)} km</dd></div>
          <div><dt>Fuel to reach stops</dt><dd>{money(sum(trips, (t) => t.fuel_cents), { whole: true })}</dd></div>
          <div><dt>Driving</dt><dd>{hm(sum(trips, (t) => t.drive_minutes))}</dd></div>
          <div><dt>At clients</dt><dd>{hm(sum(trips, (t) => t.site_minutes))}</dd></div>
        </dl>
        <div className="row wrap">
          <button className="small" disabled={!trips.length} onClick={saveTrips}>Download every trip (CSV)</button>
          <button className="small" disabled={!trips.length} onClick={saveDays}>Download fuel per day (CSV)</button>
        </div>
      </section>

      {trips.length === 0 && (
        <section className="card">
          <p className="muted">No trips yet in this period. Trips appear when crews use the tablet with location on: it records when they arrive at and leave each property.</p>
        </section>
      )}
      {crews.map((crew) => {
        const ct = trips.filter((t) => (t.crew ?? "No crew") === crew);
        const days = [...new Set(ct.map((t) => t.day))];
        return (
          <section key={crew} className="card stack">
            <div className="row-between wrap">
              <h2 className="crew-head">{crew}</h2>
              <span className="muted small-text">
                {sum(ct, (t) => t.km).toFixed(1)} km · {money(sum(ct, (t) => t.fuel_cents), { whole: true })} fuel · {hm(sum(ct, (t) => t.drive_minutes))} driving · {hm(sum(ct, (t) => t.site_minutes))} on site
              </span>
            </div>
            {days.map((day) => (
              <div key={day} className="table-wrap">
                <h3 className="small-text muted">{new Date(day + "T12:00:00").toLocaleDateString("en-CA", { weekday: "long", month: "short", day: "numeric" })}</h3>
                <table className="fin">
                  <thead>
                    <tr><th>From → to</th><th className="n">Left</th><th className="n">Arrived</th><th className="n">Drive</th><th className="n">Km</th><th className="n">Fuel</th><th className="n">At client</th></tr>
                  </thead>
                  <tbody>
                    {ct.filter((t) => t.day === day).map((t) => (
                      <tr key={t.visit_id}>
                        <td>
                          <span className="muted">{t.from_address}</span> → <b>{t.to_address}</b>
                          {t.arrival_source === "geofence" && <span className="tag">GPS</span>}
                        </td>
                        <td className="n">{time(t.left_at)}</td>
                        <td className="n">{time(t.arrived_at)}</td>
                        <td className="n">{t.drive_minutes === null ? "–" : `${t.drive_minutes} min`}</td>
                        <td className="n">{t.km === null ? "–" : Number(t.km).toFixed(1)}</td>
                        <td className="n">{t.fuel_cents === null ? "–" : money(t.fuel_cents)}</td>
                        <td className="n">{t.site_minutes === null ? "–" : `${t.site_minutes} min`}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </section>
        );
      })}

      <section className="card stack">
        <h2>GPS compared with the odometer</h2>
        <p className="muted">
          Crews type the odometer at the start and end of the day. If GPS shows a lot less, the tablet was off or left behind for part of the day; if the odometer is much
          higher, the truck may have been used for something else.
        </p>
        {odo.length === 0 ? (
          <p className="muted">No odometer readings in this period.</p>
        ) : (
          <div className="table-wrap">
            <table className="fin">
              <thead><tr><th>Day</th><th>Truck</th><th className="n">Start</th><th className="n">End</th><th className="n">Odometer km</th><th className="n">GPS km</th><th className="n">Gap</th></tr></thead>
              <tbody>
                {odo.map((o) => (
                  <tr key={o.truck_id + o.day} className={o.gap_pct !== null && Math.abs(Number(o.gap_pct)) > 10 ? "review" : ""}>
                    <td>{o.day}</td>
                    <td><b>{o.truck}</b> <span className="muted small-text">{o.crew ?? ""}</span></td>
                    <td className="n">{o.start_km.toLocaleString()}</td>
                    <td className="n">{o.end_km === null ? "not yet" : o.end_km.toLocaleString()}</td>
                    <td className="n">{o.odometer_km ?? "–"}</td>
                    <td className="n">{Number(o.gps_km).toFixed(1)}</td>
                    <td className="n">{o.gap_pct === null ? "–" : `${Number(o.gap_pct) > 0 ? "+" : ""}${Number(o.gap_pct).toFixed(1)}%`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
