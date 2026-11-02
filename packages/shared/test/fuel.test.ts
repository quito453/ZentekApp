import { describe, expect, it } from "vitest";
import { eiaAreas, eiaUrl, readEia, readStatcan, statcanCoordinate } from "../src/fuel";

// Trimmed copies of the shapes Statistics Canada's WDS and the EIA API return.
const meta = [
  {
    status: "SUCCESS",
    object: {
      productId: "18100001",
      dimension: [
        { dimensionPositionId: 1, dimensionNameEn: "Geography", member: [
          { memberId: 1, memberNameEn: "Canada" },
          { memberId: 9, memberNameEn: "Québec, Quebec" },
          { memberId: 12, memberNameEn: "Ottawa-Gatineau, Ontario part, Ontario/Quebec" },
          { memberId: 13, memberNameEn: "Toronto, Ontario" },
        ] },
        { dimensionPositionId: 2, dimensionNameEn: "Type of fuel", member: [
          { memberId: 1, memberNameEn: "Regular unleaded gasoline at full service filling stations" },
          { memberId: 2, memberNameEn: "Regular unleaded gasoline at self service filling stations" },
          { memberId: 5, memberNameEn: "Diesel fuel at self service filling stations" },
        ] },
      ],
    },
  },
];

describe("Statistics Canada", () => {
  it("finds the city and self-serve fuel", () => {
    expect(statcanCoordinate(meta, "Toronto", "regular")).toEqual({ coordinate: "13.2.0.0.0.0.0.0.0.0", area: "Toronto" });
    expect(statcanCoordinate(meta, "Ottawa-Gatineau", "diesel")).toEqual({ coordinate: "12.5.0.0.0.0.0.0.0.0", area: "Ottawa-Gatineau" });
  });
  it("matches names with or without accents", () => {
    expect(statcanCoordinate(meta, "Quebec", "regular")?.area).toBe("Québec");
  });
  it("falls back to the Canada average when there's no city", () => {
    expect(statcanCoordinate(meta, null, "regular")?.coordinate).toBe("1.2.0.0.0.0.0.0.0.0");
    expect(statcanCoordinate(meta, "Iqaluit", "regular")?.area).toBe("Canada");
  });
  it("reads the latest month, in dollars per litre", () => {
    const data = [{ status: "SUCCESS", object: { vectorDataPoint: [
      { refPer: "2026-08-01", value: "151.2" }, { refPer: "2026-09-01", value: "146.8" }, { refPer: "2026-10-01", value: null },
    ] } }];
    expect(readStatcan(data, "Toronto", "regular")).toMatchObject({ pricePerL: 1.468, currency: "CAD", period: "2026-09-01", area: "Toronto" });
  });
  it("returns nothing for a failed call", () => {
    expect(readStatcan([{ status: "FAILED" }], "Toronto", "regular")).toBeNull();
    expect(statcanCoordinate([], "Toronto", "regular")).toBeNull();
  });
});

describe("U.S. EIA", () => {
  it("tries the state, then its region, then the U.S. average", () => {
    expect(eiaAreas("NY", "regular").map((a) => a.code)).toEqual(["SNY", "R1Y", "NUS"]);
    expect(eiaAreas("ga", "regular").map((a) => a.code)).toEqual(["R1Z", "NUS"]);
    expect(eiaAreas("OR", "regular").map((a) => a.code)).toEqual(["R5XCA", "R50", "NUS"]);
    expect(eiaAreas("TX", "diesel").map((a) => a.code)).toEqual(["R30", "NUS"]);
    expect(eiaAreas("CA", "diesel").map((a) => a.code)).toEqual(["SCA", "R50", "NUS"]);
  });
  it("asks for the latest weekly value of the right product", () => {
    const u = new URL(eiaUrl("KEY", "SNY", "diesel"));
    expect(u.pathname).toBe("/v2/petroleum/pri/gnd/data/");
    expect(u.searchParams.get("facets[product][]")).toBe("EPD2D");
    expect(u.searchParams.get("frequency")).toBe("weekly");
    expect(u.searchParams.get("length")).toBe("1");
  });
  it("converts dollars per gallon to dollars per litre", () => {
    const q = readEia({ response: { data: [{ period: "2026-10-26", value: "3.105" }] } }, "New York", "regular");
    expect(q).toMatchObject({ pricePerL: 0.82, currency: "USD", period: "2026-10-26" });
    expect(readEia({ response: { data: [] } }, "New York", "regular")).toBeNull();
  });
});
