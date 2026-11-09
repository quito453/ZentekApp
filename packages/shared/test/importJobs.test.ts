import { describe, expect, it } from "vitest";
import { guessMap, missingFields, parseCsv, payloadToRow, readDate, readMoney, readRow, readRows } from "../src/importJobs";

const JOBBER = '﻿Job #,Date,Client,Service address,Line item,Total,Assigned to\r\n1042,2026-10-26,Hendricks,"12 Maple Grove Rd, Unit 2",Weekly mow,"$1,055.00",Crew 2\r\n1043,Oct 27 2026,Okafor,30 Maple Grove Rd,Weekly mow,55,\r\n1044,,Wong,63 Aspen Ave,Mow,95,Crew 1\r\n';

describe("spreadsheet import", () => {
  it("reads quotes, commas inside quotes and Windows line ends", () => {
    const rows = parseCsv(JOBBER);
    expect(rows).toHaveLength(4);
    expect(rows[1]![3]).toBe("12 Maple Grove Rd, Unit 2");
    expect(rows[0]![0]).toBe("Job #");
  });

  it("guesses the columns from a Jobber export", () => {
    const map = guessMap(parseCsv(JOBBER)[0]!);
    expect(map).toEqual({ id: 0, date: 1, customer: 2, address: 3, service: 4, price: 5, crew: 6 });
    expect(missingFields(map)).toEqual([]);
    expect(missingFields({ date: 0 })).toEqual(["customer", "address", "price"]);
  });

  it("turns rows into jobs and says why a row was skipped", () => {
    const rows = parseCsv(JOBBER);
    const r = readRows(rows, guessMap(rows[0]!));
    expect(r[0]).toEqual({
      ok: true,
      job: { date: "2026-10-26", customer: "Hendricks", address: "12 Maple Grove Rd, Unit 2", service: "Weekly mow", priceCents: 105500, crew: "Crew 2", minutes: null, area: null, externalId: "1042" },
    });
    expect(r[1]).toMatchObject({ ok: true, job: { date: "2026-10-27", crew: null } });
    expect(r[2]).toEqual({ ok: false, row: 4, reason: "no date" });
  });

  it("guesses the columns of Jobber's visits report", () => {
    const head = ["Job #", "Date", "Visit title", "Client name", "Client email", "Client phone", "Service street", "Service city", "Service province", "Service postal code", "Visit completed", "Assigned to", "Line items", "One-off job ($)", "Visit based ($)", "Scheduled duration", "Time tracked"];
    const map = guessMap(head);
    expect(map).toMatchObject({ id: 0, date: 1, service: 2, customer: 3, address: 6, crew: 11, minutes: 16 });
    expect([13, 14]).toContain(map.price);
    expect(readRow(["1042", "2026-10-05", "Weekly mow", "Hendricks", "", "", "12 Maple Grove Rd", "Ottawa", "ON", "", "Yes", "Crew 2", "", "", "55.00", "0:45", "1:10"], map, 2)).toMatchObject({ ok: true, job: { priceCents: 5500, minutes: 70, address: "12 Maple Grove Rd" } });
  });

  it("reads the date formats people export", () => {
    expect(readDate("2026/10/05")).toBe("2026-10-05");
    expect(readDate("10/05/2026")).toBe("2026-10-05");
    expect(readDate("25/10/2026")).toBe("2026-10-25");
    expect(readDate("5 Oct 2026")).toBe("2026-10-05");
    expect(readDate("2026-02-30")).toBeNull();
  });

  it("reads money and refuses what it can't", () => {
    expect(readMoney("$1,250.50")).toBe(125050);
    expect(readMoney("55 CAD")).toBe(5500);
    expect(readMoney("-5")).toBeNull();
    expect(readMoney("call")).toBeNull();
  });

  it("treats a small number of minutes as hours", () => {
    const r = readRow(["2026-10-05", "A", "1 Main", "60", "1.5"], { date: 0, customer: 1, address: 2, price: 3, minutes: 4 }, 2);
    expect(r).toMatchObject({ ok: true, job: { minutes: 90 } });
  });

  it("reads a Zapier payload with its own field names", () => {
    const { cells, map } = payloadToRow({ "Job Number": "Y-77", "Completed Date": "2026-10-05", "Customer Name": "Reyes", "Property Address": "88 Willow Dr", Total: "60.00" });
    expect(readRow(cells, map, 1)).toMatchObject({ ok: true, job: { externalId: "Y-77", customer: "Reyes", priceCents: 6000 } });
  });
});
