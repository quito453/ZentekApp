// Distances, the arrive/leave detector for the crew tablet, and route order for the office.
// Pure functions, no network: the crew app feeds GPS fixes in, the office app feeds stops in.

export interface LatLng {
  lat: number;
  lng: number;
}

/** Great-circle distance in kilometres (the same formula as app.km_between in the database). */
export function kmBetween(a: LatLng, b: LatLng): number {
  const r = 6371;
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * r * Math.asin(Math.min(1, Math.sqrt(h)));
}

// ───────────────────────────── arrive / leave (geofence) ─────────────────────────────
export interface Fix extends LatLng {
  at: number; // ms since epoch
  accuracyM?: number;
}
export interface Stop extends LatLng {
  id: string;
}
export type GeofenceEvent = { kind: "arrived" | "departed"; stopId: string; at: number };

export interface GeofenceOptions {
  /** Inside this many metres of the property counts as there. */
  radiusM?: number;
  /** Must be outside this many metres to count as gone (a bit bigger, so a fix at the edge doesn't flicker). */
  exitM?: number;
  /** Must stay inside this long before "arrived" (driving past isn't a visit). */
  dwellMs?: number;
  /** Must stay outside this long before "departed". */
  leaveMs?: number;
  /** Fixes worse than this are ignored. */
  maxAccuracyM?: number;
}

/**
 * Turns a stream of GPS fixes into "arrived at X" and "left X" events. Feed fixes in time order.
 * Arrival time is the first fix inside (not when the dwell finished), so time on site is right.
 * Departure time is the last fix inside before leaving.
 */
export class GeofenceDetector {
  private readonly o: Required<GeofenceOptions>;
  private candidate: { stopId: string; since: number } | null = null;
  private current: { stopId: string; lastInside: number; outsideSince: number | null } | null = null;
  private done = new Set<string>();

  constructor(
    private stops: Stop[],
    opts: GeofenceOptions = {},
  ) {
    this.o = { radiusM: 60, exitM: 90, dwellMs: 2 * 60_000, leaveMs: 2 * 60_000, maxAccuracyM: 50, ...opts };
  }

  /** Replace the day's stops (e.g. the office moved one). Keeps what has already happened. */
  setStops(stops: Stop[]) {
    this.stops = stops;
  }

  /** The stop the crew is at right now, if any. */
  get at(): string | null {
    return this.current?.stopId ?? null;
  }

  /** Mark a stop as already visited (e.g. the crew tapped Arrived by hand). */
  markVisited(stopId: string) {
    this.done.add(stopId);
  }

  feed(fix: Fix): GeofenceEvent[] {
    if (fix.accuracyM !== undefined && fix.accuracyM > this.o.maxAccuracyM) return [];
    const events: GeofenceEvent[] = [];
    const metres = (s: LatLng) => kmBetween(fix, s) * 1000;

    if (this.current) {
      const stop = this.stops.find((s) => s.id === this.current!.stopId);
      const d = stop ? metres(stop) : Infinity;
      if (d <= this.o.exitM) {
        this.current.lastInside = fix.at;
        this.current.outsideSince = null;
        return events;
      }
      this.current.outsideSince ??= fix.at;
      if (fix.at - this.current.outsideSince < this.o.leaveMs) return events;
      events.push({ kind: "departed", stopId: this.current.stopId, at: this.current.lastInside });
      this.done.add(this.current.stopId);
      this.current = null;
    }

    let near: Stop | null = null;
    let best = Infinity;
    for (const s of this.stops) {
      if (this.done.has(s.id)) continue;
      const d = metres(s);
      if (d <= this.o.radiusM && d < best) {
        near = s;
        best = d;
      }
    }
    if (!near) {
      this.candidate = null;
      return events;
    }
    if (this.candidate?.stopId !== near.id) this.candidate = { stopId: near.id, since: fix.at };
    if (fix.at - this.candidate.since >= this.o.dwellMs) {
      events.push({ kind: "arrived", stopId: near.id, at: this.candidate.since });
      this.current = { stopId: near.id, lastInside: fix.at, outsideSince: null };
      this.candidate = null;
    }
    return events;
  }
}

// ───────────────────────────── route order ─────────────────────────────
/** Straight-line km along a route, starting (and optionally ending) at the yard. */
export function routeKm(stops: LatLng[], start?: LatLng | null, returnToStart = false): number {
  const pts = [...(start ? [start] : []), ...stops, ...(start && returnToStart ? [start] : [])];
  let km = 0;
  for (let i = 1; i < pts.length; i++) km += kmBetween(pts[i - 1]!, pts[i]!);
  return km;
}

/** Roads wind; straight-line km × this is a fair guess at road km for a town. */
export const ROAD_FACTOR = 1.3;

/**
 * A short driving order: nearest stop first, then 2-opt swaps until nothing shortens it.
 * Returns the stops in the new order. Good to within a few percent of the best for a day's route.
 */
export function shortestOrder<T extends LatLng>(stops: T[], start?: LatLng | null): T[] {
  if (stops.length < 3 && !start) return [...stops];
  const left = [...stops];
  const order: T[] = [];
  let here: LatLng | undefined = start ?? undefined;
  if (!here) {
    order.push(left.shift()!);
    here = order[0];
  }
  while (left.length) {
    let bi = 0;
    let bd = Infinity;
    left.forEach((s, i) => {
      const d = kmBetween(here!, s);
      if (d < bd) {
        bd = d;
        bi = i;
      }
    });
    here = left.splice(bi, 1)[0]!;
    order.push(here as T);
  }
  const len = (o: T[]) => routeKm(o, start);
  let improved = true;
  let best = len(order);
  while (improved) {
    improved = false;
    for (let i = start ? 0 : 1; i < order.length - 1; i++) {
      for (let k = i + 1; k < order.length; k++) {
        const next = [...order.slice(0, i), ...order.slice(i, k + 1).reverse(), ...order.slice(k + 1)];
        const l = len(next);
        if (l < best - 1e-9) {
          order.splice(0, order.length, ...next);
          best = l;
          improved = true;
        }
      }
    }
  }
  return order;
}

/** A short code for a crew's regular day, e.g. "C2-THU". */
export function routeCode(crewName: string, weekday: number): string {
  const days = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];
  const n = crewName.match(/\d+/)?.[0];
  const c = n ? `C${n}` : crewName.replace(/[^A-Za-z]/g, "").slice(0, 3).toUpperCase() || "CR";
  return `${c}-${days[weekday] ?? "?"}`;
}
