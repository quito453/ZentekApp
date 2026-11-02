// admin-users: the app owner's tools. Only platform admins can call it.
//
// Actions (POST JSON):
//   { action: "create_company", name, region, timezone?, seat_limit }
//   { action: "set_seats", company_id, seat_limit }
//   { action: "create_user", company_id, role, full_name, username, password, crew_id?, email? }
//       technicians sign in with username + password; owners/dispatchers may also get a real email
//   { action: "deactivate_user", user_id }   blocks sign-in and frees the licence
//
// Secrets: SUPABASE_SERVICE_ROLE_KEY (provided by Supabase), LOGIN_EMAIL_DOMAIN, ALLOWED_ORIGINS.
import { isValidUsername, loginEmail, normalizeUsername, passwordProblem, ROLES, type Role } from "../_shared/accounts.ts";
import { adminClient, callerClient, corsHeaders, json } from "../_shared/http.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req) });
  if (req.method !== "POST") return json(req, 405, { error: "method_not_allowed" });

  const caller = callerClient(req);
  const { data: isAdmin, error: adminErr } = await caller.rpc("is_platform_admin");
  if (adminErr || isAdmin !== true) return json(req, 403, { error: "app_owner_only" });

  const body = await req.json().catch(() => null);
  if (!body || typeof body.action !== "string") return json(req, 400, { error: "bad_request" });
  const admin = adminClient();

  switch (body.action) {
    case "create_company": {
      const seats = Number(body.seat_limit);
      if (!body.name || !body.region || !Number.isInteger(seats) || seats < 0) return json(req, 400, { error: "bad_request" });
      const { data, error } = await admin
        .from("companies")
        .insert({ name: String(body.name), region: String(body.region), timezone: body.timezone ?? "America/Toronto", seat_limit: seats })
        .select("id")
        .single();
      return error ? json(req, 400, { error: error.message }) : json(req, 200, { company_id: data.id });
    }

    case "set_seats": {
      const seats = Number(body.seat_limit);
      if (!body.company_id || !Number.isInteger(seats) || seats < 0) return json(req, 400, { error: "bad_request" });
      const { error } = await admin.from("companies").update({ seat_limit: seats }).eq("id", body.company_id);
      return error ? json(req, 400, { error: error.message }) : json(req, 200, { ok: true });
    }

    case "create_user": {
      const role = body.role as Role;
      const username = normalizeUsername(String(body.username ?? ""));
      const password = String(body.password ?? "");
      if (!ROLES.includes(role)) return json(req, 400, { error: "bad_role" });
      if (!isValidUsername(username)) return json(req, 400, { error: "bad_username" });
      const pwProblem = passwordProblem(password);
      if (pwProblem) return json(req, 400, { error: `password_${pwProblem}` });
      if (role === "crew" && !body.crew_id) return json(req, 400, { error: "crew_required" });
      if (!body.company_id || !body.full_name) return json(req, 400, { error: "bad_request" });

      const email = role !== "crew" && body.email ? String(body.email).trim().toLowerCase() : loginEmail(username, Deno.env.get("LOGIN_EMAIL_DOMAIN") ?? "");
      const created = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { username } });
      if (created.error || !created.data.user) return json(req, 400, { error: created.error?.message ?? "create_failed" });
      const userId = created.data.user.id;

      // The licence check runs in the database when the membership is added. If anything fails,
      // remove the new login again so no half-made account is left behind.
      const m = await admin.from("memberships").insert({ user_id: userId, company_id: body.company_id, role, crew_id: role === "crew" ? body.crew_id : null });
      const p = m.error ? m : await admin.from("profiles").insert({ user_id: userId, company_id: body.company_id, username, full_name: String(body.full_name) });
      if (m.error || p.error) {
        await admin.auth.admin.deleteUser(userId);
        const msg = (m.error ?? p.error)!.message;
        return json(req, 400, { error: msg.includes("licence limit") ? "licence_limit" : msg.includes("duplicate") ? "username_taken" : msg });
      }
      return json(req, 200, { user_id: userId, username });
    }

    case "deactivate_user": {
      if (!body.user_id) return json(req, 400, { error: "bad_request" });
      const ban = await admin.auth.admin.updateUserById(body.user_id, { ban_duration: "876000h" });
      if (ban.error) return json(req, 400, { error: ban.error.message });
      await admin.from("profiles").update({ active: false }).eq("user_id", body.user_id);
      await admin.from("memberships").delete().eq("user_id", body.user_id); // frees the licence
      return json(req, 200, { ok: true });
    }

    default:
      return json(req, 400, { error: "unknown_action" });
  }
});
