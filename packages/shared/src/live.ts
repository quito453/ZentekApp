// What a crew is doing right now, for the dispatcher's live map. Pure: the office app passes in
// the row from live_crews() and the current time.
import { kmBetween, ROAD_FACTOR, type LatLng } from "./geo";

export type LiveKind = "off" | "break" | "at_stop" | "driving" | "stopped" | "no_signal" | "done";
export interface LiveCrew {
  shiftId: string | null;
  onBreak: boolean;
  seenAt: string | null; // last GPS point
  speedMps: number | null;
  atAddress: string | null;
  atSince: string | null;
  nextAddress: string | null;
  stopsDone: number;
  stopsTotal: number;
}

/** No point for this long while clocked in = the tablet has no signal or location is off. */
export const STALE_MS = 5 * 60_000;
/** Average town speed for arrival estimates. */
export const TOWN_KMH = 35;

export function liveStatus(c: LiveCrew, now: number): { kind: LiveKind; minutes: number } {
  const mins = (iso: string | null) => (iso ? Math.max(0, Math.round((now - Date.parse(iso)) / 60_000)) : 0);
  if (!c.shiftId) return { kind: "off", minutes: 0 };
  if (!c.seenAt || now - Date.parse(c.seenAt) > STALE_MS) return { kind: "no_signal", minutes: mins(c.seenAt) };
  if (c.onBreak) return { kind: "break", minutes: 0 };
  if (c.atAddress) return { kind: "at_stop", minutes: mins(c.atSince) };
  if (c.stopsTotal > 0 && c.stopsDone >= c.stopsTotal) return { kind: "done", minutes: 0 };
  if ((c.speedMps ?? 0) >= 2) return { kind: "driving", minutes: 0 };
  return { kind: "stopped", minutes: 0 };
}

/** Minutes to drive from here to there in town: straight line × road factor at TOWN_KMH. */
export function etaMinutes(from: LatLng, to: LatLng): number {
  return Math.max(1, Math.round((kmBetween(from, to) * ROAD_FACTOR / TOWN_KMH) * 60));
}

/** A plain label for the status. */
export function liveLabel(kind: LiveKind, minutes: number, place?: string | null): string {
  switch (kind) {
    case "off": return "Not clocked in";
    case "no_signal": return minutes ? `No signal for ${minutes} min` : "No signal yet";
    case "break": return "On a break";
    case "at_stop": return `At ${place ?? "a stop"}${minutes ? ` for ${minutes} min` : ""}`;
    case "done": return "All stops done";
    case "driving": return place ? `Driving to ${place}` : "Driving";
    case "stopped": return "Stopped between stops";
  }
}
