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

const auth = require("../auth") as { verifiedIdentityFromRequest: jest.Mock };

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
const UNLINK = /UPDATE dbo\.JobAssets/;

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
    expect(insert[1]).toMatch(/NOT EXISTS \([^)]*UnlinkedAt IS NULL\)/);
    expect(db.commitTransaction).toHaveBeenCalledTimes(1);
  });

  it("is idempotent: an existing live link comes back with created: false", async () => {
    route([...sameBuilding, { match: LINK, rows: [] }, { match: EXISTING, rows: [{ LinkedAt: linkedAt, LinkedBy: "Sam" }] }]);
    const response = await linkJobAsset(post(BODY), context);

    expect(response.status).toBe(200);
    expect(response.jsonBody).toEqual({
      created: false,
      link: { assetId: 12, jobId: 7, linkedAt: "2026-10-13T01:00:00.000Z", linkedBy: "Sam" },
    });
    expect(queries(EXISTING)[0][1]).toContain("UnlinkedAt IS NULL");
  });

  it("treats losing a create race as 'already linked'", async () => {
    route([
      ...sameBuilding,
      {
        match: LINK,
        throws: Object.assign(
          new Error("Cannot insert duplicate key row in object 'dbo.JobAssets' with unique index 'UX_JobAssets_Live'. The duplicate key value is (7, 12)."),
          { number: 2601 },
        ),
      },
    ]);
    const response = await linkJobAsset(post(BODY), context);
    expect(response.status).toBe(200);
    expect(response.jsonBody).toMatchObject({ created: false, link: { assetId: 12, jobId: 7 } });
    expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
  });

  it("does not mistake some other duplicate-key error for 'already linked'", async () => {
    route([
      ...sameBuilding,
      {
        match: LINK,
        throws: Object.assign(new Error("Violation of PRIMARY KEY constraint 'PK_JobAssets'. Cannot insert duplicate key in object 'dbo.JobAssets'."), { number: 2627 }),
      },
    ]);
    const response = await linkJobAsset(post(BODY), context);
    expect(response.status).toBe(500);
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

  it("ends the link rather than deleting it, stamping who from the token and when", async () => {
    route([{ match: UNLINK, rows: [{ JobId: 7 }] }]);
    const response = await unlinkJobAsset(post({ ...BODY, unlinkedBy: "Mallory" }), context);
    expect(response.status).toBe(200);
    expect(response.jsonBody).toEqual({ assetId: 12, jobId: 7, unlinked: true });

    const [update] = queries(UNLINK);
    expect(paramsOf(update)).toEqual({ AssetId: 12, Caller: "Connor", JobId: 7 });
    expect(update[1]).toContain("SET UnlinkedAt = SYSUTCDATETIME(), UnlinkedBy = @Caller");
    expect(update[1]).toContain("UnlinkedAt IS NULL");
    expect((db.executeQuery.mock.calls as SqlCall[]).some(([, sql]) => /\bDELETE\b/i.test(sql))).toBe(false);
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

// A small model of dbo.JobAssets behind executeQuery. It applies "UnlinkedAt IS NULL"
// only to statements that say so, so a filter that goes missing from the SQL shows
// up here as wrong behaviour, not just as a changed string.
interface LinkRow {
  AssetId: number;
  JobId: number;
  LinkedAt: Date;
  LinkedBy: string;
  UnlinkedAt: Date | null;
  UnlinkedBy: string | null;
}

function modelJobAssets(): LinkRow[] {
  const table: LinkRow[] = [];
  let clock = Date.UTC(2026, 9, 13, 1, 0, 0);
  const tick = () => new Date((clock += 60_000));
  db.executeQuery.mockImplementation(async (_connection: unknown, sql: string, params: Array<{ name: string; value: unknown }> = []) => {
    const arg = Object.fromEntries(params.map((p) => [p.name, p.value]));
    const liveOnly = /UnlinkedAt IS NULL/.test(sql);
    const samePair = (row: LinkRow) =>
      row.JobId === arg.JobId && row.AssetId === arg.AssetId && (!liveOnly || row.UnlinkedAt === null);

    if (JOB.test(sql)) return [{ BuildingID: 1, JobID: 7 }];
    if (ASSET.test(sql)) return [{ ArchivedAt: null, AssetId: 12, BuildingId: 1 }];
    if (LINK.test(sql)) {
      if (table.some(samePair)) return [];
      const row: LinkRow = {
        AssetId: arg.AssetId as number,
        JobId: arg.JobId as number,
        LinkedAt: tick(),
        LinkedBy: arg.Caller as string,
        UnlinkedAt: null,
        UnlinkedBy: null,
      };
      table.push(row);
      return [{ LinkedAt: row.LinkedAt, LinkedBy: row.LinkedBy }];
    }
    if (EXISTING.test(sql)) return table.filter(samePair).slice(0, 1).map(({ LinkedAt, LinkedBy }) => ({ LinkedAt, LinkedBy }));
    if (UNLINK.test(sql)) {
      const hits = table.filter(samePair);
      for (const row of hits) {
        row.UnlinkedAt = tick();
        row.UnlinkedBy = arg.Caller as string;
      }
      return hits.map((row) => ({ JobId: row.JobId }));
    }
    return [];
  });
  return table;
}

describe("job-asset links over time", () => {
  const asSam = () => auth.verifiedIdentityFromRequest.mockResolvedValueOnce({ email: "s@rp.com", name: "Sam", oid: "oid-2" });

  it("keeps the row on unlink, says who ended it, and leaves it alone if unlinked again", async () => {
    const table = modelJobAssets();
    expect((await linkJobAsset(post(BODY), context)).jsonBody).toMatchObject({ created: true });

    asSam();
    expect((await unlinkJobAsset(post(BODY), context)).jsonBody).toEqual({ assetId: 12, jobId: 7, unlinked: true });
    expect(table).toHaveLength(1);
    expect(table[0]).toMatchObject({ LinkedBy: "Connor", UnlinkedBy: "Sam" });
    const endedAt = table[0].UnlinkedAt;
    expect(endedAt).toBeInstanceOf(Date);

    asSam();
    expect((await unlinkJobAsset(post(BODY), context)).jsonBody).toEqual({ assetId: 12, jobId: 7, unlinked: false });
    expect(table).toHaveLength(1);
    expect(table[0].UnlinkedAt).toBe(endedAt);
    expect(table[0].UnlinkedBy).toBe("Sam");
  });

  it("lets a pair be linked again after an unlink, as a fresh row beside the old one", async () => {
    const table = modelJobAssets();
    await linkJobAsset(post(BODY), context);
    await unlinkJobAsset(post(BODY), context);

    const relinked = await linkJobAsset(post(BODY), context);
    expect(relinked.status).toBe(200);
    expect(relinked.jsonBody).toMatchObject({ created: true, link: { assetId: 12, jobId: 7 } });
    expect(table.map((row) => row.UnlinkedAt !== null)).toEqual([true, false]);

    // Linking while a live link exists is still a no-op ...
    expect((await linkJobAsset(post(BODY), context)).jsonBody).toMatchObject({ created: false });
    expect(table).toHaveLength(2);

    // ... and the second life can be ended and restarted the same way, nothing ever removed.
    await unlinkJobAsset(post(BODY), context);
    await linkJobAsset(post(BODY), context);
    expect(table).toHaveLength(3);
    expect(table.map((row) => row.UnlinkedAt !== null)).toEqual([true, true, false]);
  });

  it("unlinks only the live row of a pair, never the history", async () => {
    const table = modelJobAssets();
    await linkJobAsset(post(BODY), context);
    asSam();
    await unlinkJobAsset(post(BODY), context);
    const firstEnded = table[0].UnlinkedAt;
    await linkJobAsset(post(BODY), context);

    await unlinkJobAsset(post(BODY), context);

    expect(table).toHaveLength(2);
    expect(table[0]).toMatchObject({ UnlinkedAt: firstEnded, UnlinkedBy: "Sam" });
    expect(table[1]).toMatchObject({ UnlinkedBy: "Connor" });
  });
});
