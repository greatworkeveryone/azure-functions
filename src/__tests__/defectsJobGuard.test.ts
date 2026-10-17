/// <reference types="jest" />
import type { Connection } from "tedious";

jest.mock("../db", () => ({ executeQuery: jest.fn() }));
jest.mock("../sentry", () => ({ Sentry: { captureException: jest.fn(), captureMessage: jest.fn() } }));
jest.mock("../auth", () => {
  const actual = jest.requireActual("../auth");
  return {
    ...actual,
    requireRole: jest.fn().mockResolvedValue(null),
    rolesForRequest: jest.fn().mockResolvedValue(["facilities_manager"]),
    verifiedIdentityFromRequest: jest.fn().mockResolvedValue({ email: "a@rp.com", name: "Adam", oid: "oid-a" }),
  };
});

import { guardNewJob, recordDefectsOverride } from "../defectsJobGuard";
import { ledgerInserts } from "./fixtures/ledgerCalls";
import { callsMatching, paramsOf, periodRow, post, routeQueries } from "./fixtures/facilitiesHarness";

const db = require("../db") as { executeQuery: jest.Mock };
const auth = require("../auth") as { requireRole: jest.Mock };
const conn = {} as Connection;
const TODAY = "2026-10-14";
const LIVE = /FROM dbo\.DefectsPeriods d[\s\S]*d\.PracticalCompletion <= @Today AND d\.EndsOn >= @Today/;
const JOB_EVENT = /INSERT INTO JobEvents/;

const maintenance = { BuildingID: 1, Category: "HVAC / mechanical", Kind: "maintenance", Title: "Chiller service" };
const reactive = { BuildingID: 1, Category: "Common Areas", Kind: "facilities", Title: "AC not cooling", Type: "Air Conditioning" };

beforeEach(() => {
  jest.clearAllMocks();
  auth.requireRole.mockResolvedValue(null);
  routeQueries(db.executeQuery, [
    { match: LIVE, rows: [periodRow()] },
    { match: /FROM dbo\.AppUsers WHERE EntraOid/, rows: [{ UserID: 4 }] },
  ]);
});

describe("guardNewJob", () => {
  it("refuses planned maintenance on a covered scope with a 409 naming who is responsible and until when", async () => {
    auth.requireRole.mockResolvedValue({ jsonBody: { error: "Forbidden" }, status: 403 });
    const result = await guardNewJob(conn, post({}), {}, maintenance, TODAY);
    expect(result.response?.status).toBe(409);
    const body = result.response?.jsonBody as { canOverride: boolean; code: string; error: string; periods: Array<{ defectsPeriodId: number }> };
    expect(body.code).toBe("defects_period");
    expect(body.canOverride).toBe(false);
    expect(body.periods.map((p) => p.defectsPeriodId)).toEqual([3]);
    expect(body.error).toBe(
      "This is inside the Level 3 mechanical upgrade defects period until 30/06/2027: Acme Builders (Sam Builder 0400 000 000) is responsible for HVAC / mechanical in this building. Ask a facilities manager if RP should book it anyway.",
    );
    expect(paramsOf(callsMatching(db.executeQuery, LIVE)[0])).toEqual({ BuildingId: 1, Today: TODAY });
  });

  it("tells a manager they can book anyway", async () => {
    const result = await guardNewJob(conn, post({}), {}, maintenance, TODAY);
    expect((result.response?.jsonBody as { canOverride: boolean }).canOverride).toBe(true);
    expect((result.response?.jsonBody as { error: string }).error).toMatch(/Book anyway with a reason if RP should do it\.$/);
  });

  it("lets a manager book anyway with a reason", async () => {
    const result = await guardNewJob(conn, post({}), { DefectsOverrideReason: "  Builder in liquidation  " }, maintenance, TODAY);
    expect(result.response).toBeUndefined();
    expect(result.override).toMatchObject({ reason: "Builder in liquidation" });
    expect(result.override?.periods).toHaveLength(1);
  });

  it("refuses an override from someone who isn't a manager", async () => {
    auth.requireRole.mockResolvedValue({ jsonBody: { error: "Forbidden" }, status: 403 });
    const result = await guardNewJob(conn, post({}), { DefectsOverrideReason: "Urgent" }, maintenance, TODAY);
    expect(result.response?.status).toBe(403);
  });

  it("400 for an override reason that isn't text or is too long", async () => {
    expect((await guardNewJob(conn, post({}), { DefectsOverrideReason: 5 }, maintenance, TODAY)).response?.status).toBe(400);
    expect((await guardNewJob(conn, post({}), { DefectsOverrideReason: "x".repeat(501) }, maintenance, TODAY)).response?.status).toBe(400);
  });

  it("never blocks a reactive job: it comes back as a warning", async () => {
    const result = await guardNewJob(conn, post({}), {}, reactive, TODAY);
    expect(result.response).toBeUndefined();
    expect(result.warnings.map((p) => p.defectsPeriodId)).toEqual([3]);
  });

  it("records a manager's reason on covered reactive work too, so a kind change leaves a trail", async () => {
    const result = await guardNewJob(conn, post({}), { DefectsOverrideReason: "Tenant emergency" }, reactive, TODAY);
    expect(result.response).toBeUndefined();
    expect(result.override).toMatchObject({ reason: "Tenant emergency" });
  });

  it("ignores a reason on covered reactive work from someone who isn't a manager (it never blocked)", async () => {
    auth.requireRole.mockResolvedValue({ jsonBody: { error: "Forbidden" }, status: 403 });
    const result = await guardNewJob(conn, post({}), { DefectsOverrideReason: "Because" }, reactive, TODAY);
    expect(result).toMatchObject({ override: null });
    expect(result.response).toBeUndefined();
  });

  it("only warns for a warn-only period", async () => {
    routeQueries(db.executeQuery, [{ match: LIVE, rows: [periodRow({ Enforcement: "warn" })] }]);
    const result = await guardNewJob(conn, post({}), {}, maintenance, TODAY);
    expect(result.response).toBeUndefined();
    expect(result.warnings).toHaveLength(1);
  });

  it("won't let a maintenance job slip past by leaving its category empty", async () => {
    auth.requireRole.mockResolvedValue({ jsonBody: { error: "Forbidden" }, status: 403 });
    const result = await guardNewJob(conn, post({}), {}, { ...maintenance, Category: undefined }, TODAY);
    expect(result.response?.status).toBe(409);
    const body = result.response?.jsonBody as { error: string; missing: string; needsDetail: boolean };
    expect(body).toMatchObject({ missing: "category", needsDetail: true });
    expect(body.error).toBe(
      "Choose the category first: the Level 3 mechanical upgrade defects period covers part of this building until 30/06/2027, and Floorplan needs it to tell whether Acme Builders owes this work. Ask a facilities manager if RP should book it anyway.",
    );
  });

  it("won't let it slip past by leaving the level empty under a level-scoped period", async () => {
    routeQueries(db.executeQuery, [{ match: LIVE, rows: [periodRow({ LevelName: "Level 3", Scope: "level" })] }]);
    const result = await guardNewJob(conn, post({}), {}, maintenance, TODAY);
    expect(result.response?.status).toBe(409);
    expect(result.response?.jsonBody).toMatchObject({ missing: "level", needsDetail: true });
  });

  it("lets a manager book it anyway with a reason when the answer isn't known", async () => {
    const result = await guardNewJob(conn, post({}), { DefectsOverrideReason: "Roof plant, every level" }, { ...maintenance, Category: undefined }, TODAY);
    expect(result.response).toBeUndefined();
    expect(result.override?.periods.map((p) => p.defectsPeriodId)).toEqual([3]);
  });

  it("asks nothing more under a warn-only period", async () => {
    routeQueries(db.executeQuery, [{ match: LIVE, rows: [periodRow({ Enforcement: "warn" })] }]);
    const result = await guardNewJob(conn, post({}), {}, { ...maintenance, Category: undefined }, TODAY);
    expect(result.response).toBeUndefined();
  });

  it("lets maintenance through when nothing covers it", async () => {
    const result = await guardNewJob(conn, post({}), {}, { ...maintenance, Category: "Lifts" }, TODAY);
    expect(result).toEqual({ override: null, warnings: [] });
  });

  it("keeps job creation working, loudly, if migration 119 hasn't been applied", async () => {
    routeQueries(db.executeQuery, [{ match: LIVE, throws: new Error("Invalid object name 'dbo.DefectsPeriods'.") }]);
    const result = await guardNewJob(conn, post({}), {}, maintenance, TODAY);
    expect(result).toEqual({ override: null, warnings: [] });
    const { Sentry } = require("../sentry") as { Sentry: { captureMessage: jest.Mock } };
    expect(Sentry.captureMessage).toHaveBeenCalledWith(expect.stringMatching(/apply migration 119/), "error");
  });

  it("fails the create on any other database error", async () => {
    routeQueries(db.executeQuery, [{ match: LIVE, throws: new Error("deadlock victim") }]);
    await expect(guardNewJob(conn, post({}), {}, maintenance, TODAY)).rejects.toThrow("deadlock victim");
  });

  it("asks nothing of the database without a building", async () => {
    const result = await guardNewJob(conn, post({}), {}, { Kind: "maintenance" }, TODAY);
    expect(result).toEqual({ override: null, warnings: [] });
    expect(db.executeQuery).not.toHaveBeenCalled();
  });
});

describe("recordDefectsOverride", () => {
  it("writes a defects_override job event and an exception in the ledger with the reason", async () => {
    const period = (await guardNewJob(conn, post({}), { DefectsOverrideReason: "Builder in liquidation" }, maintenance, TODAY)).override;
    await recordDefectsOverride(conn, post({}), { buildingId: 1, callerName: "Adam", jobId: 88, override: period! });
    const [event] = callsMatching(db.executeQuery, JOB_EVENT);
    expect(paramsOf(event)).toMatchObject({
      CreatedBy: "Adam",
      EventType: "defects_override",
      JobID: 88,
      Text: "Booked anyway inside the Level 3 mechanical upgrade defects period (to 30/06/2027, Acme Builders): Builder in liquidation",
    });
    const [ledger] = ledgerInserts(db.executeQuery);
    expect(ledger).toMatchObject({
      action: "job.defects_override",
      actorName: "Adam",
      buildingId: 1,
      isException: true,
      jobId: 88,
      reason: "Builder in liquidation",
      ruleApplied: "defects_period_block",
      subjectId: "88",
      subjectType: "job",
    });
  });

  it("throws when the caller can't be identified, so the create rolls back", async () => {
    const verified = require("../auth").verifiedIdentityFromRequest as jest.Mock;
    verified.mockResolvedValueOnce(null);
    const override = { periods: [], reason: "x" };
    await expect(recordDefectsOverride(conn, post({}), { buildingId: 1, callerName: "Adam", jobId: 88, override })).rejects.toThrow(/identify/);
  });
});
