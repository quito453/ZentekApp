// Team: who has a login, and licences used. Owners and dispatchers can set a new password here;
// adding or removing people is done by the app owner.
import { useEffect, useState } from "react";
import { supabase } from "./supabase";
import { SetPassword } from "./SetPassword";

type Person = { user_id: string; role: string; crew: string | null; username: string; full_name: string; active: boolean };

export function Team({ companyId, myRole, myId }: { companyId: string; myRole: string; myId: string }) {
  const [people, setPeople] = useState<Person[]>([]);
  const [seats, setSeats] = useState<number | null>(null);

  useEffect(() => {
    (async () => {
      const [m, p, c] = await Promise.all([
        supabase!.from("memberships").select("user_id, role, crews(name)").eq("company_id", companyId).returns<{ user_id: string; role: string; crews: { name: string } | null }[]>(),
        supabase!.from("profiles").select("user_id, username, full_name, active").eq("company_id", companyId).returns<{ user_id: string; username: string; full_name: string; active: boolean }[]>(),
        supabase!.from("companies").select("seat_limit").eq("id", companyId).single<{ seat_limit: number }>(),
      ]);
      const byId = new Map((p.data ?? []).map((x) => [x.user_id, x]));
      setPeople(
        (m.data ?? [])
          .map((x) => ({ user_id: x.user_id, role: x.role, crew: x.crews?.name ?? null, username: byId.get(x.user_id)?.username ?? "", full_name: byId.get(x.user_id)?.full_name ?? "", active: byId.get(x.user_id)?.active ?? true }))
          .sort((a, b) => a.role.localeCompare(b.role) || a.full_name.localeCompare(b.full_name)),
      );
      setSeats(c.data?.seat_limit ?? null);
    })();
  }, [companyId]);

  const canReset = (p: Person) => p.user_id !== myId && (p.role === "crew" || (p.role === "dispatcher" && myRole === "owner"));
  // Office people first, then one heading per crew.
  const crewNames = [...new Set(people.filter((p) => p.role === "crew").map((p) => p.crew ?? "No crew"))].sort();
  const groups: [string, Person[]][] = [
    ["Office", people.filter((p) => p.role !== "crew")] as [string, Person[]],
    ...crewNames.map((c) => [c, people.filter((p) => p.role === "crew" && (p.crew ?? "No crew") === c)] as [string, Person[]]),
  ].filter(([, l]) => l.length > 0);
  const roleName = (r: string) => (r === "crew" ? "Technician" : r === "dispatcher" ? "Dispatcher" : "Owner");

  return (
    <section className="card">
      <div className="row-between">
        <h2>Team</h2>
        {seats !== null && (
          <span className="muted">
            {people.length} of {seats} licences used
          </span>
        )}
      </div>
      <p className="muted">To add someone or get more licences, contact your Cutting Cost administrator.</p>
      {groups.map(([title, list]) => (
        <div key={title}>
          <h3 className="crew-head">{title}</h3>
          <ul className="rows">
            {list.map((p) => (
              <li key={p.user_id} className="team-row">
                <div>
                  <b>{p.full_name || p.username}</b>
                  <div className="muted">
                    {roleName(p.role)} · <code>{p.username}</code>
                  </div>
                </div>
                {canReset(p) && <SetPassword userId={p.user_id} name={p.full_name || p.username} />}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}
