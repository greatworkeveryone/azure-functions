/// <reference types="jest" />
import { HttpRequest, InvocationContext } from "@azure/functions";

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn() } };
});

jest.mock("../auth", () => ({
  AppRole: {
    ACCOUNTS: "accounts",
    ACCOUNTS_APPROVAL: "accounts_manager",
    ADMIN: "admin",
    DIRECTOR: "director",
    FACILITIES: "facilities",
    FACILITIES_APPROVAL: "facilities_manager",
    USER: "user",
  },
  errorResponse: jest.fn().mockReturnValue({ status: 500, jsonBody: { error: "Error" } }),
  extractToken: jest.fn().mockReturnValue("mock-token"),
  forbiddenResponse: jest.fn().mockImplementation((detail?: string) => ({ status: 403, jsonBody: { error: detail ?? "Forbidden" } })),
  requireRole: jest.fn().mockResolvedValue(null),
  rolesForRequest: jest.fn().mockResolvedValue(["director"]),
  serviceUnavailableResponse: jest.fn().mockReturnValue({ status: 503, jsonBody: { error: "Unavailable" } }),
  unauthorizedResponse: jest.fn().mockReturnValue({ status: 401, jsonBody: { error: "Unauthorized" } }),
  userInfoFromToken: jest.fn().mockReturnValue({ email: "connor@rp.com.au", name: "Connor" }),
}));

jest.mock("../db", () => ({
  beginTransaction: jest.fn().mockResolvedValue(undefined),
  closeConnection: jest.fn(),
  commitTransaction: jest.fn().mockResolvedValue(undefined),
  createRequestConnection: jest.fn().mockResolvedValue({}),
  createServiceRequestConnection: jest.fn().mockResolvedValue({}),
  executeQuery: jest.fn().mockResolvedValue([]),
  rollbackTransaction: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../escalation/store", () => ({ listActiveUsers: jest.fn().mockResolvedValue([]) }));

const auth = require("../auth") as {
  extractToken: jest.Mock;
  requireRole: jest.Mock;
  rolesForRequest: jest.Mock;
  userInfoFromToken: jest.Mock;
};
const db = require("../db") as {
  beginTransaction: jest.Mock;
  commitTransaction: jest.Mock;
  executeQuery: jest.Mock;
  rollbackTransaction: jest.Mock;
};
const store = require("../escalation/store") as { listActiveUsers: jest.Mock };

import { getProcedures } from "./getProcedures";
import { publishProcedure } from "./publishProcedure";
import { saveProcedureDraft } from "./saveProcedureDraft";

const context = new InvocationContext();
const FORBIDDEN = { status: 403, jsonBody: { error: "Forbidden" } };

function requestWithBody(body: unknown): HttpRequest {
  return { json: async () => body } as unknown as HttpRequest;
}

const emptyRequest = {} as unknown as HttpRequest;

const validDraft = {
  blocks: [{ id: "b1", kind: "paragraph", text: "Do the thing" }],
  slug: "key-handover",
  summary: "How keys change hands",
  title: "Key Handover",
};

beforeEach(() => {
  jest.clearAllMocks();
  auth.extractToken.mockReturnValue("mock-token");
  auth.requireRole.mockResolvedValue(null);
  auth.rolesForRequest.mockResolvedValue(["director"]);
  auth.userInfoFromToken.mockReturnValue({ email: "connor@rp.com.au", name: "Connor" });
  db.executeQuery.mockResolvedValue([]);
  store.listActiveUsers.mockResolvedValue([]);
});

describe("getProcedures", () => {
  it("rejects an unauthenticated caller", async () => {
    auth.extractToken.mockReturnValue(null);
    const response = await getProcedures(emptyRequest, context);
    expect(response.status).toBe(401);
  });

  const versionRow = (status: string) => ({
    Audience: "all", Category: "Field work", Owner: null, Slug: "keys", SortOrder: 1,
    ApprovedAt: null, ApprovedBy: null, BlocksJson: "[]", CreatedAt: new Date("2026-08-01"),
    CreatedBy: "Connor", PublishedAt: null, ReviewDue: null, Status: status,
    Summary: "", Title: "Keys", VersionId: `v-${status}`, VersionNo: status === "draft" ? 2 : 1,
  });

  it("includes drafts for editor-tier callers", async () => {
    db.executeQuery.mockResolvedValue([versionRow("draft"), versionRow("published")]);
    const response = await getProcedures(emptyRequest, context);
    const record = (response.jsonBody as any).procedures[0];
    expect(record.versions.map((v: any) => v.status)).toEqual(["draft", "published"]);
  });

  it("filters drafts out for everyone else — presentation is not security", async () => {
    // Caller passes the baseline [USER] gate (any assigned role) but not the
    // editor-tier gate used for canSeeDrafts.
    auth.requireRole.mockImplementation((_req: unknown, allowed: string[]) =>
      Promise.resolve(allowed.includes("user") ? null : FORBIDDEN),
    );
    db.executeQuery.mockResolvedValue([versionRow("draft"), versionRow("published")]);
    const response = await getProcedures(emptyRequest, context);
    const record = (response.jsonBody as any).procedures[0];
    expect(record.versions.map((v: any) => v.status)).toEqual(["published"]);
    // The record itself still comes back — only the draft is withheld.
    expect(record.slug).toBe("keys");
  });
});

describe("getProcedures: who reads which procedure (U4)", () => {
  const row = (slug: string, audience: string, status = "published") => ({
    Audience: audience, Category: "Field work", Owner: null, Slug: slug, SortOrder: 1,
    ApprovedAt: null, ApprovedBy: null, BlocksJson: "[]", CreatedAt: new Date("2026-08-01"),
    CreatedBy: "Connor", PublishedAt: null, ReviewDue: null, Status: status,
    Summary: "", Title: slug, VersionId: `v-${slug}-${status}`, VersionNo: 1,
  });
  const NOT_EDITOR = (_req: unknown, allowed: string[]) => Promise.resolve(allowed.includes("user") ? null : FORBIDDEN);
  const slugs = (response: { jsonBody?: unknown }) => (response.jsonBody as any).procedures.map((p: any) => p.slug);

  beforeEach(() => {
    db.executeQuery.mockResolvedValue([row("for-all", "all"), row("for-officers", "facilities"), row("for-accounts", "accounts,cfo"), row("for-directors", "director")]);
  });

  it.each([
    [["facilities"], ["for-all", "for-officers"]],
    [["accounts"], ["for-all", "for-accounts"]],
    [["user"], ["for-all"]],
  ])("withholds what is not written for a reader holding %j", async (roles, expected) => {
    auth.requireRole.mockImplementation(NOT_EDITOR);
    auth.rolesForRequest.mockResolvedValue(roles);
    expect(slugs(await getProcedures(emptyRequest, context))).toEqual(expected);
  });

  it.each([
    [["facilities_manager"], ["for-all", "for-officers"]],
    [["accounts_manager"], ["for-all", "for-accounts"]],
    [["cfo"], ["for-all", "for-accounts"]],
  ])("shows an editor holding %j only what is written for their team: editing does not widen reading", async (roles, expected) => {
    auth.rolesForRequest.mockResolvedValue(roles);
    expect(slugs(await getProcedures(emptyRequest, context))).toEqual(expected);
  });

  it.each([["director"], ["admin"]])("shows %s everything, a director-only procedure included", async (role) => {
    auth.rolesForRequest.mockResolvedValue([role]);
    expect(slugs(await getProcedures(emptyRequest, context))).toEqual(["for-all", "for-officers", "for-accounts", "for-directors"]);
  });

  it("keeps an editor's drafts of the procedures they can read, and no others", async () => {
    auth.rolesForRequest.mockResolvedValue(["facilities_manager"]);
    db.executeQuery.mockResolvedValue([row("for-officers", "facilities", "draft"), row("for-accounts", "accounts", "draft")]);
    const body = (await getProcedures(emptyRequest, context)).jsonBody as any;
    expect(body.procedures.map((p: any) => `${p.slug}:${p.versions.map((v: any) => v.status)}`)).toEqual(["for-officers:draft"]);
  });

  it("shows only what is for everyone when the caller's roles cannot be read", async () => {
    auth.requireRole.mockImplementation(NOT_EDITOR);
    auth.rolesForRequest.mockRejectedValue(new Error("lookup failed"));
    expect(slugs(await getProcedures(emptyRequest, context))).toEqual(["for-all"]);
  });
});

describe("getProcedures: asking for approval (U4)", () => {
  const draft = (over: Record<string, unknown> = {}) => ({
    Audience: "all", Category: "Field work", Owner: null, Slug: "keys", SortOrder: 1,
    ApprovedAt: null, ApprovedBy: null, BlocksJson: "[]", CreatedAt: new Date("2026-08-01"),
    CreatedBy: "Connor", PublishedAt: null, ReviewDue: null, Status: "draft",
    Summary: "", Title: "Keys", VersionId: "v-draft", VersionNo: 2,
    ApprovalRequestedAt: new Date("2026-10-18T01:00:00Z"), ApprovalRequestedBy: "Fay Manager",
    ApprovalRequestedFromName: "Dee Director", ApprovalRequestedFromUserId: 7, ...over,
  });
  const NOT_EDITOR = (_req: unknown, allowed: string[]) => Promise.resolve(allowed.includes("user") ? null : FORBIDDEN);

  it("says on a draft who was asked to approve it, who asked and when", async () => {
    db.executeQuery.mockResolvedValue([draft()]);
    const version = (await getProcedures(emptyRequest, context)).jsonBody as any;
    expect(version.procedures[0].versions[0].approvalRequest).toEqual({
      at: "2026-10-18T01:00:00.000Z",
      by: "Fay Manager",
      from: { name: "Dee Director", userId: 7 },
    });
  });

  it("says nothing when no one has been asked", async () => {
    db.executeQuery.mockResolvedValue([draft({ ApprovalRequestedAt: null, ApprovalRequestedBy: null, ApprovalRequestedFromName: null, ApprovalRequestedFromUserId: null })]);
    const body = (await getProcedures(emptyRequest, context)).jsonBody as any;
    expect(body.procedures[0].versions[0]).not.toHaveProperty("approvalRequest");
  });

  it("offers editors the active directors to ask, by name", async () => {
    store.listActiveUsers.mockResolvedValue([
      { email: "z@rp.com", name: "Zed Director", role: "director", userId: 9 },
      { email: "d@rp.com", name: "Dee Director", role: "director", userId: 7 },
      { email: "a@rp.com", name: "Ann Accounts", role: "accounts_manager", userId: 3 },
    ]);
    const body = (await getProcedures(emptyRequest, context)).jsonBody as any;
    expect(body.approvers).toEqual([{ name: "Ann Accounts", role: "accounts_manager", userId: 3 }, { name: "Dee Director", role: "director", userId: 7 }, { name: "Zed Director", role: "director", userId: 9 }]);
  });

  it("offers nobody else the list, and never reads the users for them", async () => {
    auth.requireRole.mockImplementation(NOT_EDITOR);
    const body = (await getProcedures(emptyRequest, context)).jsonBody as any;
    expect(body.approvers).toEqual([]);
    expect(store.listActiveUsers).not.toHaveBeenCalled();
  });

  it("still serves the library when the directors cannot be listed", async () => {
    store.listActiveUsers.mockRejectedValue(new Error("down"));
    const response = await getProcedures(emptyRequest, context);
    expect(response.status).toBe(200);
    expect((response.jsonBody as any).approvers).toEqual([]);
  });
});

const batchCall = () => db.executeQuery.mock.calls.find((call) => /BEGIN TRANSACTION/.test(String(call[1])));

describe("saveProcedureDraft", () => {
  it("refuses callers below the editor gate", async () => {
    auth.requireRole.mockResolvedValue(FORBIDDEN);
    const response = await saveProcedureDraft(requestWithBody(validDraft), context);
    expect(response.status).toBe(403);
    expect(db.executeQuery).not.toHaveBeenCalled();
  });

  it("rejects a malformed slug before touching the database", async () => {
    const response = await saveProcedureDraft(
      requestWithBody({ ...validDraft, slug: "Bad Slug!" }),
      context,
    );
    expect(response.status).toBe(400);
    expect(db.executeQuery).not.toHaveBeenCalled();
  });

  it("rejects blocks the renderer would not understand", async () => {
    const response = await saveProcedureDraft(
      requestWithBody({ ...validDraft, blocks: [{ id: "b1", kind: "video" }] }),
      context,
    );
    expect(response.status).toBe(400);
    expect((response.jsonBody as any).error).toContain("video");
  });

  it("saves a valid draft and creates the parent row for a new slug", async () => {
    const response = await saveProcedureDraft(requestWithBody(validDraft), context);
    expect(response.status).toBe(200);
    const [, sql, params] = batchCall()!;
    expect(sql).toContain("IF NOT EXISTS (SELECT 1 FROM dbo.Procedures");
    expect(sql).toContain("BEGIN TRANSACTION");
    const byName = Object.fromEntries(params.map((p: any) => [p.name, p.value]));
    expect(byName.Slug).toBe("key-handover");
    expect(byName.Author).toBe("Connor");
    // No audience supplied → safe default, never an empty string.
    expect(byName.Audience).toBe("all");
  });

  it("withdraws a request for approval when the draft is edited: an approval must not survive an edit", async () => {
    await saveProcedureDraft(requestWithBody(validDraft), context);
    const [, sql] = batchCall()!;
    const update = sql.slice(sql.indexOf("UPDATE dbo.ProcedureVersions"), sql.indexOf("IF @@ROWCOUNT = 0"));
    for (const column of ["ApprovalRequestedAt", "ApprovalRequestedBy", "ApprovalRequestedFromUserId", "ApprovalRequestedFromName"]) {
      expect(update).toContain(`${column} = NULL`);
    }
    expect(update).toContain("Status = 'draft'");
  });

  /** Answers the save's batch (not the audience lookup before it) with `rows`. */
  const batchReturns = (rows: unknown[]): void => {
    db.executeQuery.mockImplementation(async (_c: unknown, sql: string) => (/BEGIN TRANSACTION/.test(sql) ? rows : []));
  };

  it("returns the new updatedAt and says when the save withdrew a pending approval request", async () => {
    batchReturns([{ ApprovalRequestCleared: true, Outcome: "ok", UpdatedAt: new Date("2026-10-23T01:02:03Z") }]);
    const response = await saveProcedureDraft(requestWithBody(validDraft), context);
    expect(response.status).toBe(200);
    expect(response.jsonBody).toEqual({ approvalRequestCleared: true, ok: true, updatedAt: "2026-10-23T01:02:03.000Z" });
  });

  it("reports no withdrawal when nothing was pending", async () => {
    batchReturns([{ ApprovalRequestCleared: false, Outcome: "ok", UpdatedAt: new Date("2026-10-23T01:02:03Z") }]);
    expect((await saveProcedureDraft(requestWithBody(validDraft), context)).jsonBody).toMatchObject({ approvalRequestCleared: false });
  });

  it("sends the version it was shown to the database, and checks it under the draft's lock", async () => {
    await saveProcedureDraft(requestWithBody({ ...validDraft, updatedAt: "2026-10-23T01:02:03.000Z" }), context);
    const [, sql, params] = batchCall()!;
    expect(sql).toMatch(/WITH \(UPDLOCK, HOLDLOCK\) WHERE Slug = @Slug AND Status = 'draft'/);
    expect(params.find((p: any) => p.name === "ExpectedAt").value).toEqual(new Date("2026-10-23T01:02:03.000Z"));
    await saveProcedureDraft(requestWithBody({ ...validDraft, version: "2026-10-23T01:02:04.000Z" }), context);
    expect(db.executeQuery.mock.calls.filter((c) => /BEGIN TRANSACTION/.test(String(c[1])))[1][2].find((p: any) => p.name === "ExpectedAt").value).toEqual(new Date("2026-10-23T01:02:04.000Z"));
  });

  it("answers 409 with the current updatedAt when the draft moved on, and no success body", async () => {
    batchReturns([{ ApprovalRequestCleared: false, Outcome: "conflict", UpdatedAt: new Date("2026-10-23T02:00:00Z") }]);
    const response = await saveProcedureDraft(requestWithBody({ ...validDraft, updatedAt: "2026-10-23T01:02:03.000Z" }), context);
    expect(response.status).toBe(409);
    expect((response.jsonBody as any).current).toEqual({ updatedAt: "2026-10-23T02:00:00.000Z" });
    expect((response.jsonBody as any).ok).toBeUndefined();
  });

  it("sends no version when the client sent none (last writer wins, as before)", async () => {
    await saveProcedureDraft(requestWithBody(validDraft), context);
    expect(batchCall()![2].find((p: any) => p.name === "ExpectedAt").value).toBeNull();
  });

  it("rejects an unreadable updatedAt before touching the database", async () => {
    const response = await saveProcedureDraft(requestWithBody({ ...validDraft, updatedAt: "yesterday-ish" }), context);
    expect(response.status).toBe(400);
    expect(db.executeQuery).not.toHaveBeenCalled();
  });

  it("ignores audience values that are not known roles", async () => {
    await saveProcedureDraft(
      requestWithBody({ ...validDraft, audience: ["facilities", "hacker"] }),
      context,
    );
    const [, , params] = batchCall()!;
    const byName = Object.fromEntries(params.map((p: any) => [p.name, p.value]));
    expect(byName.Audience).toBe("facilities");
  });
});

// An editor writes for their own team (least privilege): reading a procedure and
// writing one are decided by the same audience rule, and director and admin see all.
describe("saveProcedureDraft: only inside the editor's audience", () => {
  /** The procedure `slug` already exists with this audience, or doesn't exist (null). */
  function existing(audience: string | null) {
    db.executeQuery.mockImplementation(async (_conn: unknown, sql: string) =>
      /SELECT Audience FROM dbo\.Procedures/.test(sql) ? (audience === null ? [] : [{ Audience: audience }]) : [],
    );
  }

  it("refuses a facilities manager's edit of a procedure written for accounts, and writes nothing", async () => {
    auth.rolesForRequest.mockResolvedValue(["facilities_manager"]);
    existing("accounts");
    const response = await saveProcedureDraft(requestWithBody(validDraft), context);
    expect(response.status).toBe(403);
    expect(batchCall()).toBeUndefined();
  });

  it("refuses an accounts manager creating a procedure for facilities", async () => {
    auth.rolesForRequest.mockResolvedValue(["accounts_manager"]);
    existing(null);
    const response = await saveProcedureDraft(requestWithBody({ ...validDraft, audience: ["facilities"] }), context);
    expect(response.status).toBe(403);
    expect(batchCall()).toBeUndefined();
  });

  it("refuses a CFO editing a facilities procedure: the CFO sits on the accounts ladder only", async () => {
    auth.rolesForRequest.mockResolvedValue(["cfo"]);
    existing("facilities");
    expect((await saveProcedureDraft(requestWithBody(validDraft), context)).status).toBe(403);
  });

  it.each([
    [["facilities_manager"], "facilities"],
    [["facilities_manager"], "facilities,accounts"],
    [["accounts_manager"], "all"],
    [["cfo"], "accounts"],
  ])("lets %j edit a procedure written for %s", async (roles, audience) => {
    auth.rolesForRequest.mockResolvedValue(roles);
    existing(audience);
    expect((await saveProcedureDraft(requestWithBody(validDraft), context)).status).toBe(200);
    expect(batchCall()).toBeDefined();
  });

  it("lets a manager create a procedure for their own team, or for everyone, or with no audience given", async () => {
    auth.rolesForRequest.mockResolvedValue(["facilities_manager"]);
    existing(null);
    for (const audience of [["facilities"], ["all"], undefined]) {
      db.executeQuery.mockClear();
      existing(null);
      expect((await saveProcedureDraft(requestWithBody({ ...validDraft, audience }), context)).status).toBe(200);
    }
  });

  it.each([["director"], ["admin"]])("lets %s write for any audience", async (role) => {
    auth.rolesForRequest.mockResolvedValue([role]);
    existing("director");
    expect((await saveProcedureDraft(requestWithBody(validDraft), context)).status).toBe(200);
    existing(null);
    expect((await saveProcedureDraft(requestWithBody({ ...validDraft, audience: ["accounts"] }), context)).status).toBe(200);
  });

  it("answers 503, writing nothing, when the editor's roles cannot be read", async () => {
    auth.rolesForRequest.mockRejectedValue(new Error("lookup failed"));
    existing("facilities");
    expect((await saveProcedureDraft(requestWithBody(validDraft), context)).status).toBe(503);
    expect(batchCall()).toBeUndefined();
  });

  it("looks the procedure up before writing, never after", async () => {
    auth.rolesForRequest.mockResolvedValue(["facilities_manager"]);
    existing("facilities");
    await saveProcedureDraft(requestWithBody(validDraft), context);
    const kinds = db.executeQuery.mock.calls.map((call) => (/SELECT Audience/.test(String(call[1])) ? "lookup" : "write"));
    expect(kinds).toEqual(["lookup", "write"]);
  });
});

describe("publishProcedure", () => {
  const publishBody = { reviewIntervalMonths: 12, slug: "keys", versionId: "abc" };

  /** The current state of the procedure as the handler's statements see it. */
  function library({ draftThere = true, promoted = 1 }: { draftThere?: boolean; promoted?: number } = {}) {
    const order: string[] = [];
    db.executeQuery.mockImplementation(async (_conn: unknown, sql: string) => {
      if (/SELECT Audience, EndorsementAuthority/.test(sql)) return [{ Audience: "facilities", EndorsementAuthority: "team" }];
      if (/UPDLOCK/.test(sql)) {
        order.push("lock");
        return draftThere ? [{ VersionId: "abc" }] : [];
      }
      if (/SET Status = 'archived'/.test(sql)) {
        order.push("archive");
        return [];
      }
      if (/SET Status = 'published'/.test(sql)) {
        order.push("promote");
        return Array.from({ length: promoted }, () => ({ VersionId: "abc" }));
      }
      return [];
    });
    return order;
  }

  it("refuses callers below the approver gate", async () => {
    auth.requireRole.mockResolvedValue(FORBIDDEN);
    const response = await publishProcedure(requestWithBody(publishBody), context);
    expect(response.status).toBe(403);
    expect(db.executeQuery).not.toHaveBeenCalled();
  });

  it("refuses a caller whose only role is admin: putting a procedure into force is a director's approval", async () => {
    auth.rolesForRequest.mockResolvedValue(["admin"]);
    const response = await publishProcedure(requestWithBody(publishBody), context);
    expect(response.status).toBe(403);
    expect(db.executeQuery).not.toHaveBeenCalled();
    expect(db.beginTransaction).not.toHaveBeenCalled();
  });

  it("lets an admin who is also a director publish", async () => {
    auth.rolesForRequest.mockResolvedValue(["admin", "director"]);
    library();
    expect((await publishProcedure(requestWithBody(publishBody), context)).status).toBe(200);
  });

  it("refuses, writing nothing, when the caller's roles cannot be read", async () => {
    auth.rolesForRequest.mockRejectedValue(new Error("lookup failed"));
    expect((await publishProcedure(requestWithBody(publishBody), context)).status).toBe(503);
    expect(db.executeQuery).not.toHaveBeenCalled();
  });

  it("rejects a review interval outside the offered set", async () => {
    const response = await publishProcedure(
      requestWithBody({ ...publishBody, reviewIntervalMonths: 7 }),
      context,
    );
    expect(response.status).toBe(400);
  });

  it("refuses to publish when it cannot name the approver", async () => {
    auth.userInfoFromToken.mockReturnValue(null);
    const response = await publishProcedure(requestWithBody(publishBody), context);
    expect(response.status).toBe(403);
  });

  it("promotes the draft and stamps the approver from the token, not the body", async () => {
    const order = library();
    const response = await publishProcedure(requestWithBody({ ...publishBody, approver: "Mallory" }), context);
    expect(response.status).toBe(200);
    expect(order).toEqual(["lock", "archive", "promote"]);
    const promote = db.executeQuery.mock.calls.find((call) => /SET Status = 'published'/.test(String(call[1])))!;
    const byName = Object.fromEntries(promote[2].map((p: any) => [p.name, p.value]));
    expect(byName.Approver).toBe("Connor");
    expect(db.commitTransaction).toHaveBeenCalledTimes(1);
    expect(db.rollbackTransaction).not.toHaveBeenCalled();
  });

  // The data-loss path (database-safety §7): a second Publish of the same draft (two
  // directors asked, two tabs, a retry after a timeout) used to archive the version the
  // first one just published, promote nothing, and commit.
  describe("a publish of a draft that is no longer there", () => {
    it("answers 409 before it touches the published version, and rolls back", async () => {
      const order = library({ draftThere: false });
      const response = await publishProcedure(requestWithBody(publishBody), context);
      expect(response.status).toBe(409);
      expect(order).toEqual(["lock"]);
      expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
      expect(db.commitTransaction).not.toHaveBeenCalled();
    });

    it("leaves the current version published when the same draft is published twice", async () => {
      const first = library();
      expect((await publishProcedure(requestWithBody(publishBody), context)).status).toBe(200);
      expect(first).toContain("archive");
      db.executeQuery.mockClear();
      db.commitTransaction.mockClear();
      const second = library({ draftThere: false });
      expect((await publishProcedure(requestWithBody(publishBody), context)).status).toBe(409);
      expect(second).not.toContain("archive");
      expect(db.commitTransaction).not.toHaveBeenCalled();
    });

    it("rolls back, rather than commits, if the promotion changes nothing after all", async () => {
      const order = library({ promoted: 0 });
      const response = await publishProcedure(requestWithBody(publishBody), context);
      expect(response.status).toBe(409);
      expect(order).toEqual(["lock", "archive", "promote"]);
      expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
      expect(db.commitTransaction).not.toHaveBeenCalled();
    });

    it("rolls back when a statement fails, and says so", async () => {
      db.executeQuery.mockImplementation(async (_conn: unknown, sql: string) => {
        if (/UPDLOCK/.test(sql)) return [{ VersionId: "abc" }];
        throw new Error("deadlock");
      });
      const response = await publishProcedure(requestWithBody(publishBody), context);
      expect(response.status).toBe(500);
      expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
      expect(db.commitTransaction).not.toHaveBeenCalled();
    });
  });

  it("locks the draft row it reads, so two publishes of it cannot both pass", async () => {
    library();
    await publishProcedure(requestWithBody(publishBody), context);
    const lock = db.executeQuery.mock.calls.find((call) => /UPDLOCK, ROWLOCK/.test(String(call[1])))!;
    expect(String(lock[1])).toMatch(/Status = 'draft'/);
    expect(String(lock[1])).toMatch(/WHERE Slug = @Slug AND VersionId = @VersionId/);
  });
});
