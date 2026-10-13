/// <reference types="jest" />
import type { Connection } from "tedious";
import {
  getPolicy,
  invalidatePolicyCache,
  invalidPolicyMessages,
  loadPolicies,
  parseLadder,
  parsePolicyRow,
  POLICY_CACHE_TTL_MS,
} from "./policies";

jest.mock("../db", () => ({ executeQuery: jest.fn() }));
const db = require("../db") as { executeQuery: jest.Mock };

const conn = {} as Connection;

const row = (overrides: Record<string, unknown> = {}) => ({
  Active: true,
  AutoReescalate: "yes",
  Clock: "business",
  Kind: "attention",
  Ladder: '[{"role":"facilities_manager","slaHours":16},{"role":"director","slaHours":16}]',
  PolicyKey: "job.stalled_unacknowledged",
  UpdatedAt: new Date("2026-10-01T00:00:00Z"),
  UpdatedBy: "migration:098_escalations",
  Urgent: false,
  ...overrides,
});

beforeEach(() => {
  jest.clearAllMocks();
  db.executeQuery.mockReset();
  invalidatePolicyCache();
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => jest.restoreAllMocks());

describe("parseLadder", () => {
  it("reads roles, tokens, user targets and SLAs", () => {
    expect(
      parseLadder('[{"token":"raiser_manager","slaHours":8},{"role":" Facilities_Manager ","slaHours":16},{"userTarget":true},{"token":"authority_route"},{"role":"director"}]'),
    ).toEqual([
      { slaHours: 8, token: "raiser_manager" },
      { role: "facilities_manager", slaHours: 16 },
      { userTarget: true },
      { token: "authority_route" },
      { role: "director" },
    ]);
  });

  it("treats a null SLA as none", () => {
    expect(parseLadder('[{"role":"director","slaHours":null}]')).toEqual([{ role: "director" }]);
  });

  it.each([
    ["not JSON", "nope"],
    ["not an array", '{"role":"director"}'],
    ["empty", "[]"],
    ["an entry that isn't an object", '["director"]'],
    ["an entry with nothing in it", "[{}]"],
    ["an entry with two targets", '[{"role":"director","token":"raiser_manager"}]'],
    ["an unknown token", '[{"token":"boss"}]'],
    ["a blank role", '[{"role":" "}]'],
    ["a negative SLA", '[{"role":"director","slaHours":-1}]'],
    ["a text SLA", '[{"role":"director","slaHours":"16"}]'],
  ])("refuses %s", (_label, json) => {
    expect(() => parseLadder(json)).toThrow();
  });
});

describe("parsePolicyRow", () => {
  it("turns a row into a policy", () => {
    expect(parsePolicyRow(row())).toMatchObject({
      active: true,
      autoReescalate: "yes",
      clock: "business",
      kind: "attention",
      policyKey: "job.stalled_unacknowledged",
      urgent: false,
    });
  });

  it("carries urgent and wall for job.critical", () => {
    expect(parsePolicyRow(row({ Clock: "wall", PolicyKey: "job.critical", Urgent: true }))).toMatchObject({ clock: "wall", urgent: true });
  });

  it.each([
    ["Kind", "other"],
    ["Clock", "lunar"],
    ["AutoReescalate", "maybe"],
    ["Ladder", "[]"],
    ["PolicyKey", ""],
  ])("refuses a row with a bad %s", (column, value) => {
    expect(() => parsePolicyRow(row({ [column]: value }))).toThrow();
  });
});

describe("the five-minute cache", () => {
  it("reads the table once and serves the cache until five minutes pass", async () => {
    db.executeQuery.mockResolvedValue([row(), row({ PolicyKey: "job.unassigned" })]);

    const t0 = 1_000_000;
    const first = await loadPolicies(conn, t0);
    expect(first.size).toBe(2);
    await loadPolicies(conn, t0 + POLICY_CACHE_TTL_MS - 1);
    expect(db.executeQuery).toHaveBeenCalledTimes(1);

    await loadPolicies(conn, t0 + POLICY_CACHE_TTL_MS);
    expect(db.executeQuery).toHaveBeenCalledTimes(2);
  });

  it("is five minutes", () => {
    expect(POLICY_CACHE_TTL_MS).toBe(300_000);
  });

  it("picks up an admin's edit after the cache expires", async () => {
    db.executeQuery.mockResolvedValueOnce([row()]);
    db.executeQuery.mockResolvedValueOnce([row({ Ladder: '[{"role":"director","slaHours":1}]' })]);

    expect((await getPolicy(conn, "job.stalled_unacknowledged", 0))?.ladder).toHaveLength(2);
    expect((await getPolicy(conn, "job.stalled_unacknowledged", POLICY_CACHE_TTL_MS + 1))?.ladder).toEqual([{ role: "director", slaHours: 1 }]);
  });

  it("invalidatePolicyCache forces a reload", async () => {
    db.executeQuery.mockResolvedValue([row()]);
    await loadPolicies(conn, 0);
    invalidatePolicyCache();
    await loadPolicies(conn, 1);
    expect(db.executeQuery).toHaveBeenCalledTimes(2);
  });

  it("leaves a broken row out and keeps the rest working", async () => {
    db.executeQuery.mockResolvedValue([row({ Ladder: "oops" }), row({ PolicyKey: "job.unassigned" })]);

    const policies = await loadPolicies(conn, 0);

    expect([...policies.keys()]).toEqual(["job.unassigned"]);
    expect(invalidPolicyMessages()).toHaveLength(1);
    expect(await getPolicy(conn, "job.stalled_unacknowledged", 1)).toBeNull();
  });

  it("serves the stale copy when a reload fails, and throws when there is none", async () => {
    db.executeQuery.mockResolvedValueOnce([row()]);
    await loadPolicies(conn, 0);
    db.executeQuery.mockRejectedValueOnce(new Error("database is down"));

    expect((await loadPolicies(conn, POLICY_CACHE_TTL_MS + 5)).size).toBe(1);

    invalidatePolicyCache();
    db.executeQuery.mockRejectedValueOnce(new Error("database is down"));
    await expect(loadPolicies(conn, 0)).rejects.toThrow("database is down");
  });

  it("returns null for an unknown policy", async () => {
    db.executeQuery.mockResolvedValue([row()]);
    expect(await getPolicy(conn, "nope", 0)).toBeNull();
  });
});
