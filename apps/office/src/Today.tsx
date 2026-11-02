// Today, live: jobs and "Needs you" items update within a second of a change anywhere
// (a technician's tablet, another dispatcher, the server) through Supabase Realtime.
import { useEffect, useMemo, useState } from "react";
import { t, type Lang } from "@zentek/shared";
import { supabase } from "./supabase";
import { debounce, timeAgo } from "./lib";
import { SetPassword } from "./SetPassword";

type VisitRow = { id: string; status: string; route_order: number | null; properties: { address: string } | null; crews: { name: string } | null };
type Item = { id: string; kind: string; title: string; body: string | null; created_at: string; subject_user_id: string | null };

export function Today({ lang, companyId, companyName }: { lang: Lang; companyId: string; companyName: string }) {
  const [visits, setVisits] = useState<VisitRow[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [live, setLive] = useState(false);
  const [error, setError] = useState("");

  const load = useMemo(
    () => async () => {
      const day = new Date().toLocaleDateString("en-CA");
      const [v, i] = await Promise.all([
        supabase!
          .from("visits")
          .select("id, status, route_order, properties(address), crews(name)")
          .eq("company_id", companyId)
          .eq("scheduled_on", day)
          .order("route_order", { ascending: true, nullsFirst: false })
          .returns<VisitRow[]>(),
        supabase!
          .from("office_items")
          .select("id, kind, title, body, created_at, subject_user_id")
          .eq("company_id", companyId)
          .eq("status", "open")
          .order("created_at", { ascending: false })
          .returns<Item[]>(),
      ]);
      if (v.error || i.error) return setError((v.error ?? i.error)!.message);
      setError("");
      setVisits(v.data ?? []);
      setItems(i.data ?? []);
    },
    [companyId],
  );

  useEffect(() => {
    void load();
    const reload = debounce(() => void load(), 250);
    const channel = supabase!
      .channel(`office-${companyId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "visits", filter: `company_id=eq.${companyId}` }, reload)
      .on("postgres_changes", { event: "*", schema: "public", table: "office_items", filter: `company_id=eq.${companyId}` }, reload)
      .on("postgres_changes", { event: "*", schema: "public", table: "shifts", filter: `company_id=eq.${companyId}` }, reload)
      .subscribe((status) => setLive(status === "SUBSCRIBED"));
    // Catch up after the laptop sleeps or the connection drops.
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      void supabase!.removeChannel(channel);
    };
  }, [companyId, load]);

  async function close(id: string) {
    await supabase!.from("office_items").update({ status: "closed", closed_at: new Date().toISOString() }).eq("id", id);
  }

  const done = visits.filter((v) => v.status === "done").length;
  return (
    <div className="grid2">
      <section className="stack">
        <div className="card row-between">
          <div>
            <h1>{companyName}</h1>
            <p className="headline">{t(lang, "hlJobs", { d: done, n: visits.length })}</p>
          </div>
          <span className={`live ${live ? "on" : ""}`} title={live ? "Updates arrive as they happen" : "Reconnecting"}>
            {live ? "Live" : "Reconnecting…"}
          </span>
        </div>
        <div className="card">
          <h2>
            {t(lang, "needsYou")} <small className="muted">{items.length}</small>
          </h2>
          {items.length === 0 && <p className="muted">{t(lang, "allClear")}</p>}
          <ul className="items">
            {items.map((i) => (
              <li key={i.id} className={i.kind}>
                <div className="row-between">
                  <b>{i.title}</b>
                  <small className="muted">{timeAgo(i.created_at)}</small>
                </div>
                {i.kind === "password_reset" && i.subject_user_id ? (
                  <>
                    <p className="muted">Forgot their password. Set a new one, then tell them in person or by phone.</p>
                    <SetPassword userId={i.subject_user_id} name={i.title.replace("Password reset: ", "")} requestId={i.id} />
                  </>
                ) : (
                  <>
                    {i.body && <p>{i.body}</p>}
                    <button className="small" onClick={() => void close(i.id)}>
                      {t(lang, "close")}
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
        </div>
      </section>
      <section className="card">
        <h2>{t(lang, "tabToday")}</h2>
        {error && <p className="error">{error}</p>}
        {visits.length === 0 ? (
          <p className="muted">No jobs today.</p>
        ) : (
          <ul className="rows">
            {visits.map((v) => (
              <li key={v.id}>
                <b>{v.properties?.address}</b>
                <span>{v.crews?.name ?? t(lang, "notAssigned")}</span>
                <span className={`chip ${v.status}`}>{v.status.replace("_", " ")}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
