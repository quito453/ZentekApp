import { describe, expect, it } from "vitest";
import { etaMinutes, liveLabel, liveStatus, type LiveCrew } from "../src/live";

const NOW = Date.parse("2026-10-05T14:00:00Z");
const base: LiveCrew = { shiftId: "s", onBreak: false, seenAt: "2026-10-05T13:59:30Z", speedMps: 0, atAddress: null, atSince: null, nextAddress: "3 Birch Cres", stopsDone: 1, stopsTotal: 3 };

describe("live crew status", () => {
  it("not clocked in", () => expect(liveStatus({ ...base, shiftId: null }, NOW).kind).toBe("off"));
  it("no signal after five minutes", () => expect(liveStatus({ ...base, seenAt: "2026-10-05T13:48:00Z" }, NOW)).toEqual({ kind: "no_signal", minutes: 12 }));
  it("on a break", () => expect(liveStatus({ ...base, onBreak: true }, NOW).kind).toBe("break"));
  it("at a stop, with how long", () => expect(liveStatus({ ...base, atAddress: "2 Birch Cres", atSince: "2026-10-05T13:40:00Z" }, NOW)).toEqual({ kind: "at_stop", minutes: 20 }));
  it("driving when moving", () => expect(liveStatus({ ...base, speedMps: 11 }, NOW).kind).toBe("driving"));
  it("stopped when not moving and not at a stop", () => expect(liveStatus(base, NOW).kind).toBe("stopped"));
  it("done when every stop is", () => expect(liveStatus({ ...base, stopsDone: 3 }, NOW).kind).toBe("done"));
  it("labels read plainly", () => {
    expect(liveLabel("at_stop", 20, "2 Birch Cres")).toBe("At 2 Birch Cres for 20 min");
    expect(liveLabel("driving", 0, "3 Birch Cres")).toBe("Driving to 3 Birch Cres");
  });
});

describe("arrival estimate", () => {
  it("about 2 minutes for 1.1 km in town", () => {
    // 0.01° latitude ≈ 1.11 km × 1.3 road = 1.45 km at 35 km/h ≈ 2.5 min → 2
    expect(etaMinutes({ lat: 43.71, lng: -79.4 }, { lat: 43.72, lng: -79.4 })).toBe(2);
    expect(etaMinutes({ lat: 43.7, lng: -79.4 }, { lat: 43.7, lng: -79.4 })).toBe(1);
  });
});
