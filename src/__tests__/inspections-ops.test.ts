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
  createConnection:        jest.fn(),
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
  createConnection:        jest.Mock;
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
  db.createConnection.mockResolvedValue({});
  db.createServiceConnection.mockResolvedValue({});
  db.beginTransaction.mockResolvedValue(undefined);
  db.commitTransaction.mockResolvedValue(undefined);
  db.rollbackTransaction.mockResolvedValue(undefined);
  process.env.DEV_ROLE_OVERRIDE_ENABLED = "true";
  delete process.env.AZURE_FUNCTIONS_ENVIRONMENT;
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
      expect(params).toEqual([]);
    }
  });
});

// ── F2: cleanupAttachments must not reap shared inspection blobs ─────────────
// Source-text guard (same style as no-select-star.test.ts): the filter lives
// in SQL inside a timer whose internals aren't exported.

describe("cleanupAttachments spares inspection blobs (F2)", () => {
  it("excludes BlobName LIKE 'inspections/%' from the reap SELECT", () => {
    const src = readFileSync(join(__dirname, "..", "functions", "cleanupAttachments.ts"), "utf8");
    expect(src).toMatch(/AND\s+BlobName\s+NOT\s+LIKE\s+'inspections\/%'/);
  });
});
