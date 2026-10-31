/// <reference types="jest" />
// B2 (review 2026-10-30): a completed inspection is never destroyed. Reopen
// stamps FirstCompletedAt and is ledgered; deleting a draft that was ever
// completed (or holds points or raised jobs) archives it instead.
import { HttpRequest, InvocationContext } from "@azure/functions";
import { clearRoleCache } from "../auth";
import { _resetRateLimitForTests } from "../rateLimit";
import {
  applyInspectionOps,
  completeInspection,
  deleteInspection,
  getInspection,
  getInspections,
  mergeInspections,
  revertInspection,
} from "./inspections";

jest.mock("../db", () => ({
  beginTransaction: jest.fn(),
  closeConnection: jest.fn(),
  commitTransaction: jest.fn(),
  createRequestConnection: jest.fn(),
  createServiceConnection: jest.fn(),
  executeQuery: jest.fn(),
  rollbackTransaction: jest.fn(),
}));

jest.mock("../blob-storage", () => ({
  deleteBlob: jest.fn(),
  generateReadSasUrl: jest.fn(() => "https://example.test/blob?sas"),
  uploadBlob: jest.fn(),
}));

const db = require("../db") as {
  commitTransaction: jest.Mock;
  createRequestConnection: jest.Mock;
  createServiceConnection: jest.Mock;
  executeQuery: jest.Mock;
  rollbackTransaction: jest.Mock;
};

const CALLER_OID = "oid-tester";

function makeJwt(payload: Record<string, unknown>): string {
  const encode = (obj: unknown) =>
    Buffer.from(JSON.stringify(obj)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${encode({ alg: "none" })}.${encode(payload)}.sig`;
}

function req(roles: string, body?: unknown): HttpRequest {
  const headers: Record<string, string> = {
    authorization: `Bearer ${makeJwt({ oid: CALLER_OID, name: "Test User", preferred_username: "t@example.com" })}`,
    "x-dev-roles": roles,
  };
  return {
    headers: { get: (key: string) => headers[key.toLowerCase()] ?? null },
    json: async () => body,
    query: { get: () => null },
  } as unknown as HttpRequest;
}

const ctx = (): InvocationContext => ({ error: jest.fn(), log: jest.fn(), warn: jest.fn() }) as unknown as InvocationContext;

type Row = Record<string, unknown>;
type SqlCall = [unknown, string, { name: string; value: unknown }[]];
const calls = (substr: string): SqlCall[] => (db.executeQuery.mock.calls as SqlCall[]).filter(([, sql]) => sql.includes(substr));
const paramsOf = (call: SqlCall): Record<string, unknown> => Object.fromEntries(call[2].map((p) => [p.name, p.value]));

/** Row as the locked in-transaction read returns it. */
function locked(overrides: Row = {}): Row {
  return {
    Id: 7, BuildingId: 10, Status: "draft", Revision: 4, CreatedById: CALLER_OID,
    CompletedAt: null, FirstCompletedAt: null, ArchivedAt: null, Points: 0, Levels: 0, OperationLogs: 0, MergeTargets: 0,
    RaisedJobs: 0, SourceJobs: 0,
    ...overrides,
  };
}

function mockDelete(lockedRow: Row): void {
  db.executeQuery.mockImplementation(async (_c: unknown, sql: string) => {
    if (sql.includes("SELECT Id, Status, CreatedById FROM dbo.Inspections")) {
      return [{ Id: 7, Status: "draft", CreatedById: CALLER_OID }];
    }
    if (sql.includes("WITH (UPDLOCK, HOLDLOCK)") && sql.includes("FROM dbo.Inspections")) return [lockedRow];
    return [];
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  clearRoleCache();
  _resetRateLimitForTests();
  db.createRequestConnection.mockResolvedValue({});
  db.createServiceConnection.mockResolvedValue({});
  db.rollbackTransaction.mockResolvedValue(undefined);
  process.env.DEV_ROLE_OVERRIDE_ENABLED = "true";
  process.env.AZURE_FUNCTIONS_ENVIRONMENT = "Development";
});

describe("deleteInspection archives anything that was relied on", () => {
  it("archives a reopened, once-completed draft: ArchivedAt set, nothing deleted, ledger row written", async () => {
    mockDelete(locked({ FirstCompletedAt: new Date("2026-10-01T00:00:00Z") }));

    const res = await deleteInspection(req("facilities", { InspectionId: 7 }), ctx());

    expect(res.status).toBe(200);
    expect(res.jsonBody).toEqual({ archived: true });
    const update = calls("ArchivedAt = SYSUTCDATETIME()");
    expect(update).toHaveLength(1);
    expect(update[0][1]).toContain("Revision = Revision + 1");
    expect(paramsOf(update[0])).toMatchObject({ Id: 7, ArchivedById: CALLER_OID, ArchivedByName: "Test User" });
    expect(calls("DELETE")).toHaveLength(0);
    const ledger = calls("INSERT INTO dbo.DecisionLedger");
    expect(ledger).toHaveLength(1);
    expect(paramsOf(ledger[0])).toMatchObject({ Action: "inspection.archive", SubjectType: "inspection", SubjectId: "7" });
    expect(db.commitTransaction).toHaveBeenCalled();
  });

  it("archives on CompletedAt alone (rows from before the backfill)", async () => {
    mockDelete(locked({ CompletedAt: new Date("2026-10-01T00:00:00Z") }));
    const res = await deleteInspection(req("facilities", { InspectionId: 7 }), ctx());
    expect(res.jsonBody).toEqual({ archived: true });
    expect(calls("DELETE")).toHaveLength(0);
  });

  it("archives a never-completed draft that has points", async () => {
    mockDelete(locked({ Points: 3 }));
    const res = await deleteInspection(req("facilities", { InspectionId: 7 }), ctx());
    expect(res.jsonBody).toEqual({ archived: true });
    expect(calls("DELETE")).toHaveLength(0);
  });

  it("archives a never-completed draft that has raised jobs", async () => {
    mockDelete(locked({ RaisedJobs: 1 }));
    const res = await deleteInspection(req("facilities", { InspectionId: 7 }), ctx());
    expect(res.jsonBody).toEqual({ archived: true });
    expect(calls("DELETE")).toHaveLength(0);
  });

  it.each([
    ["a level", { Levels: 1 }],
    ["an operation-log row only (completed then reopened before 181 on an empty inspection)", { OperationLogs: 2 }],
    ["a merge-source row where it is the target", { MergeTargets: 1 }],
    ["a job that names it as its source", { SourceJobs: 1 }],
  ])("archives a draft with %s", async (_label, extra) => {
    mockDelete(locked(extra));
    const res = await deleteInspection(req("facilities", { InspectionId: 7 }), ctx());
    expect(res.jsonBody).toEqual({ archived: true });
    expect(calls("DELETE")).toHaveLength(0);
  });

  it("counts all six reliance signals in the locked read", async () => {
    mockDelete(locked());
    await deleteInspection(req("facilities", { InspectionId: 7 }), ctx());
    const sql = calls("WITH (UPDLOCK, HOLDLOCK)")[0][1];
    for (const needle of ["dbo.InspectionLevels", "dbo.InspectionOperationLog", "dbo.InspectionMergeSources", "dbo.InspectionRaisedJobs", "dbo.Jobs", "SourceInspectionId"]) {
      expect(sql).toContain(needle);
    }
  });

  it("hard-deletes a never-completed empty draft, with a ledger row", async () => {
    mockDelete(locked());

    const res = await deleteInspection(req("facilities", { InspectionId: 7 }), ctx());

    expect(res.status).toBe(200);
    expect(res.jsonBody).toMatchObject({ archived: false });
    expect(calls("DELETE FROM dbo.Inspections")).toHaveLength(1);
    expect(calls("ArchivedAt = SYSUTCDATETIME()")).toHaveLength(0);
    const ledger = calls("INSERT INTO dbo.DecisionLedger");
    expect(ledger).toHaveLength(1);
    expect(paramsOf(ledger[0])).toMatchObject({ Action: "inspection.delete", SubjectId: "7" });
  });

  it("re-reads the row under UPDLOCK/HOLDLOCK inside the transaction", async () => {
    mockDelete(locked());
    await deleteInspection(req("facilities", { InspectionId: 7 }), ctx());
    expect(calls("FROM dbo.Inspections WITH (UPDLOCK, HOLDLOCK)").length).toBeGreaterThanOrEqual(1);
  });

  it("refuses when the row completed between the first read and the lock", async () => {
    mockDelete(locked({ Status: "complete", CompletedAt: new Date() }));
    const res = await deleteInspection(req("facilities", { InspectionId: 7 }), ctx());
    expect(res.status).toBe(400);
    expect(calls("DELETE")).toHaveLength(0);
    expect(calls("ArchivedAt = SYSUTCDATETIME()")).toHaveLength(0);
  });
});

describe("revertInspection (reopen)", () => {
  it("stamps FirstCompletedAt before clearing CompletedAt, and writes a ledger row", async () => {
    db.executeQuery.mockImplementation(async (_c: unknown, sql: string) => {
      if (sql.includes("SELECT CreatedById")) return [{ CreatedById: CALLER_OID }];
      if (sql.includes("WITH (UPDLOCK, HOLDLOCK)") && sql.includes("FROM dbo.Inspections")) {
        return [{ BuildingId: 10, CompletedAt: new Date("2026-10-01T00:00:00Z"), FirstCompletedAt: null, Status: "complete" }];
      }
      return [];
    });

    await revertInspection(req("facilities", { InspectionId: 7 }), ctx());

    const update = calls("CompletedAt = NULL");
    expect(update).toHaveLength(1);
    const sql = update[0][1];
    expect(sql).toContain("FirstCompletedAt = COALESCE(FirstCompletedAt, CompletedAt)");
    expect(sql.indexOf("FirstCompletedAt")).toBeLessThan(sql.indexOf("CompletedAt = NULL"));
    const ledger = calls("INSERT INTO dbo.DecisionLedger");
    expect(ledger).toHaveLength(1);
    expect(paramsOf(ledger[0])).toMatchObject({ Action: "inspection.reopen", SubjectType: "inspection", SubjectId: "7" });
  });

  it("records who completed it in the ledger 'before'", async () => {
    db.executeQuery.mockImplementation(async (_c: unknown, sql: string) => {
      if (sql.includes("SELECT CreatedById")) return [{ CreatedById: CALLER_OID, ArchivedAt: null }];
      if (sql.includes("WITH (UPDLOCK, HOLDLOCK)") && sql.includes("FROM dbo.Inspections")) {
        return [{ BuildingId: 10, CompletedAt: new Date("2026-10-01T00:00:00Z"), CompletedById: "oid-sam", CompletedByName: "Sam Completer", Status: "complete" }];
      }
      return [];
    });
    await revertInspection(req("facilities", { InspectionId: 7 }), ctx());
    const before = JSON.parse(paramsOf(calls("INSERT INTO dbo.DecisionLedger")[0]).Before as string);
    expect(before).toMatchObject({ completedById: "oid-sam", completedByName: "Sam Completer" });
  });
});

describe("an archived inspection stays archived (409 on every write)", () => {
  const ARCHIVED = new Date("2026-10-30T00:00:00Z");
  const MSG = { error: "This inspection has been archived." };

  it("refuses saved ops", async () => {
    db.executeQuery.mockImplementation(async (_c: unknown, sql: string) =>
      sql.includes("SELECT Revision, Status") ? [{ Revision: 1, Status: "draft", ArchivedAt: ARCHIVED }] : []);
    const op = { id: "o1", inspectionId: 7, createdAt: "", op: { type: "addLevel", levelId: "l1", name: "G", addedAt: "t", addedBy: { id: "u", name: "n" } } };
    const res = await applyInspectionOps(req("facilities", { inspectionId: 7, ops: [op] }), ctx());
    expect(res.status).toBe(409);
    expect(res.jsonBody).toEqual(MSG);
  });

  it("refuses complete", async () => {
    db.executeQuery.mockImplementation(async (_c: unknown, sql: string) =>
      sql.includes("SELECT Status") ? [{ Status: "draft", ArchivedAt: ARCHIVED }] : []);
    const res = await completeInspection(req("facilities", { InspectionId: 7 }), ctx());
    expect(res.status).toBe(409);
    expect(res.jsonBody).toEqual(MSG);
    expect(calls("SET Status = 'complete'")).toHaveLength(0);
  });

  it("refuses reopen", async () => {
    db.executeQuery.mockImplementation(async (_c: unknown, sql: string) =>
      sql.includes("SELECT CreatedById") ? [{ CreatedById: CALLER_OID, ArchivedAt: ARCHIVED }] : []);
    const res = await revertInspection(req("facilities", { InspectionId: 7 }), ctx());
    expect(res.status).toBe(409);
    expect(res.jsonBody).toEqual(MSG);
  });

  it("refuses a merge that includes it as a source", async () => {
    db.executeQuery.mockImplementation(async (_c: unknown, sql: string) =>
      sql.includes("WITH (UPDLOCK, HOLDLOCK) WHERE Id IN")
        ? [
            { Id: 7, BuildingId: 10, Status: "draft", CreatedById: CALLER_OID, ArchivedAt: ARCHIVED },
            { Id: 8, BuildingId: 10, Status: "draft", CreatedById: CALLER_OID, ArchivedAt: null },
          ]
        : []);
    const res = await mergeInspections(req("facilities", { SourceIds: [7, 8] }), ctx());
    expect(res.status).toBe(409);
    expect(res.jsonBody).toEqual(MSG);
  });
});

describe("reading an archived inspection by id", () => {
  it("returns archivedAt, who archived it and firstCompletedAt", async () => {
    db.executeQuery.mockImplementation(async (_c: unknown, sql: string) =>
      sql.includes("JOIN dbo.Buildings b")
        ? [{
            Id: 7, BuildingId: 10, BuildingName: "HQ", Title: null, Status: "draft", Revision: 5,
            CreatedAt: new Date("2026-07-01T00:00:00Z"), CreatedById: CALLER_OID, CreatedByName: "Test User",
            LastModifiedAt: new Date("2026-07-01T00:00:00Z"), CompletedAt: null, CompletedById: null, CompletedByName: null,
            MergedIntoId: null, IsTest: 0,
            ArchivedAt: new Date("2026-10-30T01:00:00Z"), ArchivedById: "oid-a", ArchivedByName: "Ada Archiver",
            FirstCompletedAt: new Date("2026-10-01T00:00:00Z"),
          }]
        : []);
    const res = await getInspection({ ...req("facilities"), query: { get: () => "7" } } as unknown as HttpRequest, ctx());
    const insp = (res.jsonBody as { inspection: Record<string, unknown> }).inspection;
    expect(insp.archivedAt).toBe("2026-10-30T01:00:00.000Z");
    expect(insp.archivedBy).toEqual({ id: "oid-a", name: "Ada Archiver" });
    expect(insp.firstCompletedAt).toBe("2026-10-01T00:00:00.000Z");
  });
});

describe("getInspections hides archived rows", () => {
  it("filters ArchivedAt IS NULL in the list query", async () => {
    db.executeQuery.mockResolvedValue([]);
    await getInspections(req("facilities"), ctx());
    const list = calls("JOIN dbo.Buildings b");
    expect(list).toHaveLength(1);
    expect(list[0][1]).toContain("i.ArchivedAt IS NULL");
  });
});

describe("migration 181", () => {
  const sql = require("node:fs").readFileSync(require("node:path").join(__dirname, "../../migrations/181_inspections_archive.sql"), "utf8") as string;
  it("is additive: column-guarded adds and a NULL-only backfill, nothing destructive", () => {
    for (const col of ["ArchivedAt", "ArchivedById", "ArchivedByName", "FirstCompletedAt"]) {
      expect(sql).toContain(`IF COL_LENGTH(N'dbo.Inspections', N'${col}') IS NULL`);
    }
    expect(sql).toContain("WHERE FirstCompletedAt IS NULL AND CompletedAt IS NOT NULL");
    expect(sql).not.toMatch(/\b(DROP|TRUNCATE|DELETE)\b/i);
    expect(sql).toContain("PRINT CONCAT(N'181: FirstCompletedAt backfilled rows: ', @@ROWCOUNT);");
    expect(sql.indexOf("PRINT")).toBeGreaterThan(sql.indexOf("EXEC(N'UPDATE"));
  });
});
