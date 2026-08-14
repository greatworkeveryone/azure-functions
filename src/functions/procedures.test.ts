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
  requireRole: jest.fn().mockResolvedValue(null),
  unauthorizedResponse: jest.fn().mockReturnValue({ status: 401, jsonBody: { error: "Unauthorized" } }),
  userInfoFromToken: jest.fn().mockReturnValue({ email: "connor@rp.com.au", name: "Connor" }),
}));

jest.mock("../db", () => ({
  closeConnection: jest.fn(),
  createConnection: jest.fn().mockResolvedValue({}),
  executeQuery: jest.fn().mockResolvedValue([]),
}));

const auth = require("../auth") as {
  extractToken: jest.Mock;
  requireRole: jest.Mock;
  userInfoFromToken: jest.Mock;
};
const db = require("../db") as { executeQuery: jest.Mock };

import { getProcedures, publishProcedure, saveProcedureDraft } from "./procedures";

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
  auth.userInfoFromToken.mockReturnValue({ email: "connor@rp.com.au", name: "Connor" });
  db.executeQuery.mockResolvedValue([]);
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
    auth.requireRole.mockResolvedValue(FORBIDDEN);
    db.executeQuery.mockResolvedValue([versionRow("draft"), versionRow("published")]);
    const response = await getProcedures(emptyRequest, context);
    const record = (response.jsonBody as any).procedures[0];
    expect(record.versions.map((v: any) => v.status)).toEqual(["published"]);
    // The record itself still comes back — only the draft is withheld.
    expect(record.slug).toBe("keys");
  });
});

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
    const [, sql, params] = db.executeQuery.mock.calls[0];
    expect(sql).toContain("IF NOT EXISTS (SELECT 1 FROM dbo.Procedures");
    expect(sql).toContain("BEGIN TRANSACTION");
    const byName = Object.fromEntries(params.map((p: any) => [p.name, p.value]));
    expect(byName.Slug).toBe("key-handover");
    expect(byName.Author).toBe("Connor");
    // No audience supplied → safe default, never an empty string.
    expect(byName.Audience).toBe("all");
  });

  it("ignores audience values that are not known roles", async () => {
    await saveProcedureDraft(
      requestWithBody({ ...validDraft, audience: ["facilities", "hacker"] }),
      context,
    );
    const [, , params] = db.executeQuery.mock.calls[0];
    const byName = Object.fromEntries(params.map((p: any) => [p.name, p.value]));
    expect(byName.Audience).toBe("facilities");
  });
});

describe("publishProcedure", () => {
  const publishBody = { reviewIntervalMonths: 12, slug: "keys", versionId: "abc" };

  it("refuses callers below the approver gate", async () => {
    auth.requireRole.mockResolvedValue(FORBIDDEN);
    const response = await publishProcedure(requestWithBody(publishBody), context);
    expect(response.status).toBe(403);
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

  it("returns 409 when there is no draft to promote", async () => {
    db.executeQuery.mockResolvedValue([{ Promoted: 0 }]);
    const response = await publishProcedure(requestWithBody(publishBody), context);
    expect(response.status).toBe(409);
  });

  it("promotes the draft and stamps the approver from the token, not the body", async () => {
    db.executeQuery.mockResolvedValue([{ Promoted: 1 }]);
    const response = await publishProcedure(
      requestWithBody({ ...publishBody, approver: "Mallory" }),
      context,
    );
    expect(response.status).toBe(200);
    const [, sql, params] = db.executeQuery.mock.calls[0];
    expect(sql).toContain("SET Status = 'archived'");
    const byName = Object.fromEntries(params.map((p: any) => [p.name, p.value]));
    expect(byName.Approver).toBe("Connor");
  });
});
