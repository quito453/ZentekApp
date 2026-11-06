// ingest: jobs from Zapier (Yardbook, Jobber, Google Sheets…) or any software that can send a web request.
//
//   POST /functions/v1/ingest
//   Authorization: Bearer cc_live_…   (a key the owner made in Settings → Connections)
//   Body: one job, or { "jobs": [ … ] }, with any of these fields (names are matched loosely, so
//   Zapier's "Customer Name", "Completed Date", "Total" all work):
//     date, customer, address, price, service, crew, minutes, area, job number
//
// The same job number sent twice updates the job instead of adding it again. Answers
// { added, updated, skipped, problems: [{ row, reason }] }.
//
// Deploy with --no-verify-jwt: the caller is software with an API key, not a signed-in user.
import { adminClient, json } from "../_shared/http.ts";
import { payloadToRow, readRow, type ImportedJob } from "../_shared/importJobs.ts";

const MAX = 500;

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(req, 405, { error: "method_not_allowed" });
  const auth = req.headers.get("authorization") ?? "";
  const key = (auth.toLowerCase().startsWith("bearer ") ? auth.slice(7) : req.headers.get("x-api-key") ?? "").trim();
  if (!key.startsWith("cc_live_")) return json(req, 401, { error: "api_key_required" });

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return json(req, 400, { error: "json_body_required" });
  const items: Record<string, unknown>[] = Array.isArray(body.jobs) ? body.jobs : [body];
  if (items.length > MAX) return json(req, 413, { error: `send_up_to_${MAX}_jobs` });

  const jobs: ImportedJob[] = [];
  const problems: { row: number; reason: string }[] = [];
  items.forEach((item, i) => {
    if (!item || typeof item !== "object") return problems.push({ row: i + 1, reason: "not an object" });
    const { cells, map } = payloadToRow(item);
    const r = readRow(cells, map, i + 1);
    if (r.ok) jobs.push(r.job);
    else problems.push({ row: r.row, reason: r.reason });
  });

  const source = new URL(req.url).searchParams.get("source") ?? "zapier";
  const { data, error } = await adminClient().rpc("ingest_jobs", { p_key: key, p_source: source, p_jobs: jobs });
  if (error) return json(req, error.code === "28000" ? 401 : 400, { error: error.code === "28000" ? "unknown_or_revoked_key" : error.message });
  const r = data as { added: number; updated: number; skipped: number };
  return json(req, 200, { ...r, skipped: r.skipped + problems.length, problems });
});
