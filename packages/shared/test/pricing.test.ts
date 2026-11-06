import { describe, expect, it } from "vitest";
import { needsPriceReview, profitPerHour, suggestedPrice } from "../src/pricing";

describe("customer pricing", () => {
  it("profit per hour on site", () => {
    expect(profitPerHour(3000, 45)).toBe(4000);
    expect(profitPerHour(3000, 0)).toBe(0);
  });
  it("suggests the price that earns the average per hour, rounded up to $5", () => {
    // 4 visits, $160 of costs, 45 min each, average $40/h → $40 + $30 = $70 a visit.
    expect(suggestedPrice({ visits: 4, costsCents: 16000, siteMinutes: 180, avgPerHourCents: 4000 })).toBe(7000);
    expect(suggestedPrice({ visits: 4, costsCents: 16100, siteMinutes: 180, avgPerHourCents: 4000 })).toBe(7500);
    expect(suggestedPrice({ visits: 0, costsCents: 0, siteMinutes: 0, avgPerHourCents: 4000 })).toBeNull();
  });
  it("flags customers well under the average", () => {
    expect(needsPriceReview(3000, 4000)).toBe(true);
    expect(needsPriceReview(3600, 4000)).toBe(false);
  });
});
