/// <reference types="jest" />
import type { Connection } from "tedious";
import { isFeatureEnabledForRoles, resetFeatureFlagCache } from "./flags";

jest.mock("../db", () => ({ executeQuery: jest.fn() }));
const db = require("../db") as { executeQuery: jest.Mock };

const conn = {} as Connection;
const row = (FeatureKey: string, RoleName: string) => ({ FeatureKey, RoleName, Visibility: "enabled" });

beforeEach(() => {
  jest.clearAllMocks();
  resetFeatureFlagCache();
});

describe("isFeatureEnabledForRoles", () => {
  it("is true when the role has an enabled row", async () => {
    db.executeQuery.mockResolvedValue([row("teamsAlerts", "director")]);
    await expect(isFeatureEnabledForRoles("teamsAlerts", ["director"], { connection: conn })).resolves.toBe(true);
  });

  it("asks only for enabled rows, with no user input in the SQL", async () => {
    db.executeQuery.mockResolvedValue([]);
    await isFeatureEnabledForRoles("teamsAlerts", ["director"], { connection: conn });
    expect(db.executeQuery.mock.calls[0][1]).toContain("Visibility = N'enabled'");
    expect(db.executeQuery.mock.calls[0][1]).not.toContain("teamsAlerts");
  });

  it("is true if any one of several roles is enabled (most permissive wins)", async () => {
    db.executeQuery.mockResolvedValue([row("teamsAlerts", "cfo")]);
    await expect(isFeatureEnabledForRoles("teamsAlerts", ["facilities", "cfo"], { connection: conn })).resolves.toBe(true);
  });

  it("matches role names case-insensitively", async () => {
    db.executeQuery.mockResolvedValue([row("teamsAlerts", "Director ")]);
    await expect(isFeatureEnabledForRoles("teamsAlerts", ["DIRECTOR"], { connection: conn })).resolves.toBe(true);
  });

  it("is false for hidden or preview rows (they are never selected)", async () => {
    db.executeQuery.mockResolvedValue([]);
    await expect(isFeatureEnabledForRoles("teamsAlerts", ["director"], { connection: conn })).resolves.toBe(false);
  });

  it("is false when the row is for another role or another feature", async () => {
    db.executeQuery.mockResolvedValue([row("teamsAlerts", "cfo"), row("escalations", "director")]);
    await expect(isFeatureEnabledForRoles("teamsAlerts", ["director"], { connection: conn })).resolves.toBe(false);
  });

  it("is false with no rows, no roles, or a database error", async () => {
    db.executeQuery.mockResolvedValue([]);
    await expect(isFeatureEnabledForRoles("teamsAlerts", [], { connection: conn })).resolves.toBe(false);
    resetFeatureFlagCache();
    db.executeQuery.mockRejectedValue(new Error("db down"));
    await expect(isFeatureEnabledForRoles("teamsAlerts", ["director"], { connection: conn })).resolves.toBe(false);
  });

  it("caches for 60 s, then reads again; a failed read is not cached", async () => {
    let t = 1_000_000;
    const deps = { connection: conn, now: () => t };
    db.executeQuery.mockResolvedValue([row("teamsAlerts", "director")]);
    await isFeatureEnabledForRoles("teamsAlerts", ["director"], deps);
    t += 59_000;
    await isFeatureEnabledForRoles("teamsAlerts", ["cfo"], deps);
    expect(db.executeQuery).toHaveBeenCalledTimes(1);
    t += 2_000;
    db.executeQuery.mockResolvedValue([]);
    await expect(isFeatureEnabledForRoles("teamsAlerts", ["director"], deps)).resolves.toBe(false);
    expect(db.executeQuery).toHaveBeenCalledTimes(2);

    resetFeatureFlagCache();
    db.executeQuery.mockRejectedValueOnce(new Error("blip"));
    await isFeatureEnabledForRoles("teamsAlerts", ["director"], deps);
    db.executeQuery.mockResolvedValue([row("teamsAlerts", "director")]);
    await expect(isFeatureEnabledForRoles("teamsAlerts", ["director"], deps)).resolves.toBe(true);
  });
});
