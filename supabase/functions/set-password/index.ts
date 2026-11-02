// set-password: the office sets a new password for someone who forgot theirs.
// The database decides who may do this (public.can_reset_password): dispatchers and owners for
// their technicians, owners for their dispatchers, the app owner for anyone.
//
// POST JSON { user_id, new_password, request_id? }   request_id closes the "Forgot password" item.
import { passwordProblem } from "../_shared/accounts.ts";
import { adminClient, callerClient, callerId, corsHeaders, json } from "../_shared/http.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req) });
  if (req.method !== "POST") return json(req, 405, { error: "method_not_allowed" });

  const caller = callerClient(req);
  const me = await callerId(caller);
  if (!me) return json(req, 401, { error: "sign_in_required" });

  const body = await req.json().catch(() => null);
  const target = body?.user_id ? String(body.user_id) : "";
  const pw = String(body?.new_password ?? "");
  if (!target) return json(req, 400, { error: "bad_request" });
  const problem = passwordProblem(pw);
  if (problem) return json(req, 400, { error: `password_${problem}` });

  const { data: allowed, error } = await caller.rpc("can_reset_password", { p_target: target });
  if (error || allowed !== true) return json(req, 403, { error: "not_allowed" });

  const admin = adminClient();
  const upd = await admin.auth.admin.updateUserById(target, { password: pw });
  if (upd.error) return json(req, 400, { error: upd.error.message });

  if (body.request_id) {
    // Close the request only if it is this person's open password request.
    await admin
      .from("office_items")
      .update({ status: "closed", closed_at: new Date().toISOString() })
      .eq("id", body.request_id)
      .eq("subject_user_id", target)
      .eq("kind", "password_reset");
  }
  return json(req, 200, { ok: true });
});
