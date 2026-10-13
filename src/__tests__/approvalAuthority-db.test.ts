import { afterAll, afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";

jest.mock("../approval-limits-db");

import { Connection } from "tedious";
import { getCachedApprovalLimits } from "../approval-limits-db";
import { darwinToday, loadApprovalFacts, parseDirectorThreshold, resolveApprovalAuthority } from "../approvalAuthority-db";

const mockLimits = getCachedApprovalLimits as jest.MockedFunction<typeof getCachedApprovalLimits>;
const conn = {} as Connection;
const ENV_KEY = "DIRECTOR_APPROVAL_THRESHOLD";
const savedEnv = process.env[ENV_KEY];

const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);

beforeEach(() => {
  mockLimits.mockReset();
  warn.mockClear();
  delete process.env[ENV_KEY];
});
afterEach(() => {
  jest.useRealTimers();
  if (savedEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = savedEnv;
});
afterAll(() => warn.mockRestore());

describe("parseDirectorThreshold", () => {
  it.each([
    [undefined, null],
    ["", null],
    ["   ", null],
    ["20000", 20000],
    [" 20000.50 ", 20000.5],
  ])("%p gives %p without a warning", (raw, expected) => {
    expect(parseDirectorThreshold(raw)).toBe(expected);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(["abc", "20,000", "$20000", "0", "-5", "Infinity", "NaN"])("%p gives null and warns once", (raw) => {
    expect(parseDirectorThreshold(raw)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("darwinToday", () => {
  it("rolls over at 14:30 UTC (Darwin is UTC+9:30 all year)", () => {
    expect(darwinToday(new Date("2026-10-13T14:29:59Z"))).toBe("2026-10-13");
    expect(darwinToday(new Date("2026-10-13T14:30:00Z"))).toBe("2026-10-14");
    expect(darwinToday(new Date("2026-06-30T20:00:00Z"))).toBe("2026-07-01");
    expect(darwinToday(new Date("2026-12-31T14:30:00Z"))).toBe("2027-01-01");
  });
});

describe("loadApprovalFacts", () => {
  it("maps ApprovalLimits rows, keeps NULL as unlimited, and has no residences yet", async () => {
    mockLimits.mockResolvedValue([
      { MaxApprovalAmount: 5000, RoleName: "facilities" },
      { MaxApprovalAmount: null, RoleName: "accounts_manager" },
    ]);
    jest.useFakeTimers({ now: new Date("2026-10-13T15:00:00Z") });

    const facts = await loadApprovalFacts(conn, 42);

    expect(mockLimits).toHaveBeenCalledWith(conn);
    expect(facts).toEqual({
      directorThreshold: null,
      isResidence: false,
      limits: [
        { limit: 5000, role: "facilities" },
        { limit: null, role: "accounts_manager" },
      ],
      residenceApprovers: [],
      residenceDirectorFallback: true,
      today: "2026-10-14",
    });
  });

  it("reads DIRECTOR_APPROVAL_THRESHOLD, and ignores a bad one", async () => {
    mockLimits.mockResolvedValue([]);
    process.env[ENV_KEY] = "20000";
    expect((await loadApprovalFacts(conn, 1)).directorThreshold).toBe(20000);
    process.env[ENV_KEY] = "twenty thousand";
    expect((await loadApprovalFacts(conn, 1)).directorThreshold).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("resolveApprovalAuthority", () => {
  it("decides on the loaded facts", async () => {
    mockLimits.mockResolvedValue([
      { MaxApprovalAmount: 5000, RoleName: "accounts" },
      { MaxApprovalAmount: 20000, RoleName: "accounts_manager" },
    ]);
    process.env[ENV_KEY] = "10000";

    const { facts, result } = await resolveApprovalAuthority(conn, { amount: 15000, buildingId: 7, subject: "invoice" });

    expect(facts.directorThreshold).toBe(10000);
    expect(result).toEqual({
      directorRequired: true,
      effectiveDirectorThreshold: 10000,
      isResidence: false,
      route: [{ basis: "director_threshold", kind: "role", limit: null, role: "director" }],
    });
  });
});
