import { describe, expect, it } from "vitest";
import { GeofenceDetector, kmBetween, routeCode, routeKm, shortestOrder, type Fix } from "../src/geo";

// 0.001° of latitude ≈ 111 m.
const HOME = { id: "a", lat: 43.7, lng: -79.4 };
const NEXT = { id: "b", lat: 43.71, lng: -79.4 };
const min = (m: number) => Date.UTC(2026, 9, 5, 13, 0) + m * 60_000;
const at = (m: number, lat: number, lng = -79.4, accuracyM = 8): Fix => ({ at: min(m), lat, lng, accuracyM });

describe("distance", () => {
  it("matches the database's formula", () => {
    expect(kmBetween({ lat: 43.0, lng: -79.0 }, { lat: 43.1, lng: -79.0 })).toBeCloseTo(11.12, 2);
  });
});

describe("arrive and leave", () => {
  it("arrives after staying two minutes, dated from the first fix inside", () => {
    const g = new GeofenceDetector([HOME, NEXT]);
    expect(g.feed(at(0, 43.69))).toEqual([]); // 1.1 km away
    expect(g.feed(at(1, 43.7002))).toEqual([]); // 22 m away, just got there
    expect(g.feed(at(2, 43.7001))).toEqual([]);
    expect(g.feed(at(3, 43.7))).toEqual([{ kind: "arrived", stopId: "a", at: min(1) }]);
    expect(g.at).toBe("a");
  });

  it("driving past is not a visit", () => {
    const g = new GeofenceDetector([HOME]);
    g.feed(at(0, 43.7));
    expect(g.feed(at(1, 43.705))).toEqual([]);
    expect(g.at).toBeNull();
  });

  it("leaves after two minutes outside, dated from the last fix inside, then arrives at the next stop", () => {
    const g = new GeofenceDetector([HOME, NEXT]);
    [0, 1, 2].forEach((m) => g.feed(at(m, 43.7)));
    g.feed(at(30, 43.7));
    expect(g.feed(at(31, 43.703))).toEqual([]); // 330 m out, not long enough yet
    expect(g.feed(at(33, 43.705))).toEqual([{ kind: "departed", stopId: "a", at: min(30) }]);
    g.feed(at(40, 43.71));
    expect(g.feed(at(42, 43.71))).toEqual([{ kind: "arrived", stopId: "b", at: min(40) }]);
  });

  it("ignores a bad fix instead of leaving", () => {
    const g = new GeofenceDetector([HOME]);
    [0, 2].forEach((m) => g.feed(at(m, 43.7)));
    expect(g.feed(at(5, 43.75, -79.4, 400))).toEqual([]);
    expect(g.at).toBe("a");
  });

  it("does not arrive twice at a stop already done", () => {
    const g = new GeofenceDetector([HOME]);
    g.markVisited("a");
    [0, 3].forEach((m) => g.feed(at(m, 43.7)));
    expect(g.at).toBeNull();
  });
});

describe("route order", () => {
  // Four stops on a line, given out of order.
  const s = (id: string, lng: number) => ({ id, lat: 43.7, lng });
  const yard = { lat: 43.7, lng: -79.5 };
  it("visits them along the line from the yard", () => {
    const order = shortestOrder([s("d", -79.2), s("b", -79.4), s("c", -79.3), s("a", -79.45)], yard);
    expect(order.map((x) => x.id)).toEqual(["a", "b", "c", "d"]);
  });
  it("is never longer than the order given", () => {
    const stops = Array.from({ length: 12 }, (_, i) => s(String(i), -79.4 + Math.sin(i * 7) * 0.1));
    expect(routeKm(shortestOrder(stops, yard), yard)).toBeLessThanOrEqual(routeKm(stops, yard));
  });
  it("names a crew's regular day", () => {
    expect(routeCode("Crew 2", 3)).toBe("C2-THU");
    expect(routeCode("Dave", 0)).toBe("DAV-MON");
  });
});
