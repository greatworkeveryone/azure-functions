/// <reference types="jest" />
import { HttpRequest, type InvocationContext } from "@azure/functions";
import { ACTION_ROLES, exportActionRoles } from "../action-roles";
import { AppRole } from "../auth";
import { listAiCalls } from "./listAiCalls";

jest.mock("@azure/functions", () => ({
  ...jest.requireActual("@azure/functions"),
  app: { http: jest.fn() },
}));
let roles: string[] = [AppRole.ADMIN];
let token: string | null = "token";
jest.mock("../auth", () => ({
  ...jest.requireActual("../auth"),
  extractToken: () => token,
  requireRole: async (_r: unknown, allowed: string[]) =>
    jest.requireActual("../auth").rolesPassGate(roles, allowed) ? null : { status: 403 },
}));
jest.mock("../db", () => ({
  closeConnection: jest.fn(),
  createRequestConnection: jest.fn(async () => ({})),
  executeQuery: jest.fn(),
}));

import { closeConnection, createRequestConnection, executeQuery } from "../db";

const query = jest.mocked(executeQuery);
const ctx = { error: jest.fn() } as unknown as InvocationContext;
const request = (qs = "") => new HttpRequest({ method: "GET", url: `http://localhost/api/listAiCalls${qs}` });
const body = (r: { jsonBody?: unknown }) => r.jsonBody as Record<string, any>;

const ROW = {
  ActorEmail: "jo@randazzo.example",
  ActorName: "Jo Bloggs",
  ActorRole: "admin",
  CorrelationId: "0f9e8d7c-6b5a-4f3e-9d2c-1b0a99887766",
  CreatedAt: new Date("2026-10-23T01:02:03.000Z"),
  ErrorCode: null,
  Id: "5",
  InputChars: 25,
  LatencyMs: 9,
  Model: "mock",
  Outcome: "ok",
  OutputChars: 36,
  PromptVersion: "echo_test@1",
  Provider: "mock",
  Purpose: "echo_test",
  RecordId: null,
  RecordType: "health_check",
  RedactionCount: 0,
};

beforeEach(() => {
  jest.clearAllMocks();
  roles = [AppRole.ADMIN];
  token = "token";
  query.mockImplementation(async (_c, sql) => (sql.includes("COUNT_BIG") ? [{ Total: "1" }] : [ROW]));
});

describe("access", () => {
  it("is gated by viewAiActivity: admin and director", () => {
    expect(ACTION_ROLES.viewAiActivity.routes).toContain("listAiCalls");
    expect([...ACTION_ROLES.viewAiActivity.gate].sort()).toEqual([AppRole.ADMIN, AppRole.DIRECTOR]);
    expect(exportActionRoles().viewAiActivity).toEqual([AppRole.ADMIN, AppRole.DIRECTOR]);
  });

  it("returns 401 with no token, before any query", async () => {
    token = null;
    expect((await listAiCalls(request(), ctx)).status).toBe(401);
    expect(createRequestConnection).not.toHaveBeenCalled();
  });

  it.each([AppRole.FACILITIES, AppRole.FACILITIES_APPROVAL, AppRole.ACCOUNTS, AppRole.ACCOUNTS_APPROVAL, AppRole.CFO, AppRole.USER])(
    "returns 403 for %s, before any query",
    async (role) => {
      roles = [role];
      expect((await listAiCalls(request(), ctx)).status).toBe(403);
      expect(createRequestConnection).not.toHaveBeenCalled();
      expect(query).not.toHaveBeenCalled();
    },
  );

  it.each([AppRole.ADMIN, AppRole.DIRECTOR])("lets %s in", async (role) => {
    roles = [role];
    expect((await listAiCalls(request(), ctx)).status).toBe(200);
  });
});

describe("a page of calls", () => {
  it("returns the rows shaped for the screen, with the page and the total", async () => {
    const response = await listAiCalls(request("?page=2&pageSize=25"), ctx);

    expect(response.status).toBe(200);
    expect(response.headers).toMatchObject({ "Cache-Control": "no-store" });
    expect(body(response)).toEqual({
      items: [expect.objectContaining({ actorName: "Jo Bloggs", createdAt: "2026-10-23T01:02:03.000Z", id: 5, outcome: "ok", purpose: "echo_test", recordType: "health_check" })],
      page: 2,
      pageSize: 25,
      total: 1,
    });
    expect(String(query.mock.calls[0][1])).toContain("OFFSET 25 ROWS FETCH NEXT 25 ROWS ONLY");
  });

  it("is the first page of 50 when no page is asked for", async () => {
    expect(body(await listAiCalls(request(), ctx))).toMatchObject({ page: 1, pageSize: 50 });
  });

  it("passes the filters to the query as bound values", async () => {
    await listAiCalls(request("?purpose=echo_test&outcome=refused&actor=jo&from=2026-10-01&to=2026-10-23"), ctx);
    const [, sql, params] = query.mock.calls[0];
    expect(sql).toContain("Purpose = @Purpose AND Outcome = @Outcome");
    expect(sql).not.toContain("refused");
    expect((params ?? []).map((p) => p.name).sort()).toEqual(["Actor", "From", "Outcome", "Purpose", "To"]);
  });

  it("never sends the stored text or the hash, even if the database row had them", async () => {
    query.mockImplementation(async (_c, sql) => (sql.includes("COUNT_BIG") ? [{ Total: 1 }] : [{ ...ROW, InputSha256: "a".repeat(64), InputText: "secret", OutputText: "secret" }]));
    const text = JSON.stringify(await listAiCalls(request(), ctx));
    expect(text).not.toContain("secret");
    expect(text).not.toContain("aaaaaaaa");
  });

  it("gives the connection back", async () => {
    await listAiCalls(request(), ctx);
    expect(closeConnection).toHaveBeenCalledTimes(1);
  });
});

describe("bad input", () => {
  it.each([
    ["an unknown outcome", "?outcome=success"],
    ["a bad purpose", "?purpose=Echo%20Test"],
    ["a bad date", "?from=yesterday"],
    ["dates out of order", "?from=2026-10-23&to=2026-10-01"],
    ["a huge page", "?page=999999999"],
  ])("returns 400 for %s, before any query", async (_label, qs) => {
    const response = await listAiCalls(request(qs), ctx);
    expect(response.status).toBe(400);
    expect(body(response).error).toEqual(expect.any(String));
    expect(createRequestConnection).not.toHaveBeenCalled();
  });
});

describe("when the database fails", () => {
  it("answers a plain 500, tells nothing of the failure, and still gives the connection back", async () => {
    query.mockRejectedValue(new Error("Invalid object name 'dbo.AiCallLog'."));
    const response = await listAiCalls(request(), ctx);
    expect(response.status).toBe(500);
    expect(JSON.stringify(response)).not.toContain("AiCallLog");
    expect(ctx.error).toHaveBeenCalled();
    expect(closeConnection).toHaveBeenCalledTimes(1);
  });

  it("answers 500 when it cannot connect", async () => {
    jest.mocked(createRequestConnection).mockRejectedValueOnce(new Error("login failed"));
    expect((await listAiCalls(request(), ctx)).status).toBe(500);
    expect(closeConnection).not.toHaveBeenCalled();
  });
});
