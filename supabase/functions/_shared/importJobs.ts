// Bringing jobs in from other software: a spreadsheet export (Jobber, Yardbook, QuickBooks, Excel)
// or one job at a time from Zapier. Used by the office app (preview and column matching) and by the
// import-jobs and ingest Edge Functions (the real insert), so both read rows the same way.
// Plain TypeScript with no imports, re-exported by @zentek/shared.

export type ImportField = "date" | "customer" | "address" | "service" | "price" | "crew" | "minutes" | "area" | "id";
export const IMPORT_FIELDS: ImportField[] = ["date", "customer", "address", "service", "price", "crew", "minutes", "area", "id"];
export const REQUIRED_FIELDS: ImportField[] = ["date", "customer", "address", "price"];
export const FIELD_LABEL: Record<ImportField, string> = {
  date: "Date",
  customer: "Customer",
  address: "Address",
  service: "Service",
  price: "Price",
  crew: "Crew",
  minutes: "Minutes on site",
  area: "Area",
  id: "Job number",
};

/** Reads CSV text (quotes, commas and line breaks inside quotes, Windows line ends, a BOM). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let q = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (q) {
      if (ch === '"' && s[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") {
      row.push(cur);
      cur = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && s[i + 1] === "\n") i++;
      row.push(cur);
      cur = "";
      if (row.some((x) => x.trim())) rows.push(row);
      row = [];
    } else cur += ch;
  }
  row.push(cur);
  if (row.some((x) => x.trim())) rows.push(row);
  return rows;
}

export type ColumnMap = Partial<Record<ImportField, number>>;

const GUESS: [ImportField, RegExp][] = [
  ["id", /^(job|visit|invoice)\s*(#|no\.?|number|id)$|^id$/],
  ["date", /date|day|completed|scheduled/],
  ["customer", /client|customer|name/],
  ["address", /address|property|location|street/],
  ["service", /job title|visit title|title|line item|item|description|service/],
  // Jobber's visits report calls its prices "Visit based ($)" and "One-off job ($)".
  ["price", /total|price|amount|revenue|charge|visit based|one-off|\(\$\)/],
  ["crew", /crew|team|assigned|employee|visit.*by/],
  // Time actually worked beats time scheduled ("Time tracked" before "Scheduled duration").
  ["minutes", /time tracked|time on site|minutes|actual|duration|hours/],
  ["area", /area|zone|neighbou?rhood|route/],
];

/** Guess which column is which from the header row. Each column is used once. */
export function guessMap(header: string[]): ColumnMap {
  const map: ColumnMap = {};
  const used = new Set<number>();
  for (const [field, re] of GUESS) {
    // Earlier words in the pattern win: try them one at a time across all columns.
    const words = /\(.*\|/.test(re.source) ? [re.source] : re.source.split("|");
    let i = -1;
    for (const w of words) {
      const one = new RegExp(w);
      i = header.findIndex((h, idx) => !used.has(idx) && one.test(h.trim().toLowerCase()));
      if (i >= 0) break;
    }
    if (i >= 0) {
      map[field] = i;
      used.add(i);
    }
  }
  return map;
}

export interface ImportedJob {
  date: string; // YYYY-MM-DD
  customer: string;
  address: string;
  service: string | null;
  priceCents: number;
  crew: string | null;
  minutes: number | null;
  area: string | null;
  externalId: string | null;
}
export type RowResult = { ok: true; job: ImportedJob } | { ok: false; row: number; reason: string };

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** 2026-10-26, 2026/10/26, Oct 26 2026, 26 Oct 2026, 10/26/2026 (US) or 26/10/2026 (when the day is over 12). */
export function readDate(v: string): string | null {
  const s = v.trim();
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  const out = (y: number, mo: number, d: number) => {
    const dt = new Date(Date.UTC(y, mo - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d ? dt.toISOString().slice(0, 10) : null;
  };
  if (m) return out(+m[1]!, +m[2]!, +m[3]!);
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/);
  if (m) {
    const a = +m[1]!;
    const b = +m[2]!;
    return a > 12 ? out(+m[3]!, b, a) : out(+m[3]!, a, b);
  }
  m = s.match(/^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/);
  if (m) return out(+m[3]!, MONTHS.indexOf(m[1]!.toLowerCase()) + 1, +m[2]!);
  m = s.match(/^(\d{1,2})\s+([A-Za-z]{3})[a-z]*\.?,?\s+(\d{4})/);
  if (m) return out(+m[3]!, MONTHS.indexOf(m[2]!.toLowerCase()) + 1, +m[1]!);
  return null;
}

/** "$1,250.00", "1250", "(55.00)" → cents. Negative or unreadable → null. */
export function readMoney(v: string): number | null {
  const s = v.replace(/[$€£\s]|CAD|USD/gi, "").replace(/,(?=\d{3}\b)/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  return Math.round(parseFloat(s) * 100);
}

/** One spreadsheet row (or one Zapier payload turned into a row) → a job, or why it was skipped. */
export function readRow(cells: string[], map: ColumnMap, rowNumber: number): RowResult {
  const get = (f: ImportField) => (map[f] === undefined || map[f]! < 0 ? "" : (cells[map[f]!] ?? "").trim());
  const fail = (reason: string): RowResult => ({ ok: false, row: rowNumber, reason });
  const date = readDate(get("date"));
  if (!date) return fail(get("date") ? `date "${get("date")}" not understood` : "no date");
  if (!get("customer")) return fail("no customer");
  if (!get("address")) return fail("no address");
  const price = readMoney(get("price"));
  if (price === null) return fail(get("price") ? `price "${get("price")}" not understood` : "no price");
  const rawMins = get("minutes");
  const hm = rawMins.match(/^(\d+):(\d{2})/); // "1:30" = an hour and a half
  const mins = hm ? Number(hm[1]) * 60 + Number(hm[2]) : rawMins ? Number(rawMins.replace(/[^\d.]/g, "")) : NaN;
  return {
    ok: true,
    job: {
      date,
      customer: get("customer").slice(0, 120),
      address: get("address").slice(0, 200),
      service: get("service").slice(0, 120) || null,
      priceCents: price,
      crew: get("crew").slice(0, 60) || null,
      // Under 12 is almost certainly hours ("1.5"), not minutes.
      minutes: Number.isFinite(mins) && mins > 0 ? Math.round(!hm && mins < 12 ? mins * 60 : mins) : null,
      area: get("area").slice(0, 60) || null,
      externalId: get("id").slice(0, 80) || null,
    },
  };
}

/** All rows after the header. */
export function readRows(rows: string[][], map: ColumnMap): RowResult[] {
  return rows.slice(1).map((r, i) => readRow(r, map, i + 2));
}

/** What's missing before the import can run. */
export function missingFields(map: ColumnMap): ImportField[] {
  return REQUIRED_FIELDS.filter((f) => map[f] === undefined || map[f]! < 0);
}

/** A Zapier (or other) payload, keyed by any of our field names or common synonyms, as a row. */
export function payloadToRow(p: Record<string, unknown>): { cells: string[]; map: ColumnMap } {
  const keys = Object.keys(p);
  const cells = keys.map((k) => (p[k] === null || p[k] === undefined ? "" : String(p[k])));
  return { cells, map: guessMap(keys) };
}
