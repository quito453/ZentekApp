import { describe, expect, it } from "vitest";
import { addDays, createsRecommendedJob, defaultNextService, doneBlocker, type DoneCheckInput } from "../src/jobRules";

const ready: DoneCheckInput = {
  clockedIn: true,
  status: "on_site",
  tasks: ["mow", "edge", "trim", "blow"],
  checked: ["mow", "edge", "trim", "blow"],
  hasBeforePhoto: true,
  hasAfterPhoto: true,
  needsMaterials: false,
  materialsRecorded: false,
  next: { serviceKey: "regular", date: "2026-11-09", fromPlan: true },
};

describe("doneBlocker", () => {
  it("allows Done when everything is in", () => {
    expect(doneBlocker(ready)).toBeNull();
  });

  it("names the first missing step, in the order the crew meets them", () => {
    expect(doneBlocker({ ...ready, clockedIn: false })).toBe("needClock");
    expect(doneBlocker({ ...ready, hasBeforePhoto: false, checked: [] })).toBe("needBefore");
    expect(doneBlocker({ ...ready, checked: ["mow"] })).toBe("needChecks");
    expect(doneBlocker({ ...ready, needsMaterials: true })).toBe("needMat");
    expect(doneBlocker({ ...ready, hasAfterPhoto: false })).toBe("needAfter");
    expect(doneBlocker({ ...ready, next: undefined })).toBe("needNext");
  });

  it("does not block before the crew is on site", () => {
    expect(doneBlocker({ ...ready, status: "en_route", hasBeforePhoto: false })).toBeNull();
  });

  it("needs a note only when the next service is not a regular visit", () => {
    expect(doneBlocker({ ...ready, next: { serviceKey: "regular", date: "2026-11-09" } })).toBeNull();
    expect(doneBlocker({ ...ready, next: { serviceKey: "leaf_cleanup", date: "2026-11-09" } })).toBe("needNext");
    expect(doneBlocker({ ...ready, next: { serviceKey: "leaf_cleanup", date: "2026-11-09", note: "  " } })).toBe("needNext");
    expect(doneBlocker({ ...ready, next: { serviceKey: "leaf_cleanup", date: "2026-11-09", note: "Oak still dropping" } })).toBeNull();
  });
});

describe("next service", () => {
  it("pre-fills weekly and every-2-weeks customers from their plan", () => {
    expect(defaultNextService("weekly", "2026-11-02")).toEqual({ serviceKey: "regular", date: "2026-11-09", fromPlan: true });
    expect(defaultNextService("biweekly", "2026-11-02")?.date).toBe("2026-11-16");
    expect(defaultNextService("seasonal", "2026-11-02")).toBeNull();
  });

  it("only non-regular recommendations become new jobs for the office", () => {
    expect(createsRecommendedJob({ serviceKey: "regular", date: "2026-11-09" })).toBe(false);
    expect(createsRecommendedJob({ serviceKey: "aeration", date: "2026-11-09", note: "compacted" })).toBe(true);
    expect(createsRecommendedJob(undefined)).toBe(false);
  });

  it("adds days across month and year ends", () => {
    expect(addDays("2026-11-28", 7)).toBe("2026-12-05");
    expect(addDays("2026-12-30", 7)).toBe("2027-01-06");
  });
});
