import { describe, expect, it } from "vitest";
import { change, lastCompletePeriod, periodContaining, periodLabel, renderReport, reportsDue, shiftPeriod, type FinanceSummary } from "../src/report";

describe("periods", () => {
  it("weeks run Monday to Sunday", () => {
    expect(periodContaining("week", "2026-11-04")).toEqual({ kind: "week", from: "2026-11-02", to: "2026-11-08" });
    expect(periodContaining("week", "2026-11-08")).toEqual({ kind: "week", from: "2026-11-02", to: "2026-11-08" });
  });
  it("months handle their real length", () => {
    expect(periodContaining("month", "2026-02-14")).toMatchObject({ from: "2026-02-01", to: "2026-02-28" });
    expect(periodContaining("month", "2028-02-14")).toMatchObject({ to: "2028-02-29" });
  });
  it("moves back and forward", () => {
    expect(shiftPeriod(periodContaining("month", "2026-01-10"), -1)).toMatchObject({ from: "2025-12-01", to: "2025-12-31" });
    expect(shiftPeriod(periodContaining("week", "2026-11-04"), 1)).toMatchObject({ from: "2026-11-09" });
    expect(shiftPeriod(periodContaining("day", "2026-03-01"), -1)).toMatchObject({ from: "2026-02-28" });
  });
  it("a scheduled report covers the last finished week or month", () => {
    expect(lastCompletePeriod("month", "2026-12-01")).toMatchObject({ from: "2026-11-01", to: "2026-11-30" });
    expect(lastCompletePeriod("week", "2026-11-09")).toMatchObject({ from: "2026-11-02", to: "2026-11-08" });
  });
  it("labels read naturally", () => {
    expect(periodLabel(periodContaining("month", "2026-10-15"))).toBe("October 2026");
  });
});

describe("which reports are due", () => {
  const s = { weekly: true, weekly_day: 1, monthly: true, last_weekly_sent: null, last_monthly_sent: null };
  it("weekly on the chosen weekday, monthly on the 1st", () => {
    expect(reportsDue("2026-11-02", s)).toEqual(["week"]); // a Monday
    expect(reportsDue("2026-12-01", s)).toEqual(["month"]); // a Tuesday
    expect(reportsDue("2026-06-01", s)).toEqual(["week", "month"]); // Monday the 1st
    expect(reportsDue("2026-11-03", s)).toEqual([]);
  });
  it("never twice on the same day", () => {
    expect(reportsDue("2026-11-02", { ...s, last_weekly_sent: "2026-11-02" })).toEqual([]);
  });
  it("respects what the owner turned off", () => {
    expect(reportsDue("2026-06-01", { ...s, weekly: false })).toEqual(["month"]);
  });
});

describe("email report", () => {
  const summary: FinanceSummary = {
    from: "2026-10-01", to: "2026-10-31", jobs: 3, revenue_cents: 73000, labour_cents: 41250, fuel_cents: 666, materials_cents: 1200, truck_cents: 3750,
    profit_cents: 26134, losing_jobs: 1, complaint_jobs: 1,
    mix: { regular_cents: 25000, new_customer_cents: 40000, upsell_cents: 8000, other_cents: 0 },
    leads: { created: 3, won: 1, open: 1 }, monthly_target_cents: 2000000,
    crews: [{ crew_id: "c1", name: "Crew <1>", revenue_cents: 73000, profit_cents: 26134, jobs: 3, minutes: 180, complaints: 1, leads_created: 3, leads_won: 1 }],
  };

  it("leads with profit and flags what needs a look", () => {
    const r = renderReport(summary, { companyName: "Green Ridge", period: periodContaining("month", "2026-10-01"), previous: { ...summary, profit_cents: 20000, revenue_cents: 60000 } });
    expect(r.subject).toBe("Green Ridge: monthly report, October 2026");
    expect(r.html).toContain("Profit $261");
    expect(r.html).toContain("35.8% margin");
    expect(r.html).toContain("+30.7% vs previous");
    expect(r.html).toContain("1 job lost money");
    expect(r.html).toContain("Complaints on 33.3% of jobs");
    expect(r.html).toContain("reached 3.7%");
    expect(r.text).toContain("Profit $261");
  });

  it("escapes names so a crew name can't inject HTML", () => {
    const r = renderReport(summary, { companyName: "A & B", period: periodContaining("month", "2026-10-01") });
    expect(r.html).toContain("Crew &lt;1&gt;");
    expect(r.html).toContain("A &amp; B");
  });

  it("shows change against the previous period", () => {
    expect(change(110, 100)).toBe("+10%");
    expect(change(90, 100)).toBe("-10%");
    expect(change(5, 0)).toBeNull();
  });
});
