// Location on the crew tablet. Crews must keep location on while clocked in: it's how drive time,
// kilometres and time at each property get recorded without anyone tapping anything.
//
// This uses the WebView's geolocation, which Capacitor grants with the Android location permission.
// It keeps working while the app is open (the screen stays on in the truck cradle). For recording
// with the screen off, swap `watch` for a background-geolocation plugin
// (@capacitor-community/background-geolocation): the rest of the app only sees `Fix` objects.
import type { Fix } from "@zentek/shared";

export type LocState = "granted" | "prompt" | "denied" | "unsupported";

export async function locationState(): Promise<LocState> {
  if (!("geolocation" in navigator)) return "unsupported";
  try {
    const p = await navigator.permissions?.query({ name: "geolocation" as PermissionName });
    if (p) return p.state as LocState;
  } catch {
    /* some WebViews don't support the permissions API: ask instead */
  }
  return "prompt";
}

/** Shows the system prompt (first time) and resolves with the answer. */
export function askForLocation(): Promise<LocState> {
  if (!("geolocation" in navigator)) return Promise.resolve("unsupported");
  return new Promise((resolve) =>
    navigator.geolocation.getCurrentPosition(
      () => resolve("granted"),
      (e) => resolve(e.code === e.PERMISSION_DENIED ? "denied" : "granted"), // timeout / no fix yet still means allowed
      { enableHighAccuracy: true, timeout: 15_000 },
    ),
  );
}

/** Follow the device. Returns a function that stops it. */
export function watch(onFix: (f: Fix) => void, onDenied: () => void): () => void {
  if (!("geolocation" in navigator)) {
    onDenied();
    return () => {};
  }
  const id = navigator.geolocation.watchPosition(
    (p) => onFix({ lat: p.coords.latitude, lng: p.coords.longitude, at: p.timestamp, accuracyM: p.coords.accuracy }),
    (e) => e.code === e.PERMISSION_DENIED && onDenied(),
    { enableHighAccuracy: true, maximumAge: 5_000, timeout: 30_000 },
  );
  return () => navigator.geolocation.clearWatch(id);
}
