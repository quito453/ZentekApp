import { useState, type FormEvent } from "react";
import { passwordProblem } from "@zentek/shared";
import { supabase } from "./supabase";
import { errorText } from "./lib";

/** Sets a new password through the set-password Edge Function. The database decides who may. */
export function SetPassword({ userId, name, requestId, onDone }: { userId: string; name: string; requestId?: string; onDone?: () => void }) {
  const [open, setOpen] = useState(false);
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const problem = passwordProblem(pw);
    if (problem) return setMsg({ ok: false, text: errorText(`password_${problem}`) });
    if (pw !== pw2) return setMsg({ ok: false, text: "The two passwords don't match." });
    setBusy(true);
    const { data, error } = await supabase!.functions.invoke("set-password", { body: { user_id: userId, new_password: pw, request_id: requestId } });
    setBusy(false);
    if (error || !data?.ok) {
      const code = (await (error as { context?: Response })?.context?.json?.().catch(() => null))?.error ?? "not_allowed";
      return setMsg({ ok: false, text: errorText(code) });
    }
    setPw("");
    setPw2("");
    setMsg({ ok: true, text: `New password set. Tell ${name} in person or by phone.` });
    onDone?.();
  }

  if (!open)
    return (
      <button className="small" onClick={() => setOpen(true)}>
        Set new password
      </button>
    );
  return (
    <form className="inline-form" onSubmit={submit}>
      <label>
        New password
        <input type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} required />
      </label>
      <label>
        Type it again
        <input type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} required />
      </label>
      <div className="row">
        <button className="small primary" type="submit" disabled={busy}>
          Save password
        </button>
        <button className="small" type="button" onClick={() => (setOpen(false), setMsg(null))}>
          Cancel
        </button>
      </div>
      {msg && <p className={msg.ok ? "ok" : "error"} role="status">{msg.text}</p>}
    </form>
  );
}
