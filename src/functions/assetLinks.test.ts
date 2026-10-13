/// <reference types="jest" />
import { HttpRequest, InvocationContext } from "@azure/functions";

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn() } };
});

jest.mock("../auth", () => {
  const actual = jest.requireActual("../auth");
  return {
    ...actual,
    errorResponse: jest.fn().mockReturnValue({ status: 500, jsonBody: { error: "Error" } }),
    extractToken: jest.fn().mockReturnValue("mock-token"),
    requireRole: jest.fn().mockResolvedValue(null),
    unauthorizedResponse: jest.fn().mockReturnValue({ status: 401, jsonBody: { error: "Unauthorized" } }),
    verifiedIdentityFromRequest: jest.fn().mockResolvedValue({ email: "c@rp.com", name: "Connor", oid: "oid-1" }),
  };
});

jest.mock("../db", () => {
  const actual = jest.requireActual("../db");
  return {
    ...actual,
    beginTransaction: jest.fn().mockResolvedValue(undefined),
    closeConnection: jest.fn(),
    commitTransaction: jest.fn().mockResolvedValue(undefined),
    createRequestConnection: jest.fn().mockResolvedValue({}),
    executeQuery: jest.fn().mockResolvedValue([]),
    rollbackTransaction: jest.fn().mockResolvedValue(undefined),
  };
});

import { linkJobAsset } from "./linkJobAsset";
import { unlinkJobAsset } from "./unlinkJobAsset";

type Row = Record<string, unknown>;
type Route = { match: RegExp; rows?: Row[]; throws?: Error };
type SqlCall = [unknown, string, Array<{ name: string; value: unknown }>?];

const db = require("../db") as {
  beginTransaction: jest.Mock;
  closeConnection: jest.Mock;
  commitTransaction: jest.Mock;
  createRequestConnection: jest.Mock;
  executeQuery: jest.Mock;
  rollbackTransaction: jest.Mock;
};

const context = new InvocationContext();

function route(routes: Route[]): void {
  db.executeQuery.mockImplementation(async (_connection: unknown, sql: string) => {
    const hit = routes.find((r) => r.match.test(sql));
    if (!hit) return [];
    if (hit.throws) throw hit.throws;
    return hit.rows ?? [];
  });
}
const queries = (match: RegExp): SqlCall[] =>
  (db.executeQuery.mock.calls as SqlCall[]).filter(([, sql]) => match.test(sql));
const paramsOf = (call: SqlCall): Row => Object.fromEntries((call[2] ?? []).map((p) => [p.name, p.value]));
const post = (value: unknown): HttpRequest =>
  ({ json: async () => value, query: new URLSearchParams() }) as unknown as HttpRequest;
const errorOf = (response: { jsonBody?: unknown }): string => (response.jsonBody as { error: string }).error;

const JOB = /SELECT JobID, BuildingID FROM dbo\.Jobs WHERE JobID = @JobId/;
const ASSET = /SELECT AssetId, BuildingId, ArchivedAt FROM dbo\.Assets WHERE AssetId = @AssetId/;
const LINK = /INSERT INTO dbo\.JobAssets/;
const EXISTING = /SELECT LinkedAt, LinkedBy FROM dbo\.JobAssets/;
const UNLINK = /DELETE FROM dbo\.JobAssets/;

const BODY = { assetId: 12, jobId: 7 };
const linkedAt = new Date("2026-10-13T01:00:00.000Z");
const sameBuilding: Route[] = [
  { match: JOB, rows: [{ BuildingID: 1, JobID: 7 }] },
  { match: ASSET, rows: [{ ArchivedAt: null, AssetId: 12, BuildingId: 1 }] },
];

beforeEach(() => {
  jest.clearAllMocks();
  db.executeQuery.mockReset();
  db.executeQuery.mockResolvedValue([]);
  db.createRequestConnection.mockResolvedValue({});
});

describe("linkJobAsset", () => {
  it.each([
    [{}, "jobId is required"],
    [{ jobId: 7 }, "assetId is required"],
    [{ assetId: 12, jobId: 0 }, "jobId must be an integer"],
    [{ assetId: "12", jobId: 7 }, "assetId must be an integer"],
  ])("rejects %j", async (payload, message) => {
    const response = await linkJobAsset(post(payload), context);
    expect(response.status).toBe(400);
    expect(errorOf(response)).toContain(message);
    expect(db.createRequestConnection).not.toHaveBeenCalled();
  });

  it("404s for an unknown job or asset and writes nothing", async () => {
    route([{ match: ASSET, rows: [{ ArchivedAt: null, AssetId: 12, BuildingId: 1 }] }]);
    const noJob = await linkJobAsset(post(BODY), context);
    expect(noJob.status).toBe(404);
    expect(errorOf(noJob)).toBe("Job not found");

    route([{ match: JOB, rows: [{ BuildingID: 1, JobID: 7 }] }]);
    const noAsset = await linkJobAsset(post(BODY), context);
    expect(noAsset.status).toBe(404);
    expect(errorOf(noAsset)).toBe("Asset not found");
    expect(queries(LINK)).toHaveLength(0);
  });

  it("only links within one building", async () => {
    route([
      { match: JOB, rows: [{ BuildingID: 1, JobID: 7 }] },
      { match: ASSET, rows: [{ ArchivedAt: null, AssetId: 12, BuildingId: 2 }] },
    ]);
    const response = await linkJobAsset(post(BODY), context);
    expect(response.status).toBe(400);
    expect(errorOf(response)).toContain("different buildings");
    expect(queries(LINK)).toHaveLength(0);
    expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(db.commitTransaction).not.toHaveBeenCalled();
  });

  it("treats a manual (negative) building like any other", async () => {
    route([
      { match: JOB, rows: [{ BuildingID: -2, JobID: 7 }] },
      { match: ASSET, rows: [{ ArchivedAt: null, AssetId: 12, BuildingId: -2 }] },
      { match: LINK, rows: [{ LinkedAt: linkedAt, LinkedBy: "Connor" }] },
    ]);
    const response = await linkJobAsset(post(BODY), context);
    expect(response.status).toBe(200);
  });

  it("will not link an archived asset", async () => {
    route([
      { match: JOB, rows: [{ BuildingID: 1, JobID: 7 }] },
      { match: ASSET, rows: [{ ArchivedAt: linkedAt, AssetId: 12, BuildingId: 1 }] },
    ]);
    const response = await linkJobAsset(post(BODY), context);
    expect(response.status).toBe(409);
    expect(queries(LINK)).toHaveLength(0);
  });

  it("creates the link, stamping who linked it", async () => {
    route([...sameBuilding, { match: LINK, rows: [{ LinkedAt: linkedAt, LinkedBy: "Connor" }] }]);
    const response = await linkJobAsset(post(BODY), context);

    expect(response.status).toBe(200);
    expect(response.jsonBody).toEqual({
      created: true,
      link: { assetId: 12, jobId: 7, linkedAt: "2026-10-13T01:00:00.000Z", linkedBy: "Connor" },
    });
    const [insert] = queries(LINK);
    expect(paramsOf(insert)).toEqual({ AssetId: 12, Caller: "Connor", JobId: 7 });
    expect(insert[1]).toContain("WHERE NOT EXISTS");
    expect(db.commitTransaction).toHaveBeenCalledTimes(1);
  });

  it("is idempotent: an existing link comes back with created: false", async () => {
    route([...sameBuilding, { match: LINK, rows: [] }, { match: EXISTING, rows: [{ LinkedAt: linkedAt, LinkedBy: "Sam" }] }]);
    const response = await linkJobAsset(post(BODY), context);

    expect(response.status).toBe(200);
    expect(response.jsonBody).toEqual({
      created: false,
      link: { assetId: 12, jobId: 7, linkedAt: "2026-10-13T01:00:00.000Z", linkedBy: "Sam" },
    });
  });

  it("treats losing a create race as 'already linked'", async () => {
    route([
      ...sameBuilding,
      { match: LINK, throws: Object.assign(new Error("Violation of PRIMARY KEY constraint 'PK_JobAssets'. Cannot insert duplicate key in object 'dbo.JobAssets'."), { number: 2627 }) },
    ]);
    const response = await linkJobAsset(post(BODY), context);
    expect(response.status).toBe(200);
    expect(response.jsonBody).toMatchObject({ created: false, link: { assetId: 12, jobId: 7 } });
    expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
  });

  it("reports an unexpected failure as a 500", async () => {
    route([...sameBuilding, { match: LINK, throws: new Error("deadlock victim") }]);
    const response = await linkJobAsset(post(BODY), context);
    expect(response.status).toBe(500);
    expect(db.closeConnection).toHaveBeenCalledTimes(1);
  });
});

describe("unlinkJobAsset", () => {
  it.each([[{}, "jobId is required"], [{ jobId: 7 }, "assetId is required"]])("rejects %j", async (payload, message) => {
    const response = await unlinkJobAsset(post(payload), context);
    expect(response.status).toBe(400);
    expect(errorOf(response)).toContain(message);
    expect(db.createRequestConnection).not.toHaveBeenCalled();
  });

  it("removes the link", async () => {
    route([{ match: UNLINK, rows: [{ JobId: 7 }] }]);
    const response = await unlinkJobAsset(post(BODY), context);
    expect(response.status).toBe(200);
    expect(response.jsonBody).toEqual({ assetId: 12, jobId: 7, unlinked: true });
    expect(paramsOf(queries(UNLINK)[0])).toEqual({ AssetId: 12, JobId: 7 });
  });

  it("answers 200 / unlinked: false when there was no link", async () => {
    const response = await unlinkJobAsset(post(BODY), context);
    expect(response.status).toBe(200);
    expect(response.jsonBody).toEqual({ assetId: 12, jobId: 7, unlinked: false });
  });

  it("reports an unexpected failure as a 500", async () => {
    route([{ match: UNLINK, throws: new Error("boom") }]);
    const response = await unlinkJobAsset(post(BODY), context);
    expect(response.status).toBe(500);
    expect(db.closeConnection).toHaveBeenCalledTimes(1);
  });
});
