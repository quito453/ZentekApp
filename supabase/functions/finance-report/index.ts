// finance-report: emails the owner's weekly and monthly reports.
//
// Two ways in:
//   1. Scheduled (pg_cron, once a day): header x-cron-secret = CRON_SECRET. Sends every report that
//      is due today in each company's time zone (see supabase/cron.example.sql).
//   2. "Email me this report now" from the office app: POST { company_id, kind: "week" | "month" }
//      with the owner's login. Covers the last finished week or month.
//
// Secrets: RESEND_API_KEY, REPORT_FROM (e.g. "Zentek <reports@zentekapp.com>"), CRON_SECRET,
// OFFICE_URL (link in the email), ALLOWED_ORIGINS.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.118.0";
import { lastCompletePeriod, renderReport, reportsDue, shiftPeriod, type FinanceSummary } from "../_shared/report.ts";
import { adminClient, callerClient, callerId, corsHeaders, json } from "../_shared/http.ts";

async function sendEmail(to: string[], subject: string, html: string, text: string): Promise<string | null> {
  const key = Deno.env.get("RESEND_API_KEY");
  const from = Deno.env.get("REPORT_FROM");
  if (!key || !from) return "email_not_configured";
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to, subject, html, text }),
  });
  return r.ok ? null : `email_failed_${r.status}`;
}

async function buildAndSend(db: SupabaseClient, companyId: string, kind: "week" | "month", today: string, to: string[]) {
  const period = lastCompletePeriod(kind, today);
  const before = shiftPeriod(period, -1);
  const [company, now, prev] = await Promise.all([
    db.from("companies").select("name").eq("id", companyId).single<{ name: string }>(),
    db.rpc("finance_summary", { p_company: companyId, p_from: period.from, p_to: period.to }),
    db.rpc("finance_summary", { p_company: companyId, p_from: before.from, p_to: before.to }),
  ]);
  if (now.error) return { error: now.error.code === "42501" ? "owner_only" : now.error.message };
  const email = renderReport(now.data as FinanceSummary, {
    companyName: company.data?.name ?? "Your company",
    period,
    previous: (prev.data as FinanceSummary | null) ?? undefined,
    appUrl: Deno.env.get("OFFICE_URL") ?? undefined,
  });
  const err = to.length ? await sendEmail(to, email.subject, email.html, email.text) : "no_recipients";
  return err ? { error: err } : { sent: to.length, subject: email.subject };
}

const localToday = (tz: string) => new Date().toLocaleDateString("en-CA", { timeZone: tz });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req) });
  if (req.method !== "POST") return json(req, 405, { error: "method_not_allowed" });

  // 1. Scheduled run
  const cronSecret = Deno.env.get("CRON_SECRET");
  if (cronSecret && req.headers.get("x-cron-secret") === cronSecret) {
    const admin = adminClient();
    const { data: settings } = await admin
      .from("report_settings")
      .select("company_id, weekly, weekly_day, monthly, recipients, last_weekly_sent, last_monthly_sent, companies(timezone, active)");
    const results = [];
    for (const s of settings ?? []) {
      const co = s.companies as unknown as { timezone: string; active: boolean } | null;
      if (!co?.active || !s.recipients?.length) continue;
      const today = localToday(co.timezone);
      for (const kind of reportsDue(today, s)) {
        const r = await buildAndSend(admin, s.company_id, kind, today, s.recipients);
        if (!("error" in r)) {
          await admin.from("report_settings").update(kind === "week" ? { last_weekly_sent: today } : { last_monthly_sent: today }).eq("company_id", s.company_id);
        }
        results.push({ company_id: s.company_id, kind, ...r });
      }
    }
    return json(req, 200, { results });
  }

  // 2. Owner asks for a report now
  const caller = callerClient(req);
  const me = await callerId(caller);
  if (!me) return json(req, 401, { error: "sign_in_required" });
  const body = await req.json().catch(() => null);
  const kind = body?.kind === "week" ? "week" : "month";
  if (!body?.company_id) return json(req, 400, { error: "bad_request" });

  const { data: settings } = await caller.from("report_settings").select("recipients").eq("company_id", body.company_id).maybeSingle<{ recipients: string[] }>();
  const { data: user } = await caller.auth.getUser();
  const to = settings?.recipients?.length ? settings.recipients : user.user?.email && !user.user.email.endsWith(Deno.env.get("LOGIN_EMAIL_DOMAIN") ?? "\u0000") ? [user.user.email] : [];
  const { data: co } = await caller.from("companies").select("timezone").eq("id", body.company_id).maybeSingle<{ timezone: string }>();
  // The caller's own login runs the numbers, so the database's owner-only rule applies.
  const r = await buildAndSend(caller, body.company_id, kind, localToday(co?.timezone ?? "America/Toronto"), to);
  if ("error" in r) return json(req, r.error === "owner_only" ? 403 : 400, r);
  return json(req, 200, r);
});
