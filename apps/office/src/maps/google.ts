// Loads the Google Maps JavaScript API once, with the key from VITE_GOOGLE_MAPS_KEY.
// The key is a browser key: restrict it in Google Cloud to your site's address (HTTP referrers)
// and to Maps JavaScript API + Places API (New). It is set as a build secret, never committed.
export const MAPS_KEY = (import.meta.env.VITE_GOOGLE_MAPS_KEY as string | undefined) || "";
// Advanced markers need a map id. DEMO_MAP_ID works for testing; make your own in Google Cloud for production.
export const MAP_ID = (import.meta.env.VITE_GOOGLE_MAP_ID as string | undefined) || "DEMO_MAP_ID";

let loading: Promise<void> | null = null;

export function hasGoogle(): boolean {
  return !!MAPS_KEY;
}

export function loadGoogle(): Promise<void> {
  if (!MAPS_KEY) return Promise.reject(new Error("no_maps_key"));
  if (loading) return loading;
  loading = new Promise<void>((resolve, reject) => {
    const cb = `__ccMaps${Date.now()}`;
    (window as unknown as Record<string, () => void>)[cb] = () => resolve();
    const s = document.createElement("script");
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(MAPS_KEY)}&v=weekly&loading=async&callback=${cb}`;
    s.async = true;
    s.onerror = () => { loading = null; reject(new Error("maps_failed_to_load")); };
    document.head.append(s);
  });
  return loading;
}
