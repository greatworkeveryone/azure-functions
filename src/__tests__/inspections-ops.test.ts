/// <reference types="jest" />
// Handler-level tests for the inspections review-finding fixes. The DB and
// blob layers are mocked; auth flows through the real requireRole /
// verifiedIdentityFromRequest paths using the dev-override header + an
// unsigned JWT (same harness as inspections-auth.test.ts).
import { HttpRequest, InvocationContext } from "@azure/functions";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { clearRoleCache } from "../auth";
import { _resetRateLimitForTests } from "../rateLimit";
import { OpRefusal } from "../inspectionLimits";
import { REMOVAL_ROW_BUDGET_BYTES } from "../inspectionRemovalLedger";
import { LEDGER_MAX_SNAPSHOT_BYTES } from "../ledger";
import {
  applyInspectionOps,
  completeInspection,
  deleteInspection,
  getInspections,
  isValidInspectionBlobName,
  mergeInspections,
  opRejectionReason,
  raiseJobsFromInspection,
  uploadInspectionAttachment,
} from "../functions/inspections";

jest.mock("../db", () => ({
  beginTransaction:        jest.fn(),
  closeConnection:         jest.fn(),
  commitTransaction:       jest.fn(),
  createRequestConnection:        jest.fn(),
  createServiceConnection: jest.fn(),
  executeQuery:            jest.fn(),
  rollbackTransaction:     jest.fn(),
}));

jest.mock("../blob-storage", () => ({
  deleteBlob:         jest.fn(),
  generateReadSasUrl: jest.fn(() => "https://example.test/blob?sas"),
  uploadBlob:         jest.fn(),
}));

const db = require("../db") as {
  beginTransaction:        jest.Mock;
  closeConnection:         jest.Mock;
  commitTransaction:       jest.Mock;
  createRequestConnection:        jest.Mock;
  createServiceConnection: jest.Mock;
  executeQuery:            jest.Mock;
  rollbackTransaction:     jest.Mock;
};

const blob = require("../blob-storage") as {
  deleteBlob: jest.Mock;
  uploadBlob: jest.Mock;
};

// ── Harness ──────────────────────────────────────────────────────────────────

function makeJwt(payload: Record<string, unknown>): string {
  const encode = (obj: unknown) =>
    Buffer.from(JSON.stringify(obj))
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  return `${encode({ alg: "none" })}.${encode(payload)}.sig`;
}

const CALLER_OID = "oid-tester";

function authHeaders(roles: string, oid: string = CALLER_OID): Record<string, string> {
  return {
    authorization: `Bearer ${makeJwt({ oid, name: "Test User", preferred_username: "t@example.com" })}`,
    "x-dev-roles": roles,
  };
}

interface FakeFile {
  arrayBuffer: () => Promise<ArrayBuffer>;
  name: string;
  size: number;
  type: string;
}

interface RequestOpts {
  body?: unknown;
  file?: FakeFile | null;
  headers: Record<string, string>;
}

function makeRequest(opts: RequestOpts): HttpRequest {
  return {
    headers: { get: (key: string) => opts.headers[key.toLowerCase()] ?? null },
    json: async () => opts.body,
    formData: async () => ({ get: () => opts.file ?? null }),
    query: { get: () => null },
  } as unknown as HttpRequest;
}

function makeContext(): InvocationContext {
  return {
    error: jest.fn(),
    log:   jest.fn(),
    warn:  jest.fn(),
  } as unknown as InvocationContext;
}

type Row = Record<string, unknown>;

/** Routes executeQuery calls by SQL substring; unmatched queries return []. */
function mockDb(routes: { match: string; rows: Row[] }[]): void {
  db.executeQuery.mockImplementation(async (_conn: unknown, sql: string) => {
    for (const r of routes) {
      if (sql.includes(r.match)) return r.rows;
    }
    return [];
  });
}

type SqlCall = [unknown, string, { name: string; value: unknown }[]];

function callsMatching(substr: string): SqlCall[] {
  return (db.executeQuery.mock.calls as SqlCall[]).filter(([, sql]) => sql.includes(substr));
}

function inspectionRow(overrides: Row = {}): Row {
  return {
    Id: 7,
    BuildingId: 10,
    BuildingName: "HQ",
    Title: null,
    Status: "draft",
    Revision: 1,
    CreatedAt: new Date("2026-07-01T00:00:00Z"),
    CreatedById: CALLER_OID,
    CreatedByName: "Test User",
    LastModifiedAt: new Date("2026-07-01T00:00:00Z"),
    CompletedAt: null,
    CompletedById: null,
    CompletedByName: null,
    MergedIntoId: null,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  clearRoleCache();
  _resetRateLimitForTests();
  db.createRequestConnection.mockResolvedValue({});
  db.createServiceConnection.mockResolvedValue({});
  db.beginTransaction.mockResolvedValue(undefined);
  db.commitTransaction.mockResolvedValue(undefined);
  db.rollbackTransaction.mockResolvedValue(undefined);
  process.env.DEV_ROLE_OVERRIDE_ENABLED = "true";
  process.env.AZURE_FUNCTIONS_ENVIRONMENT = "Development";
});

// ── F3: applyInspectionOps status gate ───────────────────────────────────────

describe("applyInspectionOps status gate (F3)", () => {
  const op = { id: "op-1", inspectionId: 7, createdAt: "2026-07-01T00:00:00Z", op: { type: "updateInspection", patch: { title: "x" } } };

  it("returns 409 'Inspection is not editable' for a completed inspection", async () => {
    mockDb([{ match: "WITH (UPDLOCK, HOLDLOCK) WHERE Id = @Id", rows: [{ Revision: 3, Status: "complete" }] }]);

    const res = await applyInspectionOps(
      makeRequest({ headers: authHeaders("facilities"), body: { inspectionId: 7, ops: [op] } }),
      makeContext(),
    );

    expect(res.status).toBe(409);
    expect(res.jsonBody).toEqual({ error: "Inspection is not editable" });
    expect(db.rollbackTransaction).toHaveBeenCalled();
    expect(callsMatching("INSERT INTO dbo.InspectionOperationLog")).toHaveLength(0);
  });

  it("returns 404 when the inspection does not exist (even without baseRevision)", async () => {
    mockDb([{ match: "WITH (UPDLOCK, HOLDLOCK) WHERE Id = @Id", rows: [] }]);

    const res = await applyInspectionOps(
      makeRequest({ headers: authHeaders("facilities"), body: { inspectionId: 7, ops: [op] } }),
      makeContext(),
    );

    expect(res.status).toBe(404);
  });
});

// ── F13: ops cap + inspection-scoped replay check ────────────────────────────

describe("applyInspectionOps batching (F13)", () => {
  it("rejects a batch of more than 200 ops with 400", async () => {
    const ops = Array.from({ length: 201 }, (_, i) => ({
      id: `op-${i}`, inspectionId: 7, createdAt: "", op: { type: "updateInspection", patch: { title: "x" } },
    }));

    const res = await applyInspectionOps(
      makeRequest({ headers: authHeaders("facilities"), body: { inspectionId: 7, ops } }),
      makeContext(),
    );

    expect(res.status).toBe(400);
    expect(db.beginTransaction).not.toHaveBeenCalled();
  });

  it("scopes the idempotency replay check to the inspection", async () => {
    mockDb([
      { match: "WITH (UPDLOCK, HOLDLOCK) WHERE Id = @Id", rows: [{ Revision: 1, Status: "draft" }] },
      { match: "OUTPUT INSERTED.Revision", rows: [{ Revision: 2 }] },
    ]);

    const res = await applyInspectionOps(
      makeRequest({
        headers: authHeaders("facilities"),
        body: { inspectionId: 7, baseRevision: 1, ops: [{ id: "op-1", inspectionId: 7, createdAt: "", op: { type: "updateInspection", patch: { title: "Lobby walk" } } }] },
      }),
      makeContext(),
    );

    expect(res.status).toBe(200);
    expect(res.jsonBody).toMatchObject({ applied: ["op-1"], revision: 2 });

    const replayChecks = callsMatching("FROM dbo.InspectionOperationLog WHERE");
    expect(replayChecks).toHaveLength(1);
    const [, sql, params] = replayChecks[0];
    expect(sql).toContain("InspectionId = @InspectionId");
    expect(params.map((p) => p.name)).toEqual(expect.arrayContaining(["OpId", "InspectionId"]));
  });
});

// ── F14: updateInspection op (title) ─────────────────────────────────────────

describe("applyInspectionOps updateInspection op (F14)", () => {
  function opsBody(patch: unknown) {
    return { inspectionId: 7, ops: [{ id: "op-1", inspectionId: 7, createdAt: "", op: { type: "updateInspection", patch } }] };
  }

  function draftDb(): void {
    mockDb([
      { match: "WITH (UPDLOCK, HOLDLOCK) WHERE Id = @Id", rows: [{ Revision: 1, Status: "draft" }] },
      { match: "OUTPUT INSERTED.Revision", rows: [{ Revision: 2 }] },
    ]);
  }

  it("updates the title with a trimmed string", async () => {
    draftDb();
    const res = await applyInspectionOps(
      makeRequest({ headers: authHeaders("facilities"), body: opsBody({ title: "  Lobby walk  " }) }),
      makeContext(),
    );

    expect(res.status).toBe(200);
    expect(res.jsonBody).toMatchObject({ applied: ["op-1"] });
    const updates = callsMatching("SET Title = @Title");
    expect(updates).toHaveLength(1);
    const [, , params] = updates[0];
    expect(params.find((p) => p.name === "Title")?.value).toBe("Lobby walk");
    expect(params.find((p) => p.name === "InspectionId")?.value).toBe(7);
  });

  it("clears the title when patch.title is explicitly null", async () => {
    draftDb();
    const res = await applyInspectionOps(
      makeRequest({ headers: authHeaders("facilities"), body: opsBody({ title: null }) }),
      makeContext(),
    );

    expect(res.status).toBe(200);
    expect(res.jsonBody).toMatchObject({ applied: ["op-1"] });
    const updates = callsMatching("SET Title = @Title");
    expect(updates).toHaveLength(1);
    expect(updates[0][2].find((p) => p.name === "Title")?.value).toBeNull();
  });

  it("rejects a non-string, non-null title", async () => {
    draftDb();
    const res = await applyInspectionOps(
      makeRequest({ headers: authHeaders("facilities"), body: opsBody({ title: 42 }) }),
      makeContext(),
    );

    expect(res.status).toBe(200);
    const bodyOut = res.jsonBody as { applied: string[]; rejected?: { id: string; reason: string }[] };
    expect(bodyOut.applied).toEqual([]);
    expect(bodyOut.rejected).toHaveLength(1);
    expect(callsMatching("SET Title = @Title")).toHaveLength(0);
  });

  it("rejects a title longer than the 200-char column", async () => {
    draftDb();
    const res = await applyInspectionOps(
      makeRequest({ headers: authHeaders("facilities"), body: opsBody({ title: "x".repeat(201) }) }),
      makeContext(),
    );

    const bodyOut = res.jsonBody as { applied: string[]; rejected?: { id: string; reason: string }[] };
    expect(bodyOut.rejected).toHaveLength(1);
    expect(callsMatching("SET Title = @Title")).toHaveLength(0);
  });
});

// ── F1: addAttachment blobName validation ────────────────────────────────────

describe("isValidInspectionBlobName (F1)", () => {
  const uuid = "6f9619ff-8b86-4d01-b42d-00cf4fc964ff";

  it("accepts the exact minted format with an extension", () => {
    expect(isValidInspectionBlobName(`inspections/${uuid}.jpg`)).toBe(true);
  });

  it("accepts the minted format without an extension", () => {
    expect(isValidInspectionBlobName(`inspections/${uuid}`)).toBe(true);
  });

  it("rejects other prefixes, traversal, extra segments and double extensions", () => {
    expect(isValidInspectionBlobName(`attachments/jobs/3/${uuid}.png`)).toBe(false);
    expect(isValidInspectionBlobName(`inspections/../${uuid}.pdf`)).toBe(false);
    expect(isValidInspectionBlobName(`inspections/${uuid}.jpg/extra`)).toBe(false);
    expect(isValidInspectionBlobName(`inspections/${uuid}.tar.gz`)).toBe(false);
    expect(isValidInspectionBlobName("inspections/not-a-uuid.jpg")).toBe(false);
    expect(isValidInspectionBlobName(42)).toBe(false);
    expect(isValidInspectionBlobName(undefined)).toBe(false);
  });

  it("rejects an addAttachment op whose blobName is not a minted inspection blob", async () => {
    mockDb([
      { match: "WITH (UPDLOCK, HOLDLOCK) WHERE Id = @Id", rows: [{ Revision: 1, Status: "draft" }] },
      { match: "OUTPUT INSERTED.Revision", rows: [{ Revision: 2 }] },
    ]);

    const res = await applyInspectionOps(
      makeRequest({
        headers: authHeaders("facilities"),
        body: {
          inspectionId: 7,
          ops: [{
            id: "op-1", inspectionId: 7, createdAt: "",
            op: { type: "addAttachment", attachmentId: "a1", pointId: "p1", blobName: "attachments/jobs/9/evil.png", fileName: "evil.png", uploadedAt: "" },
          }],
        },
      }),
      makeContext(),
    );

    const bodyOut = res.jsonBody as { applied: string[]; rejected?: { id: string; reason: string }[] };
    expect(bodyOut.applied).toEqual([]);
    expect(bodyOut.rejected).toHaveLength(1);
    expect(callsMatching("INSERT INTO dbo.InspectionAttachments")).toHaveLength(0);
  });
});

// ── F12: rejection reasons don't leak raw DB errors in production ────────────

describe("opRejectionReason (F12)", () => {
  it("passes the real message through when the dev override is enabled", () => {
    expect(opRejectionReason(new Error("Violation of UNIQUE KEY constraint"))).toBe(
      "Violation of UNIQUE KEY constraint",
    );
  });

  it("returns a generic reason in production", () => {
    process.env.AZURE_FUNCTIONS_ENVIRONMENT = "Production";
    expect(opRejectionReason(new Error("Violation of UNIQUE KEY constraint"))).toBe(
      "Operation could not be applied",
    );
  });
});

// ── F11: completeInspection existence / status handling ─────────────────────

describe("completeInspection (F11)", () => {
  it("returns 404 for a nonexistent inspection", async () => {
    mockDb([{ match: "SELECT Status FROM dbo.Inspections", rows: [] }]);

    const res = await completeInspection(
      makeRequest({ headers: authHeaders("facilities"), body: { InspectionId: 7 } }),
      makeContext(),
    );

    expect(res.status).toBe(404);
  });

  it("returns 400 for a merged inspection", async () => {
    mockDb([{ match: "SELECT Status FROM dbo.Inspections", rows: [{ Status: "merged" }] }]);

    const res = await completeInspection(
      makeRequest({ headers: authHeaders("facilities"), body: { InspectionId: 7 } }),
      makeContext(),
    );

    expect(res.status).toBe(400);
    expect(callsMatching("SET Status = 'complete'")).toHaveLength(0);
  });

  it("is idempotent for an already-complete inspection", async () => {
    mockDb([
      { match: "SELECT Status FROM dbo.Inspections", rows: [{ Status: "complete" }] },
      { match: "JOIN dbo.Buildings b", rows: [inspectionRow({ Status: "complete", CompletedAt: new Date(), CompletedById: CALLER_OID, CompletedByName: "Test User" })] },
    ]);

    const res = await completeInspection(
      makeRequest({ headers: authHeaders("facilities"), body: { InspectionId: 7 } }),
      makeContext(),
    );

    expect(res.status).toBe(200);
    expect((res.jsonBody as { inspection: { status: string } }).inspection.status).toBe("complete");
    expect(callsMatching("SET Status = 'complete'")).toHaveLength(0);
  });

  it("completes a draft inspection", async () => {
    mockDb([
      { match: "SELECT Status FROM dbo.Inspections", rows: [{ Status: "draft" }] },
      { match: "JOIN dbo.Buildings b", rows: [inspectionRow({ Status: "complete" })] },
    ]);

    const res = await completeInspection(
      makeRequest({ headers: authHeaders("facilities"), body: { InspectionId: 7 } }),
      makeContext(),
    );

    expect(res.status).toBe(200);
    expect(callsMatching("SET Status = 'complete'")).toHaveLength(1);
  });
});

// ── F6 + F5: deleteInspection role gate + merge-target unblocking ────────────

describe("deleteInspection gate (F6) and merge-target handling (F5)", () => {
  function deletableRow(createdById: string): { match: string; rows: Row[] } {
    return { match: "SELECT Id, Status, CreatedById FROM dbo.Inspections", rows: [{ Id: 7, Status: "draft", CreatedById: createdById }] };
  }

  it("lets a DIRECTOR delete an inspection they did not create", async () => {
    mockDb([deletableRow("someone-else")]);

    const res = await deleteInspection(
      makeRequest({ headers: authHeaders("director"), body: { InspectionId: 7 } }),
      makeContext(),
    );

    expect(res.status).toBe(200);
    expect(res.jsonBody).toEqual({ deleted: true });
    expect(db.commitTransaction).toHaveBeenCalled();
  });

  it("blocks a base FACILITIES user from deleting someone else's inspection", async () => {
    mockDb([deletableRow("someone-else")]);

    const res = await deleteInspection(
      makeRequest({ headers: authHeaders("facilities"), body: { InspectionId: 7 } }),
      makeContext(),
    );

    expect(res.status).toBe(403);
    expect(callsMatching("DELETE FROM dbo.Inspections")).toHaveLength(0);
  });

  it("lets a base FACILITIES user delete their own inspection", async () => {
    mockDb([deletableRow(CALLER_OID)]);

    const res = await deleteInspection(
      makeRequest({ headers: authHeaders("facilities"), body: { InspectionId: 7 } }),
      makeContext(),
    );

    expect(res.status).toBe(200);
  });

  it("detaches merged husks (MergedIntoId → NULL, back to draft) before the root delete", async () => {
    mockDb([deletableRow(CALLER_OID)]);

    await deleteInspection(
      makeRequest({ headers: authHeaders("facilities"), body: { InspectionId: 7 } }),
      makeContext(),
    );

    const detach = callsMatching("SET MergedIntoId = NULL");
    expect(detach).toHaveLength(1);
    expect(detach[0][1]).toContain("Status = 'draft'");
    expect(detach[0][1]).toContain("WHERE MergedIntoId = @Id");
  });
});

// ── F7: uploadInspectionAttachment content-type enforcement ──────────────────

describe("uploadInspectionAttachment content types (F7)", () => {
  it("rejects a disallowed content type with 415 and does not upload", async () => {
    const res = await uploadInspectionAttachment(
      makeRequest({
        headers: authHeaders("facilities"),
        file: { arrayBuffer: async () => new ArrayBuffer(4), name: "run.exe", size: 10, type: "application/x-msdownload" },
      }),
      makeContext(),
    );

    expect(res.status).toBe(415);
    expect(blob.uploadBlob).not.toHaveBeenCalled();
  });

  it("still accepts an image", async () => {
    blob.uploadBlob.mockResolvedValue({ blobName: "inspections/6f9619ff-8b86-4d01-b42d-00cf4fc964ff.jpg", url: "https://example.test" });

    const res = await uploadInspectionAttachment(
      makeRequest({
        headers: authHeaders("facilities"),
        file: { arrayBuffer: async () => new ArrayBuffer(4), name: "photo.jpg", size: 10, type: "image/jpeg" },
      }),
      makeContext(),
    );

    expect(res.status).toBe(200);
    expect(blob.uploadBlob).toHaveBeenCalledWith(expect.anything(), "photo.jpg", "image/jpeg", "inspections");
  });
});

// ── F8 + F4: mergeInspections ownership gate + raised-job re-parenting ───────

describe("mergeInspections (F8 ownership, F4 re-parenting)", () => {
  function sourceRows(createdByFirst: string, createdBySecond: string): { match: string; rows: Row[] } {
    return {
      match: "WITH (UPDLOCK, HOLDLOCK) WHERE Id IN",
      rows: [
        { Id: 1, BuildingId: 10, Status: "draft", CreatedById: createdByFirst },
        { Id: 2, BuildingId: 10, Status: "draft", CreatedById: createdBySecond },
      ],
    };
  }

  it("blocks a base FACILITIES user from merging drafts they did not all create", async () => {
    mockDb([sourceRows("someone-else", CALLER_OID)]);

    const res = await mergeInspections(
      makeRequest({ headers: authHeaders("facilities"), body: { SourceIds: [1, 2] } }),
      makeContext(),
    );

    expect(res.status).toBe(403);
    expect(db.rollbackTransaction).toHaveBeenCalled();
    expect(callsMatching("INSERT INTO dbo.Inspections")).toHaveLength(0);
  });

  it("re-parents InspectionRaisedJobs and Jobs.SourceInspectionId onto the merge target", async () => {
    mockDb([
      sourceRows(CALLER_OID, CALLER_OID),
      { match: "OUTPUT INSERTED.Id", rows: [{ Id: 99 }] },
      { match: "JOIN dbo.Buildings b", rows: [inspectionRow({ Id: 99, Title: "Merged" })] },
      { match: "SELECT SourceInspectionId FROM dbo.InspectionMergeSources", rows: [{ SourceInspectionId: 1 }, { SourceInspectionId: 2 }] },
    ]);

    const res = await mergeInspections(
      makeRequest({ headers: authHeaders("facilities"), body: { SourceIds: [1, 2], Title: "Merged" } }),
      makeContext(),
    );

    expect(res.status).toBe(200);

    const linkUpdates = callsMatching("UPDATE dbo.InspectionRaisedJobs SET InspectionId = @TargetId");
    expect(linkUpdates).toHaveLength(1);
    expect(linkUpdates[0][2].find((p) => p.name === "TargetId")?.value).toBe(99);

    const jobUpdates = callsMatching("UPDATE dbo.Jobs SET SourceInspectionId = @TargetId");
    expect(jobUpdates).toHaveLength(1);
    expect(jobUpdates[0][2].find((p) => p.name === "TargetId")?.value).toBe(99);
    expect(jobUpdates[0][1]).toContain("WHERE SourceInspectionId IN");
  });
});

// ── F15: raiseJobsFromInspection status gate + Mode validation ───────────────

describe("raiseJobsFromInspection input gates (F15)", () => {
  it("refuses to raise jobs from a draft inspection", async () => {
    mockDb([{ match: "JOIN dbo.Buildings b", rows: [inspectionRow({ Status: "draft" })] }]);

    const res = await raiseJobsFromInspection(
      makeRequest({
        headers: authHeaders("facilities"),
        body: { InspectionId: 7, PointIds: ["p1"], Defaults: { JobType: "Repair", Priority: "P2" } },
      }),
      makeContext(),
    );

    expect(res.status).toBe(400);
    expect((res.jsonBody as { error: string }).error).toMatch(/completed/i);
  });

  it("rejects an unknown Mode instead of silently coercing it", async () => {
    const res = await raiseJobsFromInspection(
      makeRequest({
        headers: authHeaders("facilities"),
        body: { InspectionId: 7, PointIds: ["p1"], Mode: "bulk", Defaults: { JobType: "Repair", Priority: "P2" } },
      }),
      makeContext(),
    );

    expect(res.status).toBe(400);
    expect((res.jsonBody as { error: string }).error).toMatch(/Mode/);
  });
});

// ── D9 / IN1: raiseJobsFromInspection is idempotent and photo-aware ─────────

describe("raiseJobsFromInspection idempotency (D9)", () => {
  const WHEN = new Date("2026-07-01T00:00:00Z");

  interface RaiseFixtureOpts {
    /** Points that already have an InspectionRaisedJobs link. */
    linked?: string[];
    rooms?: Row[];
    points?: Row[];
    attachments?: Row[];
  }

  function point(id: string, roomId: string, description: string): Row {
    return {
      Id: id, RoomId: roomId, Description: description, AddedAt: WHEN, AddedById: "u", AddedByName: "Sam",
      LastModifiedAt: WHEN, SortOrder: 0,
    };
  }

  /** A completed inspection (one level) whose points come from the options. */
  function wireInspection(opts: RaiseFixtureOpts = {}): { jobsInserted: () => number } {
    let nextJobId = 500;
    const linked = opts.linked ?? [];
    const rooms = opts.rooms ?? [
      { Id: "room-1", LevelId: "lvl-1", Name: "Plant room", Description: null, AddedAt: WHEN, AddedById: "u", AddedByName: "Sam", SortOrder: 0 },
    ];
    const points = opts.points ?? [
      point("pt-a", "room-1", "Leaking valve"),
      point("pt-b", "room-1", "Rusted bracket"),
      point("pt-photo", "room-1", ""),
    ];
    const attachments = opts.attachments ?? [
      { Id: "att-1", PointId: "pt-photo", BlobName: "inspections/aaa", FileName: "crack.jpg", UploadedAt: WHEN, UploadedById: "u", UploadedByName: "Sam" },
    ];
    db.executeQuery.mockImplementation(async (_conn: unknown, sql: string) => {
      if (sql.includes("JOIN dbo.Buildings b")) return [inspectionRow({ Status: "complete", CompletedAt: WHEN })];
      if (sql.includes("FROM dbo.InspectionLevels")) return [{ Id: "lvl-1", Name: "Ground floor", AddedAt: WHEN, SortOrder: 0 }];
      if (sql.includes("FROM dbo.InspectionLevelContributors")) return [];
      if (sql.includes("FROM dbo.InspectionRooms")) return rooms;
      if (sql.includes("FROM dbo.InspectionPoints")) return points;
      if (sql.includes("SELECT Id, PointId, BlobName")) return attachments;
      // The idempotency read (under the inspection-row lock) vs loadInspection's own read.
      if (sql.includes("SELECT DISTINCT PointId FROM dbo.InspectionRaisedJobs")) return linked.map((PointId) => ({ PointId }));
      if (sql.includes("SELECT PointId, JobId FROM dbo.InspectionRaisedJobs")) return linked.map((PointId) => ({ PointId, JobId: 1 }));
      if (sql.includes("SELECT SourceInspectionId")) return [];
      if (sql.includes("WITH (UPDLOCK, HOLDLOCK) WHERE Id = @Id")) return [{ Status: "complete" }];
      if (sql.includes("INSERT INTO dbo.Jobs")) return [{ JobID: nextJobId++ }];
      return [];
    });
    return { jobsInserted: () => callsMatching("INSERT INTO dbo.Jobs").length };
  }

  function raise(pointIds: string[], extra: Record<string, unknown> = {}) {
    return raiseJobsFromInspection(
      makeRequest({
        headers: authHeaders("facilities"),
        body: { InspectionId: 7, PointIds: pointIds, Defaults: { JobType: "Repair", Priority: "Normal" }, ...extra },
      }),
      makeContext(),
    );
  }

  type RaiseOut = { jobs: { jobId: number; pointIds: string[] }[]; pointIds: string[]; skippedPointIds: string[] };

  it("skips points that already have a job and raises only the rest", async () => {
    const fixture = wireInspection({ linked: ["pt-a"] });

    const res = await raise(["pt-a", "pt-b"]);

    expect(res.status).toBe(200);
    const out = res.jsonBody as RaiseOut;
    expect(out.skippedPointIds).toEqual(["pt-a"]);
    expect(out.pointIds).toEqual(["pt-b"]);
    expect(out.jobs).toEqual([{ jobId: 500, pointIds: ["pt-b"] }]);
    expect(fixture.jobsInserted()).toBe(1);

    const links = callsMatching("INSERT INTO dbo.InspectionRaisedJobs");
    expect(links).toHaveLength(1);
    expect(links[0][2].find((param) => param.name === "PointId")?.value).toBe("pt-b");
    expect(db.commitTransaction).toHaveBeenCalled();
  });

  it("creates no job at all when every selected point already has one (a retry after a lost response)", async () => {
    const fixture = wireInspection({ linked: ["pt-a", "pt-b"] });

    const res = await raise(["pt-a", "pt-b"]);

    expect(res.status).toBe(200);
    const out = res.jsonBody as RaiseOut;
    expect(out.jobs).toEqual([]);
    expect(out.pointIds).toEqual([]);
    expect(out.skippedPointIds).toEqual(["pt-a", "pt-b"]);
    expect(fixture.jobsInserted()).toBe(0);
    expect(callsMatching("INSERT INTO dbo.JobEvents")).toHaveLength(0);
    expect(callsMatching("INSERT INTO dbo.InspectionRaisedJobs")).toHaveLength(0);
  });

  it("reports an empty skipped list when nothing was already raised", async () => {
    wireInspection({ linked: [] });
    const out = (await raise(["pt-a", "pt-b"])).jsonBody as RaiseOut;
    expect(out.skippedPointIds).toEqual([]);
    expect(out.jobs).toHaveLength(2);
    expect(out.pointIds).toEqual(["pt-a", "pt-b"]);
  });

  it("raises one job, not two, for a point repeated in the request", async () => {
    const fixture = wireInspection();
    const out = (await raise(["pt-a", "pt-a"])).jsonBody as RaiseOut;
    expect(out.jobs).toHaveLength(1);
    expect(fixture.jobsInserted()).toBe(1);
  });

  it("per-room: skips the already-raised point but still raises the room's other points as one job", async () => {
    const fixture = wireInspection({ linked: ["pt-a"] });

    const out = (await raise(["pt-a", "pt-b", "pt-photo"], { Mode: "per-room" })).jsonBody as RaiseOut;

    expect(out.skippedPointIds).toEqual(["pt-a"]);
    expect(out.jobs).toEqual([{ jobId: 500, pointIds: ["pt-b", "pt-photo"] }]);
    expect(fixture.jobsInserted()).toBe(1);
    const description = callsMatching("INSERT INTO dbo.Jobs")[0][2].find((param) => param.name === "Description")?.value;
    expect(description).toBe("• Rusted bracket\n• (photo only)");
  });

  it("serialises concurrent raisers: reads the existing links under an UPDLOCK taken inside the transaction", async () => {
    wireInspection();

    await raise(["pt-a"]);

    const lock = callsMatching("WITH (UPDLOCK, HOLDLOCK) WHERE Id = @Id");
    expect(lock).toHaveLength(1);
    const linkRead = callsMatching("SELECT DISTINCT PointId FROM dbo.InspectionRaisedJobs");
    expect(linkRead).toHaveLength(1);

    const calls = db.executeQuery.mock.calls as SqlCall[];
    const order = db.executeQuery.mock.invocationCallOrder;
    const orderOf = (sql: string) => order[calls.findIndex(([, text]) => text.includes(sql))];
    expect(db.beginTransaction.mock.invocationCallOrder[0]).toBeLessThan(orderOf("WITH (UPDLOCK, HOLDLOCK) WHERE Id = @Id"));
    expect(orderOf("WITH (UPDLOCK, HOLDLOCK) WHERE Id = @Id")).toBeLessThan(orderOf("SELECT DISTINCT PointId FROM dbo.InspectionRaisedJobs"));
    expect(orderOf("SELECT DISTINCT PointId FROM dbo.InspectionRaisedJobs")).toBeLessThan(orderOf("INSERT INTO dbo.Jobs"));
  });

  it("refuses (and rolls back) when the inspection was reopened between the load and the lock", async () => {
    wireInspection();
    const base = db.executeQuery.getMockImplementation()!;
    db.executeQuery.mockImplementation(async (conn: unknown, sql: string, params: unknown) => {
      if (sql.includes("WITH (UPDLOCK, HOLDLOCK) WHERE Id = @Id")) return [{ Status: "draft" }];
      return base(conn, sql, params);
    });

    const res = await raise(["pt-a"]);

    expect(res.status).toBe(400);
    expect(db.rollbackTransaction).toHaveBeenCalled();
    expect(callsMatching("INSERT INTO dbo.Jobs")).toHaveLength(0);
  });

  // IN1: a finding with a photo and no description must be raisable, and the
  // job must say what it is rather than carry an empty description.
  it("raises a photo-only finding with a 'photo only' description and copies its photos", async () => {
    wireInspection();

    const out = (await raise(["pt-photo"])).jsonBody as RaiseOut;

    expect(out.jobs).toHaveLength(1);
    const insert = callsMatching("INSERT INTO dbo.Jobs")[0];
    expect(insert[2].find((param) => param.name === "Description")?.value).toBe("(photo only — see attached photos)");
    const copies = callsMatching("INSERT INTO dbo.Attachments");
    expect(copies).toHaveLength(1);
    expect(copies[0][2].find((param) => param.name === "PointId")?.value).toBe("pt-photo");
  });
});

// ── F10: getInspections no longer builds one param per inspection id ─────────

describe("getInspections parameter usage (F10)", () => {
  it("issues its aggregate count queries without per-inspection parameters", async () => {
    mockDb([
      { match: "JOIN dbo.Buildings b", rows: [inspectionRow({ Id: 1 }), inspectionRow({ Id: 2 })] },
    ]);

    const res = await getInspections(
      makeRequest({ headers: authHeaders("facilities") }),
      makeContext(),
    );

    expect(res.status).toBe(200);
    expect((res.jsonBody as { count: number }).count).toBe(2);
    for (const call of db.executeQuery.mock.calls as SqlCall[]) {
      const [, sql, params] = call;
      expect(sql).not.toContain("@I0");
      // The only parameter is the server's Show test data flag on the list itself (D9).
      expect(params.filter((p) => p.name !== "ShowTest")).toEqual([]);
    }
  });
});

// ── IN1: photo-only findings are findings (list counts) ─────────────────────
// The list's room / point counts are SQL aggregates, so the guard is on the SQL
// itself (same source-text style as the no-select-star guard): a point with no
// description but a photo must not be filtered out.

describe("getInspections counts treat a photo as a finding (IN1)", () => {
  it("counts a point as non-blank when it has a description OR an attachment", async () => {
    mockDb([
      { match: "JOIN dbo.Buildings b", rows: [inspectionRow({ Id: 1 })] },
    ]);

    const res = await getInspections(
      makeRequest({ headers: authHeaders("facilities") }),
      makeContext(),
    );
    expect(res.status).toBe(200);

    const pointCount = callsMatching("COUNT(p.Id) AS C")[0]?.[1];
    const roomCount = callsMatching("COUNT(r.Id) AS C")[0]?.[1];
    expect(pointCount).toBeDefined();
    expect(roomCount).toBeDefined();
    for (const sql of [pointCount, roomCount]) {
      expect(sql).toMatch(/LEN\(LTRIM\(RTRIM\(ISNULL\(p\.Description, ''\)\)\)\) > 0/);
      expect(sql).toMatch(/EXISTS \(SELECT 1 FROM dbo\.InspectionAttachments \w+ WHERE \w+\.PointId = p\.Id\)/);
      // The two conditions are alternatives — a photo alone must be enough.
      expect(sql).toMatch(/> 0\s+OR EXISTS/);
    }
  });
});

// ── IN3: free-text level names ───────────────────────────────────────────────
// Buildings with no configured levels (m093 family residences) need a typed
// "Ground floor" / "Whole property"; configured buildings may add a name that
// isn't in their list. The backend validates the name against the column, never
// against a picklist.

describe("applyInspectionOps addLevel op with a free-text name (IN3)", () => {
  function levelOps(name: unknown) {
    return {
      inspectionId: 7,
      ops: [{
        id: "op-lvl", inspectionId: 7, createdAt: "",
        op: { type: "addLevel", levelId: "lvl-1", name, addedAt: "2026-07-01T00:00:00Z" },
      }],
    };
  }

  function draftDb(): void {
    mockDb([
      { match: "WITH (UPDLOCK, HOLDLOCK) WHERE Id = @Id", rows: [{ Revision: 1, Status: "draft" }] },
      { match: "OUTPUT INSERTED.Revision", rows: [{ Revision: 2 }] },
    ]);
  }

  type OpsOut = { applied: string[]; rejected?: { id: string; reason: string }[] };

  it("accepts an area name that is in no building's level list", async () => {
    draftDb();
    const res = await applyInspectionOps(
      makeRequest({ headers: authHeaders("facilities"), body: levelOps("Whole property") }),
      makeContext(),
    );

    expect((res.jsonBody as OpsOut).applied).toEqual(["op-lvl"]);
    const inserts = callsMatching("INSERT INTO dbo.InspectionLevels");
    expect(inserts).toHaveLength(1);
    expect(inserts[0][2].find((p) => p.name === "Name")?.value).toBe("Whole property");
    expect(callsMatching("INSERT INTO dbo.InspectionLevelContributors")).toHaveLength(1);
  });

  it("never consults the building's configured levels", async () => {
    draftDb();
    await applyInspectionOps(
      makeRequest({ headers: authHeaders("facilities"), body: levelOps("Ground floor") }),
      makeContext(),
    );
    for (const [, sql] of db.executeQuery.mock.calls as SqlCall[]) {
      expect(sql).not.toMatch(/Buildings/i);
    }
  });

  it("stores the trimmed name", async () => {
    draftDb();
    await applyInspectionOps(
      makeRequest({ headers: authHeaders("facilities"), body: levelOps("   Ground floor  ") }),
      makeContext(),
    );
    const inserts = callsMatching("INSERT INTO dbo.InspectionLevels");
    expect(inserts[0][2].find((p) => p.name === "Name")?.value).toBe("Ground floor");
  });

  it.each([
    ["an empty name", ""],
    ["a whitespace-only name", "   "],
    ["a missing name", undefined],
    ["a non-string name", 42],
  ])("rejects %s instead of creating a nameless level", async (_label, name) => {
    draftDb();
    const res = await applyInspectionOps(
      makeRequest({ headers: authHeaders("facilities"), body: levelOps(name) }),
      makeContext(),
    );
    const out = res.jsonBody as OpsOut;
    expect(out.applied).toEqual([]);
    expect(out.rejected).toHaveLength(1);
    expect(callsMatching("INSERT INTO dbo.InspectionLevels")).toHaveLength(0);
  });

  it("rejects a name longer than the 100-char column, and accepts exactly 100", async () => {
    draftDb();
    const tooLong = await applyInspectionOps(
      makeRequest({ headers: authHeaders("facilities"), body: levelOps("x".repeat(101)) }),
      makeContext(),
    );
    expect((tooLong.jsonBody as OpsOut).rejected).toHaveLength(1);
    expect(callsMatching("INSERT INTO dbo.InspectionLevels")).toHaveLength(0);

    draftDb();
    const exact = await applyInspectionOps(
      makeRequest({ headers: authHeaders("facilities"), body: levelOps("x".repeat(100)) }),
      makeContext(),
    );
    expect((exact.jsonBody as OpsOut).applied).toEqual(["op-lvl"]);
  });
});


// ── Splitting a removal across ledger rows ───────────────────────────────────

let photoSeq = 0;
/** A photo record as the attachments query returns it, with a realistic blob name. */
function photoRow(n: number = ++photoSeq): { Id: string; BlobName: string; FileName: string } {
  return {
    Id: `0f8b2c1e-4d3a-4b5c-9e7f-${String(n).padStart(12, "0")}`,
    BlobName: `inspections/7/5d2e8a90-77c1-4f0b-a3d4-${String(n).padStart(12, "0")}-site-photo-${n}.jpg`,
    FileName: `site-photo-${n}.jpg`,
  };
}

/** Every row under the ledger's own cap (and inside the margin), all one operation. */
function expectRowsWithinTheLimit(rows: Record<string, unknown>[]): void {
  for (const row of rows) {
    const bytes = Buffer.byteLength(row.Before as string, "utf8");
    expect(bytes).toBeLessThanOrEqual(REMOVAL_ROW_BUDGET_BYTES);
    expect(bytes).toBeLessThan(LEDGER_MAX_SNAPSHOT_BYTES);
  }
  expect(new Set(rows.map((row) => row.CorrelationId)).size).toBe(1);
  expect(rows[0].CorrelationId).toMatch(/^[0-9a-f-]{36}$/i);
  expect(new Set(rows.map((row) => row.Action)).size).toBe(1);
}

// ── N3: every point removal is written to the decision ledger ────────────────

describe("applyInspectionOps removePoint op (UX review N3)", () => {
  type OpsOut = { applied: string[]; rejected?: { id: string; reason: string }[] };
  const REMOVE = { id: "op-rm", inspectionId: 7, createdAt: "", op: { type: "removePoint", pointId: "pt-1" } };
  const POINT_ROW = {
    PointId: "pt-1", RoomId: "rm-1", Description: "Cracked tile", RoomName: "Lobby", LevelName: "Ground", BuildingId: 9,
    AddedAt: new Date("2026-10-19T22:30:00.000Z"), AddedById: "oid-ada", AddedByName: "Ada Added",
  };
  const UPLOAD = { UploadedAt: new Date("2026-10-20T01:02:03.000Z"), UploadedById: "oid-una", UploadedByName: "Una Uploader" };
  const PHOTOS = [
    { Id: "att-1", BlobName: "inspections/7/a.jpg", FileName: "a.jpg", ...UPLOAD },
    { Id: "att-2", BlobName: "inspections/7/b.jpg", FileName: "b.jpg", ...UPLOAD },
  ];

  function removeDb(point: Row[], photos: Row[], failLedger = false): void {
    db.executeQuery.mockImplementation(async (_conn: unknown, sql: string) => {
      if (sql.includes("WITH (UPDLOCK, HOLDLOCK) WHERE Id = @Id")) return [{ Revision: 1, Status: "draft" }];
      if (sql.includes("SELECT p.Id AS PointId")) return point;
      if (sql.includes("FROM dbo.InspectionAttachments a WHERE a.PointId")) return photos;
      if (sql.includes("INSERT INTO dbo.DecisionLedger") && failLedger) throw new Error("ledger down");
      if (sql.includes("OUTPUT INSERTED.Revision")) return [{ Revision: 2 }];
      return [];
    });
  }

  const apply = () =>
    applyInspectionOps(
      makeRequest({ headers: authHeaders("facilities"), body: { inspectionId: 7, ops: [REMOVE] } }),
      makeContext(),
    );

  const paramsOf = (call: SqlCall): Record<string, unknown> => Object.fromEntries(call[2].map((p) => [p.name, p.value]));

  it("logs who, which inspection, which point and how many photos, then removes it", async () => {
    removeDb([POINT_ROW], PHOTOS);

    const res = await apply();

    expect((res.jsonBody as OpsOut).applied).toEqual(["op-rm"]);
    const ledger = callsMatching("INSERT INTO dbo.DecisionLedger");
    expect(ledger).toHaveLength(1);
    const row = paramsOf(ledger[0]);
    expect(row).toMatchObject({
      Action: "inspection.point_removed",
      ActorKind: "user",
      ActorName: "Test User",
      ActorRole: "facilities",
      BuildingId: 9,
      SubjectId: "7",
      SubjectType: "inspection",
    });
    const uploaded = { uploadedAt: "2026-10-20T01:02:03.000Z", uploadedById: "oid-una", uploadedByName: "Una Uploader" };
    expect(JSON.parse(row.Before as string)).toEqual({
      addedAt: "2026-10-19T22:30:00.000Z",
      addedById: "oid-ada",
      addedByName: "Ada Added",
      attachmentCount: 2,
      attachments: [
        { blobName: "inspections/7/a.jpg", fileName: "a.jpg", id: "att-1", ...uploaded },
        { blobName: "inspections/7/b.jpg", fileName: "b.jpg", id: "att-2", ...uploaded },
      ],
      description: "Cracked tile",
      levelName: "Ground",
      pointId: "pt-1",
      roomId: "rm-1",
      roomName: "Lobby",
    });
    const sqls = (db.executeQuery.mock.calls as SqlCall[]).map(([, sql]) => sql);
    const logged = sqls.findIndex((sql) => sql.includes("INSERT INTO dbo.DecisionLedger"));
    const removed = sqls.findIndex((sql) => sql.startsWith("DELETE p"));
    expect(logged).toBeGreaterThan(-1);
    expect(removed).toBeGreaterThan(logged);
  });

  it("keeps the photo files: nothing is removed from blob storage", async () => {
    removeDb([POINT_ROW], PHOTOS);
    await apply();
    expect(blob.deleteBlob).not.toHaveBeenCalled();
  });

  it("does not remove the point when the ledger row cannot be written; the op is rejected", async () => {
    removeDb([POINT_ROW], PHOTOS, true);

    const res = await apply();

    const out = res.jsonBody as OpsOut;
    expect(out.applied).toEqual([]);
    expect(out.rejected).toHaveLength(1);
    const sqls = (db.executeQuery.mock.calls as SqlCall[]).map(([, sql]) => sql);
    expect(sqls.some((sql) => sql.startsWith("DELETE p"))).toBe(false);
    expect(sqls).toContain("ROLLBACK TRANSACTION op_sp");
  });

  it("writes a small removal as one row with no part markers", async () => {
    removeDb([POINT_ROW], PHOTOS);
    await apply();
    const ledger = callsMatching("INSERT INTO dbo.DecisionLedger");
    expect(ledger).toHaveLength(1);
    const before = JSON.parse(paramsOf(ledger[0]).Before as string);
    expect(before).not.toHaveProperty("parts");
    expect(before).not.toHaveProperty("part");
  });

  it("splits a point with hundreds of photos over several rows instead of refusing it", async () => {
    const many = Array.from({ length: 700 }, (_, i) => photoRow(i));
    removeDb([POINT_ROW], many);

    const res = await apply();

    expect((res.jsonBody as OpsOut).applied).toEqual(["op-rm"]);
    const rows = callsMatching("INSERT INTO dbo.DecisionLedger").map((call) => paramsOf(call));
    expect(rows.length).toBeGreaterThan(2);
    const befores = rows.map((row) => JSON.parse(row.Before as string));
    expectRowsWithinTheLimit(rows);
    expect(befores[0]).toMatchObject({ attachmentCount: 700, description: "Cracked tile", part: 1, parts: rows.length, pointId: "pt-1" });
    const slices = befores.slice(1).flatMap((before) => before.points);
    expect(slices.every((slice: { id: string }) => slice.id === "pt-1")).toBe(true);
    expect(slices.map((slice: { attachments: unknown[] }) => slice.attachments.length).reduce((a: number, b: number) => a + b, 0)).toBe(700);
    expect(slices.flatMap((slice: { attachments: { id: string }[] }) => slice.attachments.map((a) => a.id))).toEqual(many.map((p) => p.Id));
    const sqls = (db.executeQuery.mock.calls as SqlCall[]).map(([, sql]) => sql);
    expect(sqls.map((sql) => sql.includes("INSERT INTO dbo.DecisionLedger")).lastIndexOf(true)).toBeLessThan(sqls.findIndex((sql) => sql.startsWith("DELETE p")));
  });

  it("writes no ledger row for a point that is not in this inspection", async () => {
    removeDb([], []);
    const res = await apply();
    expect((res.jsonBody as OpsOut).applied).toEqual(["op-rm"]);
    expect(callsMatching("INSERT INTO dbo.DecisionLedger")).toHaveLength(0);
  });

  it("still refuses a completed inspection before anything is read or logged", async () => {
    mockDb([{ match: "WITH (UPDLOCK, HOLDLOCK) WHERE Id = @Id", rows: [{ Revision: 3, Status: "complete" }] }]);
    const res = await apply();
    expect(res.status).toBe(409);
    expect(callsMatching("INSERT INTO dbo.DecisionLedger")).toHaveLength(0);
    expect(callsMatching("SELECT p.Id AS PointId")).toHaveLength(0);
  });
});

// ── N3 follow-up: room and level removals are written to the decision ledger ─

describe("applyInspectionOps removeRoom and removeLevel ops (UX review N3)", () => {
  type OpsOut = { applied: string[]; rejected?: { id: string; reason: string }[] };

  // One row per room x point x photo, as the LEFT JOINs return them.
  const ROOM_STAMP = { RoomAddedAt: new Date("2026-10-19T21:00:00.000Z"), RoomAddedById: "oid-rita", RoomAddedByName: "Rita Room" };
  const LOBBY = { RoomId: "rm-1", RoomName: "Lobby", RoomDescription: "Entrance", ...ROOM_STAMP };
  const POINT_STAMP = { PointAddedAt: new Date("2026-10-19T22:30:00.000Z"), PointAddedById: "oid-ada", PointAddedByName: "Ada Added" };
  const UPLOAD = { UploadedAt: new Date("2026-10-20T01:02:03.000Z"), UploadedById: "oid-una", UploadedByName: "Una Uploader" };
  const NO_POINT = { PointId: null, PointDescription: null, PointAddedAt: null, PointAddedById: null, PointAddedByName: null };
  const NO_PHOTO = { AttachmentId: null, BlobName: null, FileName: null, UploadedAt: null, UploadedById: null, UploadedByName: null };
  const JOINED: Row[] = [
    { ...LOBBY, ...POINT_STAMP, PointId: "pt-1", PointDescription: "Cracked tile", AttachmentId: "att-1", BlobName: "inspections/7/a.jpg", FileName: "a.jpg", ...UPLOAD },
    { ...LOBBY, ...POINT_STAMP, PointId: "pt-1", PointDescription: "Cracked tile", AttachmentId: "att-2", BlobName: "inspections/7/b.jpg", FileName: "b.jpg", ...UPLOAD },
    { ...LOBBY, ...POINT_STAMP, PointId: "pt-2", PointDescription: null, ...NO_PHOTO },
    { RoomId: "rm-2", RoomName: "Plant room", RoomDescription: null, RoomAddedAt: null, RoomAddedById: "oid-rita", RoomAddedByName: "Rita Room", ...NO_POINT, ...NO_PHOTO },
  ];
  const POINT_OUT = { addedAt: "2026-10-19T22:30:00.000Z", addedById: "oid-ada", addedByName: "Ada Added" };
  const UPLOAD_OUT = { uploadedAt: "2026-10-20T01:02:03.000Z", uploadedById: "oid-una", uploadedByName: "Una Uploader" };
  const LOBBY_POINTS = [
    {
      ...POINT_OUT,
      attachments: [
        { blobName: "inspections/7/a.jpg", fileName: "a.jpg", id: "att-1", ...UPLOAD_OUT },
        { blobName: "inspections/7/b.jpg", fileName: "b.jpg", id: "att-2", ...UPLOAD_OUT },
      ],
      description: "Cracked tile",
      id: "pt-1",
    },
    { ...POINT_OUT, attachments: [], description: "", id: "pt-2" },
  ];
  const ROOM_ROW = {
    RoomId: "rm-1", RoomName: "Lobby", RoomDescription: "Entrance", LevelId: "lv-1", LevelName: "Ground", BuildingId: 9, ...ROOM_STAMP,
  };
  const LEVEL_ROW = { LevelId: "lv-1", LevelName: "Ground", LevelAddedAt: new Date("2026-10-18T00:00:00.000Z"), BuildingId: 9 };
  const CONTRIBUTORS = [{ UserId: "oid-ada", UserName: "Ada Added" }, { UserId: "oid-bo", UserName: "Bo Builder" }];

  /** `failLedger`: true fails every ledger write, a number fails that write (1 = the first). */
  function removeDb(found: { room?: Row[]; level?: Row[] }, joined: Row[], failLedger: boolean | number = false, contributors: Row[] = []): void {
    let ledgerWrites = 0;
    db.executeQuery.mockImplementation(async (_conn: unknown, sql: string) => {
      if (sql.includes("WITH (UPDLOCK, HOLDLOCK) WHERE Id = @Id")) return [{ Revision: 1, Status: "draft" }];
      if (sql.includes("LEFT JOIN dbo.InspectionPoints")) return joined;
      if (sql.includes("FROM dbo.InspectionLevelContributors")) return contributors;
      if (sql.startsWith("SELECT r.Id AS RoomId")) return found.room ?? [];
      if (sql.startsWith("SELECT l.Id AS LevelId")) return found.level ?? [];
      if (sql.includes("INSERT INTO dbo.DecisionLedger")) {
        ledgerWrites += 1;
        if (failLedger === true || failLedger === ledgerWrites) throw new Error("ledger down");
      }
      if (sql.includes("OUTPUT INSERTED.Revision")) return [{ Revision: 2 }];
      return [];
    });
  }

  const apply = (op: Row) =>
    applyInspectionOps(
      makeRequest({ headers: authHeaders("facilities"), body: { inspectionId: 7, ops: [{ id: "op-rm", inspectionId: 7, createdAt: "", op }] } }),
      makeContext(),
    );
  const removeRoom = () => apply({ type: "removeRoom", roomId: "rm-1" });
  const removeLevel = () => apply({ type: "removeLevel", levelId: "lv-1" });

  const paramsOf = (call: SqlCall): Record<string, unknown> => Object.fromEntries(call[2].map((p) => [p.name, p.value]));
  const sqlsRun = () => (db.executeQuery.mock.calls as SqlCall[]).map(([, sql]) => sql);
  const DELETE_ROOM = (sql: string) => sql.startsWith("DELETE r");
  const DELETE_LEVEL = (sql: string) => sql.startsWith("DELETE FROM dbo.InspectionLevels");

  describe("removeRoom", () => {
    it("logs who, which inspection, the room, its level and each point with its photos, then removes it", async () => {
      removeDb({ room: [ROOM_ROW] }, JOINED.slice(0, 3));

      const res = await removeRoom();

      expect((res.jsonBody as OpsOut).applied).toEqual(["op-rm"]);
      const ledger = callsMatching("INSERT INTO dbo.DecisionLedger");
      expect(ledger).toHaveLength(1);
      const row = paramsOf(ledger[0]);
      expect(row).toMatchObject({
        Action: "inspection.room_removed",
        ActorKind: "user",
        ActorName: "Test User",
        ActorRole: "facilities",
        BuildingId: 9,
        SubjectId: "7",
        SubjectType: "inspection",
      });
      expect(JSON.parse(row.Before as string)).toEqual({
        attachmentCount: 2,
        levelId: "lv-1",
        levelName: "Ground",
        pointCount: 2,
        points: LOBBY_POINTS,
        roomAddedAt: "2026-10-19T21:00:00.000Z",
        roomAddedById: "oid-rita",
        roomAddedByName: "Rita Room",
        roomDescription: "Entrance",
        roomId: "rm-1",
        roomName: "Lobby",
      });
      const sqls = sqlsRun();
      const logged = sqls.findIndex((sql) => sql.includes("INSERT INTO dbo.DecisionLedger"));
      const removed = sqls.findIndex(DELETE_ROOM);
      expect(logged).toBeGreaterThan(-1);
      expect(removed).toBeGreaterThan(logged);
      expect(blob.deleteBlob).not.toHaveBeenCalled();
    });

    it("logs an empty room too", async () => {
      removeDb({ room: [ROOM_ROW] }, [JOINED[3]]);
      await removeRoom();
      const before = JSON.parse(paramsOf(callsMatching("INSERT INTO dbo.DecisionLedger")[0]).Before as string);
      expect(before).toMatchObject({ attachmentCount: 0, pointCount: 0, points: [], roomId: "rm-1" });
    });

    it("does not remove the room when the ledger row cannot be written; the op is rejected", async () => {
      removeDb({ room: [ROOM_ROW] }, JOINED.slice(0, 3), true);

      const res = await removeRoom();

      const out = res.jsonBody as OpsOut;
      expect(out.applied).toEqual([]);
      expect(out.rejected).toHaveLength(1);
      expect(sqlsRun().some(DELETE_ROOM)).toBe(false);
      expect(sqlsRun()).toContain("ROLLBACK TRANSACTION op_sp");
    });

    it("writes no ledger row for a room that is not in this inspection", async () => {
      removeDb({}, []);
      const res = await removeRoom();
      expect((res.jsonBody as OpsOut).applied).toEqual(["op-rm"]);
      expect(callsMatching("INSERT INTO dbo.DecisionLedger")).toHaveLength(0);
      expect(callsMatching("LEFT JOIN dbo.InspectionPoints")).toHaveLength(0);
    });
  });

  describe("removeLevel", () => {
    it("logs the level and every room with its points and photos, then removes it", async () => {
      removeDb({ level: [LEVEL_ROW] }, JOINED, false, CONTRIBUTORS);

      const res = await removeLevel();

      expect((res.jsonBody as OpsOut).applied).toEqual(["op-rm"]);
      const ledger = callsMatching("INSERT INTO dbo.DecisionLedger");
      expect(ledger).toHaveLength(1);
      const row = paramsOf(ledger[0]);
      expect(row).toMatchObject({
        Action: "inspection.level_removed",
        ActorKind: "user",
        ActorName: "Test User",
        ActorRole: "facilities",
        BuildingId: 9,
        SubjectId: "7",
        SubjectType: "inspection",
      });
      expect(JSON.parse(row.Before as string)).toEqual({
        attachmentCount: 2,
        contributors: [{ id: "oid-ada", name: "Ada Added" }, { id: "oid-bo", name: "Bo Builder" }],
        levelAddedAt: "2026-10-18T00:00:00.000Z",
        levelId: "lv-1",
        levelName: "Ground",
        pointCount: 2,
        roomCount: 2,
        rooms: [
          { addedAt: "2026-10-19T21:00:00.000Z", addedById: "oid-rita", addedByName: "Rita Room", description: "Entrance", id: "rm-1", name: "Lobby", points: LOBBY_POINTS },
          { addedAt: null, addedById: "oid-rita", addedByName: "Rita Room", description: "", id: "rm-2", name: "Plant room", points: [] },
        ],
      });
      const sqls = sqlsRun();
      const logged = sqls.findIndex((sql) => sql.includes("INSERT INTO dbo.DecisionLedger"));
      const removed = sqls.findIndex(DELETE_LEVEL);
      expect(logged).toBeGreaterThan(-1);
      expect(removed).toBeGreaterThan(logged);
      expect(blob.deleteBlob).not.toHaveBeenCalled();
    });

    it("reads the rooms of the level that was named, not of any other", async () => {
      removeDb({ level: [LEVEL_ROW] }, JOINED);
      await removeLevel();
      const [read] = callsMatching("LEFT JOIN dbo.InspectionPoints");
      expect(read[1]).toContain("WHERE r.LevelId = @ScopeId");
      expect(paramsOf(read)).toEqual({ ScopeId: "lv-1" });
    });

    it("does not remove the level when the ledger row cannot be written; the op is rejected", async () => {
      removeDb({ level: [LEVEL_ROW] }, JOINED, true);

      const res = await removeLevel();

      const out = res.jsonBody as OpsOut;
      expect(out.applied).toEqual([]);
      expect(out.rejected).toHaveLength(1);
      expect(sqlsRun().some(DELETE_LEVEL)).toBe(false);
      expect(sqlsRun()).toContain("ROLLBACK TRANSACTION op_sp");
    });

    it("writes no ledger row for a level that is not in this inspection", async () => {
      removeDb({}, []);
      const res = await removeLevel();
      expect((res.jsonBody as OpsOut).applied).toEqual(["op-rm"]);
      expect(callsMatching("INSERT INTO dbo.DecisionLedger")).toHaveLength(0);
      expect(callsMatching("LEFT JOIN dbo.InspectionPoints")).toHaveLength(0);
    });
  });

  // ── Too big for one ledger row: written as several, never refused ──────────
  describe("a removal larger than one ledger row", () => {
    type Point = { id: string; description: string; photos: number };
    type RoomSpec = { id: string; name: string; points: Point[] };

    /** The LEFT JOIN result for these rooms: one row per room x point x photo. */
    function joinedFor(rooms: RoomSpec[]): { rows: Row[]; photoIds: Map<string, string[]> } {
      const rows: Row[] = [];
      const photoIds = new Map<string, string[]>();
      for (const room of rooms) {
        const head = { RoomId: room.id, RoomName: room.name, RoomDescription: null };
        if (room.points.length === 0) rows.push({ ...head, PointId: null, PointDescription: null, AttachmentId: null, BlobName: null, FileName: null });
        for (const point of room.points) {
          const ids: string[] = [];
          photoIds.set(point.id, ids);
          if (point.photos === 0) rows.push({ ...head, PointId: point.id, PointDescription: point.description, AttachmentId: null, BlobName: null, FileName: null });
          for (let i = 0; i < point.photos; i += 1) {
            const photo = photoRow();
            ids.push(photo.Id);
            rows.push({ ...head, PointId: point.id, PointDescription: point.description, AttachmentId: photo.Id, BlobName: photo.BlobName, FileName: photo.FileName });
          }
        }
      }
      return { rows, photoIds };
    }

    // The mock rows for these rooms carry no added-by columns, so the records hold null.
    const NO_STAMP = { addedAt: null, addedById: null, addedByName: null };

    type Before = {
      part?: number; parts?: number; rooms?: { id: string }[]; points?: { id: string; description?: string; continued?: boolean; attachments: { id: string }[] }[];
    };
    const ledgerRows = () => callsMatching("INSERT INTO dbo.DecisionLedger").map((call) => paramsOf(call));
    const beforesOf = (rows: Record<string, unknown>[]): Before[] => rows.map((row) => JSON.parse(row.Before as string));

    /** Every point and photo record from the detail rows: how often each id turns up. */
    function tally(befores: Before[]) {
      const photoSeen = new Map<string, number>();
      const pointText = new Map<string, number>();
      const pointOrder: string[] = [];
      for (const before of befores.slice(1)) {
        for (const point of before.points ?? []) {
          if (!pointOrder.includes(point.id)) pointOrder.push(point.id);
          if (point.description !== undefined) pointText.set(point.id, (pointText.get(point.id) ?? 0) + 1);
          for (const att of point.attachments) photoSeen.set(att.id, (photoSeen.get(att.id) ?? 0) + 1);
        }
      }
      return { photoSeen, pointOrder, pointText };
    }

    it("splits a level of about 900 photos in 3 rooms into rows under the limit that hold every record once", async () => {
      const rooms: RoomSpec[] = ["Lobby", "Plant room", "Stair"].map((name, r) => ({
        id: `rm-${r + 1}`,
        name,
        points: [0, 1, 2].map((p) => ({ id: `pt-${r + 1}${p + 1}`, description: `Finding ${r + 1}.${p + 1}`, photos: 100 })),
      }));
      const { rows: joined, photoIds } = joinedFor(rooms);
      removeDb({ level: [LEVEL_ROW] }, joined);

      const res = await removeLevel();

      expect((res.jsonBody as OpsOut).applied).toEqual(["op-rm"]);
      const rows = ledgerRows();
      expect(rows.length).toBeGreaterThanOrEqual(3);
      expect(rows[0]).toMatchObject({ Action: "inspection.level_removed", BuildingId: 9, SubjectId: "7", SubjectType: "inspection" });
      expectRowsWithinTheLimit(rows);
      const befores = beforesOf(rows);
      expect(befores.map((b) => b.part)).toEqual(rows.map((_, i) => i + 1));
      expect(befores.every((b) => b.parts === rows.length)).toBe(true);
      expect(befores[0]).toEqual({
        attachmentCount: 900,
        levelAddedAt: "2026-10-18T00:00:00.000Z",
        levelId: "lv-1",
        levelName: "Ground",
        part: 1,
        parts: rows.length,
        pointCount: 9,
        roomCount: 3,
        rooms: [
          { ...NO_STAMP, attachmentCount: 300, description: "", id: "rm-1", name: "Lobby", pointCount: 3 },
          { ...NO_STAMP, attachmentCount: 300, description: "", id: "rm-2", name: "Plant room", pointCount: 3 },
          { ...NO_STAMP, attachmentCount: 300, description: "", id: "rm-3", name: "Stair", pointCount: 3 },
        ],
      });
      const { photoSeen, pointOrder, pointText } = tally(befores);
      expect(pointOrder).toEqual([...photoIds.keys()]);
      expect([...pointText.values()]).toEqual(Array(9).fill(1));
      expect(photoSeen.size).toBe(900);
      expect([...photoSeen.values()].every((n) => n === 1)).toBe(true);
      expect([...photoSeen.keys()].sort()).toEqual([...photoIds.values()].flat().sort());
      for (const before of befores.slice(1)) {
        expect(before).toMatchObject({ levelId: "lv-1", levelName: "Ground" });
        expect(before.points?.every((point) => "roomId" in point)).toBe(true);
      }
      const sqls = sqlsRun();
      expect(sqls.map((sql) => sql.includes("INSERT INTO dbo.DecisionLedger")).lastIndexOf(true)).toBeLessThan(sqls.findIndex(DELETE_LEVEL));
      expect(blob.deleteBlob).not.toHaveBeenCalled();
    });

    it("splits the photos of one point of about 600 across rows, each slice naming its point", async () => {
      const { rows: joined, photoIds } = joinedFor([{ id: "rm-1", name: "Lobby", points: [{ id: "pt-9", description: "Water damage", photos: 600 }] }]);
      removeDb({ room: [ROOM_ROW] }, joined);

      const res = await removeRoom();

      expect((res.jsonBody as OpsOut).applied).toEqual(["op-rm"]);
      const rows = ledgerRows();
      expect(rows.length).toBeGreaterThan(2);
      expect(rows[0].Action).toBe("inspection.room_removed");
      expectRowsWithinTheLimit(rows);
      const befores = beforesOf(rows);
      expect(befores[0]).toEqual({
        attachmentCount: 600,
        levelId: "lv-1",
        levelName: "Ground",
        part: 1,
        parts: rows.length,
        pointCount: 1,
        roomAddedAt: "2026-10-19T21:00:00.000Z",
        roomAddedById: "oid-rita",
        roomAddedByName: "Rita Room",
        roomDescription: "Entrance",
        roomId: "rm-1",
        roomName: "Lobby",
      });
      const slices = befores.slice(1).flatMap((before) => before.points ?? []);
      expect(slices.length).toBe(rows.length - 1);
      expect(slices.every((slice) => slice.id === "pt-9")).toBe(true);
      expect(slices.map((slice) => slice.continued === true)).toEqual(slices.map((_, i) => i > 0));
      expect(slices.map((slice) => slice.description)).toEqual(slices.map((_, i) => (i === 0 ? "Water damage" : undefined)));
      const { photoSeen } = tally(befores);
      expect(photoSeen.size).toBe(600);
      expect([...photoSeen.values()].every((n) => n === 1)).toBe(true);
      expect(slices.flatMap((slice) => slice.attachments.map((a) => a.id))).toEqual(photoIds.get("pt-9"));
    });

    it("keeps small points whole beside a big one, in order", async () => {
      const { rows: joined } = joinedFor([
        { id: "rm-1", name: "Lobby", points: [
          { id: "pt-a", description: "Small", photos: 2 },
          { id: "pt-b", description: "Big", photos: 500 },
          { id: "pt-c", description: "Also small", photos: 1 },
        ] },
      ]);
      removeDb({ room: [ROOM_ROW] }, joined);

      await removeRoom();

      const befores = beforesOf(ledgerRows());
      const { photoSeen, pointOrder, pointText } = tally(befores);
      expect(pointOrder).toEqual(["pt-a", "pt-b", "pt-c"]);
      expect([...pointText.entries()]).toEqual([["pt-a", 1], ["pt-b", 1], ["pt-c", 1]]);
      expect(photoSeen.size).toBe(503);
      expect([...photoSeen.values()].every((n) => n === 1)).toBe(true);
    });

    it("rejects the whole op and removes nothing when a later part fails to write", async () => {
      const { rows: joined } = joinedFor([{ id: "rm-1", name: "Lobby", points: [{ id: "pt-9", description: "Water damage", photos: 900 }] }]);
      removeDb({ room: [ROOM_ROW] }, joined, 3);

      const res = await removeRoom();

      const out = res.jsonBody as OpsOut;
      expect(out.applied).toEqual([]);
      expect(out.rejected).toHaveLength(1);
      expect(callsMatching("INSERT INTO dbo.DecisionLedger")).toHaveLength(3);
      expect(sqlsRun().some(DELETE_ROOM)).toBe(false);
      expect(sqlsRun()).toContain("ROLLBACK TRANSACTION op_sp");
      expect(blob.deleteBlob).not.toHaveBeenCalled();
    });
  });
});

// ── UX fix round 2, B2: a photo removal is logged first, and the file stays ──

describe("applyInspectionOps removeAttachment op", () => {
  type OpsOut = { applied: string[]; rejected?: { id: string; reason: string }[] };
  const REMOVE = { id: "op-rm", inspectionId: 7, createdAt: "", op: { type: "removeAttachment", attachmentId: "att-1" } };
  const PHOTO_ROW = {
    Id: "att-1", PointId: "pt-1", BlobName: "inspections/5d2e8a90-77c1-4f0b-a3d4-000000000001.jpg", FileName: "crack.jpg",
    UploadedAt: new Date("2026-10-20T01:02:03.000Z"), UploadedById: "oid-una", UploadedByName: "Una Uploader",
    RoomId: "rm-1", RoomName: "Lobby", LevelName: "Ground", BuildingId: 9,
  };

  function photoDb(photo: Row[], failLedger = false): void {
    db.executeQuery.mockImplementation(async (_conn: unknown, sql: string) => {
      if (sql.includes("WITH (UPDLOCK, HOLDLOCK) WHERE Id = @Id")) return [{ Revision: 1, Status: "draft" }];
      if (sql.startsWith("SELECT a.Id, a.PointId")) return photo;
      if (sql.includes("INSERT INTO dbo.DecisionLedger") && failLedger) throw new Error("ledger down");
      if (sql.includes("OUTPUT INSERTED.Revision")) return [{ Revision: 2 }];
      return [];
    });
  }
  const apply = () =>
    applyInspectionOps(makeRequest({ headers: authHeaders("facilities"), body: { inspectionId: 7, ops: [REMOVE] } }), makeContext());
  const paramsOf = (call: SqlCall): Record<string, unknown> => Object.fromEntries(call[2].map((p) => [p.name, p.value]));
  const sqlsRun = () => (db.executeQuery.mock.calls as SqlCall[]).map(([, sql]) => sql);

  it("logs who removed which photo, from which point, and who uploaded it and when, then removes the record", async () => {
    photoDb([PHOTO_ROW]);

    const res = await apply();

    expect((res.jsonBody as OpsOut).applied).toEqual(["op-rm"]);
    const ledger = callsMatching("INSERT INTO dbo.DecisionLedger");
    expect(ledger).toHaveLength(1);
    const row = paramsOf(ledger[0]);
    expect(row).toMatchObject({
      Action: "inspection.photo_removed",
      ActorKind: "user",
      ActorName: "Test User",
      ActorRole: "facilities",
      BuildingId: 9,
      SubjectId: "7",
      SubjectType: "inspection",
    });
    expect(JSON.parse(row.Before as string)).toEqual({
      attachmentId: "att-1",
      blobName: PHOTO_ROW.BlobName,
      fileName: "crack.jpg",
      levelName: "Ground",
      pointId: "pt-1",
      roomId: "rm-1",
      roomName: "Lobby",
      uploadedAt: "2026-10-20T01:02:03.000Z",
      uploadedById: "oid-una",
      uploadedByName: "Una Uploader",
    });
    const sqls = sqlsRun();
    const logged = sqls.findIndex((sql) => sql.includes("INSERT INTO dbo.DecisionLedger"));
    const removed = sqls.findIndex((sql) => sql.startsWith("DELETE a"));
    expect(logged).toBeGreaterThan(-1);
    expect(removed).toBeGreaterThan(logged);
  });

  it("keeps the photo file: nothing is removed from blob storage", async () => {
    photoDb([PHOTO_ROW]);
    await apply();
    expect(blob.deleteBlob).not.toHaveBeenCalled();
  });

  it("does not remove the photo when the ledger row cannot be written; the op is rejected", async () => {
    photoDb([PHOTO_ROW], true);

    const res = await apply();

    const out = res.jsonBody as OpsOut;
    expect(out.applied).toEqual([]);
    expect(out.rejected).toHaveLength(1);
    expect(sqlsRun().some((sql) => sql.startsWith("DELETE a"))).toBe(false);
    expect(sqlsRun()).toContain("ROLLBACK TRANSACTION op_sp");
    expect(blob.deleteBlob).not.toHaveBeenCalled();
  });

  it("reads and deletes only within the inspection named, and logs nothing for a photo that is not in it", async () => {
    photoDb([]);

    const res = await apply();

    expect((res.jsonBody as OpsOut).applied).toEqual(["op-rm"]);
    expect(callsMatching("INSERT INTO dbo.DecisionLedger")).toHaveLength(0);
    for (const call of [...callsMatching("FROM dbo.InspectionAttachments a"), ...callsMatching("DELETE a")]) {
      expect(call[1]).toContain("l.InspectionId = @InspectionId");
      expect(paramsOf(call)).toMatchObject({ InspectionId: 7 });
    }
  });
});

// ── UX fix round 2, B2 (bug 5): point text is capped at 5,000 characters ─────

describe("applyInspectionOps point text length", () => {
  type OpsOut = { applied: string[]; rejected?: { id: string; reason: string }[] };
  const apply = (op: Row) =>
    applyInspectionOps(
      makeRequest({ headers: authHeaders("facilities"), body: { inspectionId: 7, ops: [{ id: "op-1", inspectionId: 7, createdAt: "", op }] } }),
      makeContext(),
    );
  const draftDb = () =>
    mockDb([
      { match: "WITH (UPDLOCK, HOLDLOCK) WHERE Id = @Id", rows: [{ Revision: 1, Status: "draft" }] },
      { match: "OUTPUT INSERTED.Revision", rows: [{ Revision: 2 }] },
    ]);
  const add = (description: string) => ({ type: "addPoint", pointId: "pt-1", roomId: "rm-1", description, addedAt: "2026-10-23T00:00:00.000Z" });
  const update = (description: string) => ({ type: "updatePoint", pointId: "pt-1", patch: { description } });

  it("accepts exactly 5,000 characters on add and on update", async () => {
    draftDb();
    expect(((await apply(add("x".repeat(5000)))).jsonBody as OpsOut).applied).toEqual(["op-1"]);
    draftDb();
    expect(((await apply(update("x".repeat(5000)))).jsonBody as OpsOut).applied).toEqual(["op-1"]);
    expect(callsMatching("INSERT INTO dbo.InspectionPoints")).toHaveLength(1);
    expect(callsMatching("UPDATE p")).toHaveLength(1);
  });

  it.each([
    ["addPoint", add, "INSERT INTO dbo.InspectionPoints"],
    ["updatePoint", update, "UPDATE p"],
  ])("refuses 5,001 characters on %s, writes nothing, and says why in the reason", async (_name, build, sqlStart) => {
    draftDb();

    const out = (await apply(build("x".repeat(5001)))).jsonBody as OpsOut;

    expect(out.applied).toEqual([]);
    expect(out.rejected).toHaveLength(1);
    expect(out.rejected?.[0].reason).toMatch(/5001 characters.*limit is 5000/);
    expect(callsMatching(sqlStart)).toHaveLength(0);
  });

  it("an over-long note's reason is shown in production, while other failures stay generic", () => {
    process.env.AZURE_FUNCTIONS_ENVIRONMENT = "Production";
    expect(opRejectionReason(new OpRefusal("too long"))).toBe("too long");
    expect(opRejectionReason(new Error("Violation of UNIQUE KEY constraint"))).toBe("Operation could not be applied");
  });
});
