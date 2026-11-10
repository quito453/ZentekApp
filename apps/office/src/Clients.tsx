// Customers and their properties. Addresses are picked on Google Maps so every property lands on the
// map in the right place for routes, GPS arrival and drive time.
import { useEffect, useState, type FormEvent } from "react";
import { supabase } from "./supabase";
import { AddressInput, type PickedAddress } from "./maps/AddressInput";

type Prop = { id: string; address: string; lat: number | null; lng: number | null; area: string | null };
type Cust = { id: string; full_name: string; phone: string | null; email: string | null; language: string; properties: Prop[] };

export function Clients({ companyId, region }: { companyId: string; region?: string }) {
  const [list, setList] = useState<Cust[]>([]);
  const [q, setQ] = useState("");
  const [addr, setAddr] = useState<PickedAddress | null>(null);
  const [addTo, setAddTo] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    supabase!
      .from("customers")
      .select("id, full_name, phone, email, language, properties(id, address, lat, lng, area)")
      .eq("company_id", companyId)
      .order("full_name")
      .then(({ data }) => setList((data as Cust[]) ?? []));
  }, [companyId, tick]);

  async function add(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!addr) return setMsg({ ok: false, text: "Pick the address from the list first." });
    const form = e.currentTarget;
    const f = new FormData(form);
    const c = await supabase!
      .from("customers")
      .insert({ company_id: companyId, full_name: String(f.get("name")).trim(), phone: String(f.get("phone") || "").trim() || null, email: String(f.get("email") || "").trim() || null, language: String(f.get("lang")) })
      .select("id")
      .single<{ id: string }>();
    if (c.error) return setMsg({ ok: false, text: c.error.message });
    const p = await supabase!.from("properties").insert({ company_id: companyId, customer_id: c.data.id, address: addr.address, lat: addr.lat, lng: addr.lng, place_id: addr.placeId, area: String(f.get("area") || "").trim() || null, customer_since: new Date().toLocaleDateString("en-CA") });
    setMsg(p.error ? { ok: false, text: p.error.message } : { ok: true, text: "Customer added. Add their jobs under Jobs." });
    if (!p.error) { form.reset(); setAddr(null); setTick((n) => n + 1); }
  }
  async function addProperty(customerId: string, a: PickedAddress) {
    const { error } = await supabase!.from("properties").insert({ company_id: companyId, customer_id: customerId, address: a.address, lat: a.lat, lng: a.lng, place_id: a.placeId });
    setMsg(error ? { ok: false, text: error.message } : { ok: true, text: "Property added." });
    if (!error) { setAddTo(null); setTick((n) => n + 1); }
  }

  const shown = list.filter((c) => !q || `${c.full_name} ${c.properties.map((p) => p.address).join(" ")}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="stack">
      <section className="card stack">
        <h1>Customers</h1>
        <form className="stack" onSubmit={add}>
          <div className="inline-form">
            <label>Name<input name="name" required /></label>
            <label>Phone<input name="phone" type="tel" /></label>
            <label>Email<input name="email" type="email" /></label>
            <label>Language<select name="lang" defaultValue="en"><option value="en">English</option><option value="es">Español</option><option value="fr">Français</option></select></label>
            <label>Area (optional)<input name="area" placeholder="e.g. Maple Grove" /></label>
          </div>
          <label htmlFor="caddr">Property address</label>
          {addr ? (
            <p className="row"><b>{addr.address}</b>{addr.lat === null && <span className="warn-text small-text">not on the map</span>}<button type="button" className="small" onClick={() => setAddr(null)}>Change</button></p>
          ) : (
            <AddressInput id="caddr" onPick={setAddr} region={region} />
          )}
          <button className="primary" disabled={!addr}>Add customer</button>
        </form>
        {msg && <p className={msg.ok ? "ok" : "error"} role="status">{msg.text}</p>}
      </section>
      <section className="card stack">
        <div className="row-between wrap">
          <h2>{list.length} customer{list.length === 1 ? "" : "s"}</h2>
          <input type="search" placeholder="Search name or address" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search customers" />
        </div>
        {shown.length === 0 && <p className="muted">No customers yet. Add the first one above.</p>}
        <ul className="rows">
          {shown.map((c) => (
            <li key={c.id} className="team-row cust-row">
              <div>
                <b>{c.full_name}</b> <span className="muted small-text">{[c.phone, c.email].filter(Boolean).join(" · ")}</span>
                {c.properties.map((p) => (
                  <div key={p.id} className="small-text">
                    {p.address}{p.area ? ` · ${p.area}` : ""}{p.lat === null && <span className="warn-text"> · not on the map</span>}
                  </div>
                ))}
                {addTo === c.id && <AddressInput onPick={(a) => void addProperty(c.id, a)} region={region} placeholder="Another property's address" />}
              </div>
              <button className="small" onClick={() => setAddTo(addTo === c.id ? null : c.id)}>{addTo === c.id ? "Cancel" : "Add property"}</button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
