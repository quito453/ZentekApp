import { describe, expect, it } from "vitest";
import { toCsv } from "../src/csv";

describe("toCsv", () => {
  it("quotes commas and quotes, keeps numbers plain", () => {
    expect(toCsv(["Name", "Hours"], [["Ruiz, José", 44.5], ['Ana "AJ" M.', 0]])).toBe('﻿Name,Hours\r\n"Ruiz, José",44.5\r\n"Ana ""AJ"" M.",0\r\n');
  });

  it("stops text from running as a spreadsheet formula", () => {
    expect(toCsv(["Note"], [["=HYPERLINK(\"x\")"], ["-2+3"], ["@SUM(A1)"]])).toBe('﻿Note\r\n"\'=HYPERLINK(""x"")"\r\n\'-2+3\r\n\'@SUM(A1)\r\n');
  });

  it("leaves negative numbers alone", () => {
    expect(toCsv(["Profit"], [[-922]])).toBe("﻿Profit\r\n-922\r\n");
  });

  it("writes empty cells for missing values", () => {
    expect(toCsv(["A", "B"], [[null, undefined]])).toBe("﻿A,B\r\n,\r\n");
  });
});
