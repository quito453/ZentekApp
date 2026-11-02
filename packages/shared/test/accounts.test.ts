import { describe, expect, it } from "vitest";
import { isValidUsername, loginEmail, normalizeUsername, passwordProblem } from "../src/accounts";

describe("usernames", () => {
  it("accepts simple names and ignores case and spaces", () => {
    expect(isValidUsername("marco.r")).toBe(true);
    expect(isValidUsername("  Marco.R ")).toBe(true);
    expect(normalizeUsername("  Marco.R ")).toBe("marco.r");
    expect(isValidUsername("luis_g2")).toBe(true);
  });

  it("rejects short, odd or too-long names", () => {
    expect(isValidUsername("mr")).toBe(false);
    expect(isValidUsername(".marco")).toBe(false);
    expect(isValidUsername("marco r")).toBe(false);
    expect(isValidUsername("josé")).toBe(false);
    expect(isValidUsername("a".repeat(33))).toBe(false);
  });

  it("matches the database's username rule", () => {
    // Same pattern as the check on public.profiles.username.
    expect(isValidUsername("abc")).toBe(true);
    expect(isValidUsername("a".repeat(32))).toBe(true);
  });
});

describe("passwords", () => {
  it("needs at least 8 characters and not an obvious one", () => {
    expect(passwordProblem("short")).toBe("too_short");
    expect(passwordProblem("aaaaaaaa")).toBe("too_simple");
    expect(passwordProblem("12345678")).toBe("too_simple");
    expect(passwordProblem("Password1")).toBe("too_simple");
    expect(passwordProblem("x".repeat(73))).toBe("too_long");
    expect(passwordProblem("green-ridge-24")).toBeNull();
  });
});

describe("login email", () => {
  it("turns a username into the internal sign-in address", () => {
    expect(loginEmail(" Marco.R ", "users.zentekapp.com")).toBe("marco.r@users.zentekapp.com");
  });
  it("refuses to run without a domain", () => {
    expect(() => loginEmail("marco.r", "")).toThrow();
  });
});
