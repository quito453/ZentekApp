// Location on the crew tablet. Crews must keep location on while clocked in: it's how drive time,
// kilometres and time at each property get recorded without anyone tapping anything, and how the
// dispatcher sees where each truck is.
//
// On the Android app this uses a background-location plugin with a foreground service: Android shows
// a small "Cutting Cost is recording your route" notification and keeps recording with the screen off
// or another app open. In a browser (testing, or the web version) it falls back to the browser's
// geolocation, which only records while the page is open.
import { Capacitor, registerPlugin } from "@capacitor/core";
import type { BackgroundGeolocationPlugin } from "@capacitor-community/background-geolocation";
import type { Fix } from "@zentek/shared";

export type LocState = "granted" | "prompt" | "denied" | "unsupported";
export type CrewFix = Fix & { speedMps: number | null; headingDeg: number | null };

const native = Capacitor.isNativePlatform();
const BG = native ? registerPlugin<BackgroundGeolocationPlugin>("BackgroundGeolocation") : null;

export async function locationState(): Promise<LocState> {
  // On the app, the plugin asks when tracking starts; we can't read the answer ahead of time.
  if (native) return (localStorage.getItem("zentek.loc") as LocState | null) ?? "prompt";
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
export async function askForLocation(): Promise<LocState> {
  if (BG) {
    // A short watcher just to trigger the permission prompt.
    const state = await new Promise<LocState>((resolve) => {
      let id = "";
      const done = (s: LocState) => { if (id) void BG.removeWatcher({ id }); resolve(s); };
      void BG.addWatcher({ requestPermissions: true, stale: true }, (pos, err) => {
        if (err?.code === "NOT_AUTHORIZED") done("denied");
        else if (pos) done("granted");
      }).then((w) => (id = w));
      setTimeout(() => done("granted"), 20_000); // allowed, but no fix yet indoors
    });
    localStorage.setItem("zentek.loc", state);
    return state;
  }
  if (!("geolocation" in navigator)) return "unsupported";
  return new Promise((resolve) =>
    navigator.geolocation.getCurrentPosition(
      () => resolve("granted"),
      (e) => resolve(e.code === e.PERMISSION_DENIED ? "denied" : "granted"), // timeout / no fix yet still means allowed
      { enableHighAccuracy: true, timeout: 15_000 },
    ),
  );
}

/** Opens the app's settings page so the crew can turn location back on (app only). */
export async function openLocationSettings(): Promise<boolean> {
  if (!BG) return false;
  await BG.openSettings();
  return true;
}

/** Follow the device while clocked in. Returns a function that stops it. */
export function watch(onFix: (f: CrewFix) => void, onDenied: () => void, notice: { title: string; message: string }): () => void {
  if (BG) {
    let id: string | null = null;
    let stopped = false;
    void BG.addWatcher(
      { backgroundTitle: notice.title, backgroundMessage: notice.message, requestPermissions: true, stale: false, distanceFilter: 10 },
      (pos, err) => {
        if (err) {
          if (err.code === "NOT_AUTHORIZED") { localStorage.setItem("zentek.loc", "denied"); onDenied(); }
          return;
        }
        if (!pos || pos.simulated) return; // ignore mock-location apps
        onFix({ lat: pos.latitude, lng: pos.longitude, at: pos.time ?? Date.now(), accuracyM: pos.accuracy, speedMps: pos.speed, headingDeg: pos.bearing });
      },
    ).then((w) => (stopped ? void BG.removeWatcher({ id: w }) : (id = w)));
    return () => { stopped = true; if (id) void BG.removeWatcher({ id }); };
  }
  if (!("geolocation" in navigator)) {
    onDenied();
    return () => {};
  }
  const wid = navigator.geolocation.watchPosition(
    (p) => onFix({ lat: p.coords.latitude, lng: p.coords.longitude, at: p.timestamp, accuracyM: p.coords.accuracy, speedMps: p.coords.speed, headingDeg: p.coords.heading }),
    (e) => e.code === e.PERMISSION_DENIED && onDenied(),
    { enableHighAccuracy: true, maximumAge: 5_000, timeout: 30_000 },
  );
  return () => navigator.geolocation.clearWatch(wid);
}
