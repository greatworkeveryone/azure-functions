/// <reference types="jest" />
// WP26c: the words for a change, its wire shape, and the code's lists held
// against migration 099's checks.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { changeTenantName, parsePayload, reliefOfRow, toChangeDto } from "./dto";
import { REQUESTABLE_KINDS, reliefSummary, reliefTerms, SCHEDULE_CHANGE_KINDS, SCHEDULE_CHANGE_STATES } from "./types";

const migration = readFileSync(join(__dirname, "..", "..", "migrations", "099_schedule_change_requests.sql"), "utf8");
const checkList = (column: string): string[] =>
  [...(migration.match(new RegExp("CHECK \\(" + column + " IN \\(([^)]*)\\)\\)")) ?? ["", ""])[1].matchAll(/N'(\w+)'/g)].map((m) => m[1]);

describe("the lists agree with migration 099", () => {
  it("has the table's kinds and states, and asks for relief only", () => {
    expect([...SCHEDULE_CHANGE_KINDS]).toEqual(checkList("Kind"));
    expect([...SCHEDULE_CHANGE_STATES]).toEqual(checkList("State"));
    expect(REQUESTABLE_KINDS).toEqual(["relief"]);
  });
});

describe("reliefTerms and reliefSummary", () => {
  const relief = { from: "2026-03-01", kind: "percent" as const, scope: ["rent" as const], to: "2026-08-31", value: 50 };

  it.each([
    [relief, "50% off the rent"],
    [{ ...relief, scope: ["rent", "ahac", "carparks"] as never, value: 12.5 }, "12.5% off the rent, AHAC and car parks"],
    [{ ...relief, value: 100 }, "no rent (100% off)"],
    [{ ...relief, kind: "amount" as const, value: 12000 }, "$12,000.00 a year off the rent"],
    [{ ...relief, kind: "fixed_rent" as const, value: 30000 }, "the rent fixed at $30,000.00 a year"],
  ])("words %p as %p", (given, words) => {
    expect(reliefTerms(given)).toBe(words);
  });

  it("gives the figures, or only the dates for reads that never carry rent", () => {
    expect(reliefSummary(relief)).toBe("Rent relief: 50% off the rent, 01/03/2026 to 31/08/2026");
    expect(reliefSummary(relief, { datesOnly: true })).toBe("Rent relief, 01/03/2026 to 31/08/2026");
  });
});

describe("toChangeDto", () => {
  const row = {
    BuildingId: 5,
    DecidedAt: null,
    DecidedById: null,
    DecidedByName: null,
    DecisionNote: null,
    Kind: "relief",
    LegalName: "Acme Pty Ltd",
    Payload: JSON.stringify({ from: "2026-03-01", kind: "percent", scope: ["rent"], to: "2026-08-31", value: 50 }),
    Reason: "Fit-out",
    RequestId: "req-1",
    RequestedAt: new Date("2026-02-20T01:00:00Z"),
    RequestedById: 7,
    RequestedByName: "Ann",
    State: "pending",
    TenantId: 7,
    TradingName: "Acme Coffee",
    Version: Buffer.from("0000000000000a01", "hex"),
  };

  it("reads a pending relief", () => {
    expect(toChangeDto(row)).toEqual({
      buildingId: 5,
      decided: null,
      kind: "relief",
      payload: { from: "2026-03-01", kind: "percent", scope: ["rent"], to: "2026-08-31", value: 50 },
      reason: "Fit-out",
      relief: { from: "2026-03-01", kind: "percent", scope: ["rent"], to: "2026-08-31", value: 50 },
      requested: { at: "2026-02-20T01:00:00.000Z", byName: "Ann", userId: 7 },
      requestId: "req-1",
      rowVersion: "0000000000000a01",
      state: "pending",
      summary: "Rent relief: 50% off the rent, 01/03/2026 to 31/08/2026",
      tenantId: 7,
      tenantName: "Acme Coffee",
    });
  });

  it("reads a decided one, a payload it can't read, and refuses a kind or state it doesn't know", () => {
    const decided = toChangeDto({ ...row, DecidedAt: new Date("2026-02-21T01:00:00Z"), DecidedById: 10, DecidedByName: "Dee", DecisionNote: "Yes", State: "ratified" });
    expect(decided.decided).toEqual({ at: "2026-02-21T01:00:00.000Z", byName: "Dee", note: "Yes", userId: 10 });
    expect(toChangeDto({ ...row, Payload: "nope" })).toMatchObject({ payload: {}, relief: null, summary: "relief" });
    expect(() => toChangeDto({ ...row, Kind: "bonus" })).toThrow(/unknown kind/);
    expect(() => toChangeDto({ ...row, State: "lost" })).toThrow(/unknown state/);
  });

  it("reads payloads and names defensively", () => {
    expect(parsePayload("[1]")).toEqual({});
    expect(parsePayload(undefined)).toEqual({});
    expect(reliefOfRow({ ...row, Kind: "manual_change" })).toBeNull();
    expect(changeTenantName({ LegalName: " ", TenantId: 9, TradingName: null })).toBe("Tenancy 9");
  });
});
