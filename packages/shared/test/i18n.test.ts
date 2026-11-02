import { describe, expect, it } from "vitest";
import { missingKeys, t } from "../src/i18n";

describe("i18n", () => {
  it("has every English string in Spanish", () => {
    expect(missingKeys("es")).toEqual([]);
  });

  it("fills placeholders", () => {
    expect(t("en", "ofDone", { d: 3, n: 8 })).toBe("3 of 8 done");
    expect(t("es", "ofDone", { d: 3, n: 8 })).toBe("3 de 8 listos");
  });

  it("falls back to the key for unknown strings", () => {
    expect(t("es", "no_such_key")).toBe("no_such_key");
  });
});
