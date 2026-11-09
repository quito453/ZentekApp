// Connections: Cutting Cost sits on top of the software a company already uses.
//   • Mode: Finance only (crews just clock in, odometer, GPS) or Everything (full crew app).
//   • Spreadsheet: any export with dates, customers, addresses and prices (Jobber, Yardbook, QuickBooks, Excel).
//   • Zapier / API: a key that lets Yardbook, Jobber or Google Sheets send each finished job as it happens.
//   • Jobber direct: needs Jobber's approval of our app; shown as coming.
import { useEffect, useState, type ChangeEvent } from "react";
import { FIELD_LABEL, IMPORT_FIELDS, guessMap, missingFields, parseCsv, readRows, type ColumnMap, type ImportField } from "@zentek/shared";
import { supabase } from "../supabase";

type Mode = "finance" | "full";
type Key = { id: string; name: string; prefix: string; created_at: string; last_used_at: string | null; revoked_at: string | null };
type Imp = { id: string; source: string; file_name: string | null; rows_in: number; rows_added: number; rows_skipped: number; created_at: string };

const SAMPLE =
  "Date,Client,Service address,Line item,Total,Assigned to\n2026-10-26,Hendricks,12 Maple Grove Rd,Weekly mow,55.00,Crew 2\n2026-10-26,Okafor,30 Maple Grove Rd,Weekly mow,55.00,Crew 2\n2026-10-27,Nguyen,19 Birch Cres,Weekly mow + fertilizer,120.00,Crew 2\n";
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short" }) : "never");
const INGEST_URL = `${import.meta.env.VITE_SUPABASE_URL ?? "https://YOUR-PROJECT.supabase.co"}/functions/v1/ingest`;

export function Connections({ companyId }: { companyId: string }) {
  const [mode, setMode] = useState<Mode | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    supabase!.from("companies").select("mode").eq("id", companyId).single<{ mode: Mode }>().then(({ data }) => setMode(data?.mode ?? "finance"));
  }, [companyId]);

  async function pick(m: Mode) {
    setMode(m);
    await supabase!.from("companies").update({ mode: m }).eq("id", companyId);
  }

  return (
    <div className="stack">
      <section className="card stack">
        <h2>How you use Cutting Cost</h2>
        <div className="opts">
          <button className="opt" aria-pressed={mode === "finance"} onClick={() => void pick("finance")}>
            <b>Finance only</b>
            <small>Keep your jobs in Jobber, Yardbook or a spreadsheet. Crews just sign in, type the odometer and keep location on. Cutting Cost works out the money.</small>
          </button>
          <button className="opt" aria-pressed={mode === "full"} onClick={() => void pick("full")}>
            <b>Everything</b>
            <small>Plan routes and run the day here too: checklists, photos, texts to customers and quality checks on the crew tablet.</small>
          </button>
        </div>
      </section>
      <div className="grid2">
        <section className="card stack">
          <div className="row-between"><h2>Jobber</h2><span className="tag">Coming</span></div>
          <p className="muted">
            A direct connection that brings in clients, properties and completed visits every few minutes. It needs Jobber to approve the Cutting Cost app first.
            Until then, connect Jobber through Zapier or download a visits report and import it below.
          </p>
        </section>
        <section className="card stack">
          <h2>Yardbook</h2>
          <p className="muted">
            Yardbook connects through Zapier: when a job is completed in Yardbook, Zapier sends it here. Make a key below, then in Zapier choose “Yardbook → Job Completed”
            and “Webhooks by Zapier → POST” to the address shown.
          </p>
          <a className="button small" href="https://zapier.com/apps/yardbook/integrations" target="_blank" rel="noopener">Open Yardbook on Zapier</a>
        </section>
      </div>
      <SpreadsheetImport companyId={companyId} onDone={() => setTick((n) => n + 1)} />
      <ApiKeys companyId={companyId} />
      <History companyId={companyId} tick={tick} />
    </div>
  );
}

function SpreadsheetImport({ companyId, onDone }: { companyId: string; onDone: () => void }) {
  const [file, setFile] = useState("");
  const [rows, setRows] = useState<string[][]>([]);
  const [map, setMap] = useState<ColumnMap>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  function load(name: string, text: string) {
    const r = parseCsv(text);
    setFile(name);
    setRows(r);
    setMap(guessMap(r[0] ?? []));
    setMsg(r.length < 2 ? { ok: false, text: "That file has no rows under the header." } : null);
  }
  async function pickFile(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    if (f.size > 5_000_000) return setMsg({ ok: false, text: "That file is over 5 MB. Export a shorter date range." });
    load(f.name, await f.text());
    e.target.value = "";
  }

  const head = rows[0] ?? [];
  const results = rows.length > 1 ? readRows(rows, map) : [];
  const good = results.filter((r) => r.ok);
  const bad = results.filter((r): r is Extract<typeof r, { ok: false }> => !r.ok);
  const missing = missingFields(map);

  async function go() {
    setBusy(true);
    const jobs = good.map((r) => (r as Extract<typeof r, { ok: true }>).job);
    let added = 0;
    let skipped = bad.length;
    for (let i = 0; i < jobs.length; i += 1000) {
      const { data, error } = await supabase!.rpc("import_jobs", { p_company: companyId, p_file_name: file, p_jobs: jobs.slice(i, i + 1000) });
      if (error) {
        setBusy(false);
        return setMsg({ ok: false, text: `Stopped after ${added} jobs: ${error.message}` });
      }
      const r = data as { added: number; updated: number; skipped: number };
      added += r.added + r.updated;
      skipped += r.skipped;
    }
    setBusy(false);
    setMsg({ ok: true, text: `Imported ${added} job${added === 1 ? "" : "s"}${skipped ? `, skipped ${skipped}` : ""}. Past jobs count as done; future ones go on the crew's route.` });
    setRows([]);
    onDone();
  }

  return (
    <section className="card stack">
      <h2>Import from a spreadsheet</h2>
      <p className="muted">
        Export completed visits as a CSV file: in Jobber, Insights → Reports → Visits, set Completed to Yes, then Export to CSV (Jobber emails it to you). Yardbook, QuickBooks and Excel exports work too. It needs a date, customer, address and price for each job.
        The same customer or address is matched to what's already here.
      </p>
      <div className="row wrap">
        <label className="button small primary">
          Choose a CSV file
          <input type="file" accept=".csv,text/csv" className="sr" onChange={(e) => void pickFile(e)} />
        </label>
        <button className="small" onClick={() => load("sample.csv", SAMPLE)}>Try a sample</button>
      </div>
      {rows.length > 1 && (
        <>
          <h3>Which column is which</h3>
          <div className="map-grid">
            {IMPORT_FIELDS.map((f: ImportField) => (
              <label key={f}>
                {FIELD_LABEL[f]}
                {missing.includes(f) && <span className="bad-text"> (needed)</span>}
                <select value={map[f] ?? -1} onChange={(e) => setMap({ ...map, [f]: Number(e.target.value) })}>
                  <option value={-1}>Not in this file</option>
                  {head.map((h, i) => <option key={i} value={i}>{h}</option>)}
                </select>
              </label>
            ))}
          </div>
          <h3>First rows</h3>
          <div className="table-wrap">
            <table className="fin">
              <thead><tr><th>Date</th><th>Customer</th><th>Address</th><th className="n">Price</th><th>Crew</th></tr></thead>
              <tbody>
                {results.slice(0, 5).map((r, i) =>
                  r.ok ? (
                    <tr key={i}><td>{r.job.date}</td><td>{r.job.customer}</td><td>{r.job.address}</td><td className="n">${(r.job.priceCents / 100).toFixed(2)}</td><td>{r.job.crew ?? "–"}</td></tr>
                  ) : (
                    <tr key={i} className="loss"><td colSpan={5}>Row {r.row}: {r.reason}</td></tr>
                  ),
                )}
              </tbody>
            </table>
          </div>
          {bad.length > 0 && (
            <p className="warn-text small-text">
              {bad.length} row{bad.length === 1 ? "" : "s"} will be skipped: {bad.slice(0, 3).map((b) => `row ${b.row} (${b.reason})`).join(", ")}{bad.length > 3 ? "…" : ""}
            </p>
          )}
          <button className="primary" disabled={busy || missing.length > 0 || !good.length} onClick={() => void go()}>
            {busy ? "Importing…" : `Import ${good.length} job${good.length === 1 ? "" : "s"}`}
          </button>
        </>
      )}
      {msg && <p className={msg.ok ? "ok" : "error"} role="status">{msg.text}</p>}
    </section>
  );
}

function ApiKeys({ companyId }: { companyId: string }) {
  const [keys, setKeys] = useState<Key[]>([]);
  const [fresh, setFresh] = useState<string | null>(null);
  const [name, setName] = useState("Zapier");
  const [msg, setMsg] = useState("");
  const load = () =>
    supabase!.from("api_keys").select("id, name, prefix, created_at, last_used_at, revoked_at").eq("company_id", companyId).order("created_at", { ascending: false }).then(({ data }) => setKeys((data as Key[]) ?? []));
  useEffect(() => void load(), [companyId]);

  async function make() {
    const { data, error } = await supabase!.rpc("create_api_key", { p_company: companyId, p_name: name || "Zapier" });
    if (error) return setMsg(error.message);
    setFresh(data as string);
    setMsg("");
    void load();
  }
  async function revoke(id: string) {
    await supabase!.from("api_keys").update({ revoked_at: new Date().toISOString() }).eq("id", id);
    void load();
  }

  return (
    <section className="card stack">
      <h2>Zapier and other software</h2>
      <p className="muted">
        Make a key, then have Zapier (or any software) send each finished job to this address with the key. Field names don't need to match exactly: “Customer Name”,
        “Completed Date” and “Total” all work. The same job number sent twice updates the job.
      </p>
      <code className="code-line">POST {INGEST_URL}</code>
      <div className="row">
        <input value={name} onChange={(e) => setName(e.target.value)} aria-label="Key name" placeholder="What it's for, e.g. Zapier – Yardbook" />
        <button className="small primary" onClick={() => void make()}>Make a key</button>
      </div>
      {fresh && (
        <div className="notice">
          <p><b>Copy this key now.</b> It won't be shown again. In Zapier, add a header <code>Authorization</code> with the value <code>Bearer {fresh}</code>.</p>
          <div className="row">
            <code className="code-line">{fresh}</code>
            <button className="small" onClick={() => void navigator.clipboard?.writeText(fresh)}>Copy</button>
          </div>
        </div>
      )}
      {msg && <p className="error">{msg}</p>}
      {keys.length > 0 && (
        <ul className="rows">
          {keys.map((k) => (
            <li key={k.id} className="team-row">
              <span>
                <b>{k.name}</b> <span className="muted small-text">{k.prefix}… · made {when(k.created_at)} · last used {when(k.last_used_at)}</span>
              </span>
              {k.revoked_at ? <span className="muted">Turned off</span> : <button className="small danger" onClick={() => void revoke(k.id)}>Turn off</button>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function History({ companyId, tick }: { companyId: string; tick: number }) {
  const [rows, setRows] = useState<Imp[]>([]);
  useEffect(() => {
    supabase!.from("imports").select("id, source, file_name, rows_in, rows_added, rows_skipped, created_at").eq("company_id", companyId).order("created_at", { ascending: false }).limit(20).then(({ data }) => setRows((data as Imp[]) ?? []));
  }, [companyId, tick]);
  if (!rows.length) return null;
  return (
    <section className="card stack">
      <h2>What came in</h2>
      <ul className="rows">
        {rows.map((r) => (
          <li key={r.id} className="team-row">
            <span><b>{r.file_name ?? r.source}</b> <span className="muted small-text">· {r.source} · {when(r.created_at)}</span></span>
            <span>{r.rows_added} in{r.rows_skipped ? `, ${r.rows_skipped} skipped` : ""}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
