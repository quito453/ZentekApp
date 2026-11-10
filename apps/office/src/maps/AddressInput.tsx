// Address search with Google Places: type a few letters, pick the place, and we keep the address,
// its map position and Google's id for it. Without a Maps key it's a plain text box (no map position).
import { useEffect, useRef, useState } from "react";
import { hasGoogle, loadGoogle } from "./google";

export type PickedAddress = { address: string; lat: number | null; lng: number | null; placeId: string | null };

export function AddressInput({ onPick, placeholder = "Start typing an address", region, id }: { onPick: (a: PickedAddress) => void; placeholder?: string; region?: string; id?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<"google" | "plain">(hasGoogle() ? "google" : "plain");
  const [text, setText] = useState("");
  const pickRef = useRef(onPick);
  pickRef.current = onPick;

  useEffect(() => {
    if (mode !== "google" || !box.current) return;
    let el: google.maps.places.PlaceAutocompleteElement | null = null;
    let cancelled = false;
    (async () => {
      try {
        await loadGoogle();
        const { PlaceAutocompleteElement } = (await google.maps.importLibrary("places")) as google.maps.PlacesLibrary;
        if (cancelled || !box.current) return;
        el = new PlaceAutocompleteElement({ placeholder, includedRegionCodes: region ? [region.toLowerCase()] : undefined });
        if (id) el.id = id;
        el.addEventListener("gmp-select", async (ev: Event) => {
          const { placePrediction } = ev as google.maps.places.PlacePredictionSelectEvent;
          const place = placePrediction.toPlace();
          await place.fetchFields({ fields: ["formattedAddress", "location", "id"] });
          pickRef.current({ address: place.formattedAddress ?? "", lat: place.location?.lat() ?? null, lng: place.location?.lng() ?? null, placeId: place.id ?? null });
        });
        box.current.replaceChildren(el);
      } catch {
        if (!cancelled) setMode("plain");
      }
    })();
    return () => { cancelled = true; el?.remove(); };
  }, [mode, placeholder, region, id]);

  if (mode === "google") return <div ref={box} className="addr-google" />;
  return (
    <div className="row">
      <input id={id} value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder} aria-label="Address" />
      <button type="button" className="small" disabled={text.trim().length < 5} onClick={() => { pickRef.current({ address: text.trim(), lat: null, lng: null, placeId: null }); setText(""); }}>Use this address</button>
    </div>
  );
}
