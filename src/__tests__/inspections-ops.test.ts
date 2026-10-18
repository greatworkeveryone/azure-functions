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

