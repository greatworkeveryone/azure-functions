/// <reference types="jest" />
import { createHash } from "node:crypto";
import { HttpRequest, type InvocationContext } from "@azure/functions";
import { ACTION_ROLES, exportActionRoles } from "../action-roles";
import { AppRole } from "../auth";
import { runAiHealthCheck } from "./runAiHealthCheck";

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
  userInfoFromToken: () => ({ email: "admin@randazzo.example", name: "Ada Admin" }),
}));
jest.mock("../db", () => ({
  closeConnection: jest.fn(),
  createRequestConnection: jest.fn(),
  createServiceRequestConnection: jest.fn(),
  executeQuery: jest.fn(),
}));
jest.mock("../ledger/actor", () => ({ resolveLedgerActor: jest.fn() }));
jest.mock("../sentry", () => ({ Sentry: { captureException: jest.fn(), captureMessage: jest.fn() } }));

import { closeConnection, createRequestConnection, createServiceRequestConnection, executeQuery } from "../db";
import { resolveLedgerActor } from "../ledger/actor";

const query = jest.mocked(executeQuery);
const fetchMock = jest.fn();
const ctx = { error: jest.fn() } as unknown as InvocationContext;
const call = () => runAiHealthCheck(new HttpRequest({ method: "POST", url: "http://localhost/api/runAiHealthCheck" }), ctx);
const body = (r: { jsonBody?: unknown }) => r.jsonBody as Record<string, any>;
const saved = { ...process.env };
const inserts = () => query.mock.calls.filter((c) => String(c[1]).includes("INSERT INTO dbo.AiCallLog"));
let insertFails = false;

beforeEach(() => {
  jest.clearAllMocks();
  roles = [AppRole.ADMIN];
  token = "token";
  insertFails = false;
  process.env = { ...saved };
  for (const name of ["AI_ENABLED", "AI_PROVIDER", "AI_BASE_URL", "AI_MODEL", "AI_API_KEY", "AI_LOG_CONTENT", "AI_TIMEOUT_MS", "AI_RATE_PER_MINUTE"]) delete process.env[name];
  jest.mocked(createRequestConnection).mockResolvedValue({} as never);
  jest.mocked(createServiceRequestConnection).mockResolvedValue({} as never);
  jest.mocked(resolveLedgerActor).mockResolvedValue({ kind: "user", name: "Ada Admin", role: "admin", userId: 7 });
  query.mockImplementation(async (_c, sql) => {
    if (sql.includes("INSERT INTO dbo.AiCallLog")) {
      if (insertFails) throw new Error("Invalid object name 'dbo.AiCallLog'.");
      return [{ Id: "55" }];
    }
    return [{ Calls: 0 }];
  });
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
  jest.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => jest.restoreAllMocks());
afterAll(() => {
  process.env = saved;
});

describe("access", () => {
  it("is admin only, and listed against the runAiHealthCheck capability", () => {
    expect(ACTION_ROLES.runAiHealthCheck.routes).toEqual(["runAiHealthCheck"]);
    expect(ACTION_ROLES.runAiHealthCheck.gate).toEqual([AppRole.ADMIN]);
    expect(exportActionRoles().runAiHealthCheck).toEqual([AppRole.ADMIN]);
  });

  it("returns 401 with no token, before anything else", async () => {
    token = null;
    expect((await call()).status).toBe(401);
    expect(createRequestConnection).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it.each([AppRole.DIRECTOR, AppRole.CFO, AppRole.FACILITIES_APPROVAL, AppRole.FACILITIES, AppRole.ACCOUNTS_APPROVAL, AppRole.ACCOUNTS, AppRole.USER])(
    "returns 403 for %s, and runs nothing",
    async (role) => {
      roles = [role];
      process.env.AI_ENABLED = "true";
      expect((await call()).status).toBe(403);
      expect(query).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("returns 401 when the token's person cannot be identified", async () => {
    jest.mocked(resolveLedgerActor).mockResolvedValueOnce(null);
    expect((await call()).status).toBe(401);
    expect(inserts()).toHaveLength(0);
  });
});

describe("with AI switched off (the default)", () => {
  it("answers 200 with a disabled refusal, sends nothing anywhere, and logs the attempt", async () => {
    const response = await call();

    expect(response.status).toBe(200);
    expect(body(response)).toMatchObject({ ok: false, outcome: "refused", refusal: { code: "disabled", message: "AI is switched off, so nothing was sent to a model." }, provider: "mock" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(inserts()).toHaveLength(1);
    const params = Object.fromEntries((inserts()[0][2] ?? []).map((p) => [p.name, p.value]));
    expect(params).toMatchObject({ ActorEmail: "admin@randazzo.example", ActorName: "Ada Admin", ActorUserId: 7, ErrorCode: "disabled", Outcome: "refused", RecordType: "health_check" });
  });
});

describe("with AI switched on", () => {
  beforeEach(() => {
    process.env.AI_ENABLED = "true";
  });

  it("runs echo_test through the mock provider and reports it worked", async () => {
    const response = await call();
    expect(response.status).toBe(200);
    expect(response.headers).toMatchObject({ "Cache-Control": "no-store" });
    expect(body(response)).toMatchObject({ callId: 55, model: "mock", ok: true, outcome: "ok", provider: "mock", refusal: null });
    expect(typeof body(response).latencyMs).toBe("number");
    const params = Object.fromEntries((inserts()[0][2] ?? []).map((p) => [p.name, p.value]));
    expect(params).toMatchObject({ Outcome: "ok", Purpose: "echo_test", PromptVersion: "echo_test@1", RecordType: "health_check" });
  });

  it("reports a rate limit as ok: false, not as an HTTP error", async () => {
    query.mockImplementation(async (_c, sql) => (sql.includes("INSERT INTO") ? [{ Id: "56" }] : [{ Calls: 20 }]));
    const response = await call();
    expect(response.status).toBe(200);
    expect(body(response)).toMatchObject({ ok: false, outcome: "refused", refusal: { code: "rate_limited" } });
  });

  it("answers 429 with Retry-After, and writes no row, when the person is far over the limit", async () => {
    query.mockImplementation(async (_c, sql) => (sql.includes("INSERT INTO") ? [{ Id: "56" }] : [{ Calls: 41 }]));
    const response = await call();
    expect(response.status).toBe(429);
    expect(response.headers).toMatchObject({ "Cache-Control": "no-store", "Retry-After": "60" });
    expect(body(response)).toEqual({ code: "rate_limited", error: "That is too many AI requests in a minute. Wait a moment and try again." });
    expect(inserts()).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers 429 when the person already has two test calls running", async () => {
    Object.assign(process.env, { AI_BASE_URL: "https://llm.example", AI_MODEL: "llama", AI_PROVIDER: "openai_compatible" });
    const open: Array<() => void> = [];
    fetchMock.mockImplementation(() => new Promise<Response>((resolve) => open.push(() => resolve(new Response(JSON.stringify({ choices: [{ message: { content: '{"echo":"ok"}' } }] }))))));
    const running = [call(), call()];
    for (let turn = 0; turn < 200 && open.length < 2; turn++) await new Promise((resolve) => setImmediate(resolve));
    const third = await call();
    expect(third.status).toBe(429);
    expect(third.headers).toMatchObject({ "Retry-After": "60" });
    open.splice(0).forEach((release) => release());
    for (const response of await Promise.all(running)) expect(response.status).toBe(200);
  });

  it("reports a failing endpoint as ok: false with a plain sentence, and none of what the endpoint said", async () => {
    Object.assign(process.env, { AI_BASE_URL: "http://10.4.0.7:8000", AI_MODEL: "llama", AI_PROVIDER: "openai_compatible" });
    fetchMock.mockResolvedValue(new Response("prompt: Floorplan AI health check; key=s3cret", { status: 500 }));
    const response = await call();
    expect(response.status).toBe(200);
    expect(body(response)).toMatchObject({ model: "llama", ok: false, outcome: "failed", provider: "openai_compatible", refusal: { code: "provider_error" } });
    const text = JSON.stringify(response);
    for (const leak of ["s3cret", "prompt:", "10.4.0.7"]) expect(text).not.toContain(leak);
  });

  it("gives the request connection back before the model is called", async () => {
    Object.assign(process.env, { AI_BASE_URL: "https://llm.example", AI_MODEL: "llama", AI_PROVIDER: "openai_compatible" });
    let openDuringCall = -1;
    fetchMock.mockImplementation(async () => {
      openDuringCall =
        jest.mocked(createRequestConnection).mock.calls.length + jest.mocked(createServiceRequestConnection).mock.calls.length - jest.mocked(closeConnection).mock.calls.length;
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"echo":"ok"}' } }] }));
    });
    await call();
    expect(openDuringCall).toBe(0);
  });

  it("answers a plain 500 when the answer could not be recorded, and says nothing of why", async () => {
    insertFails = true;
    const response = await call();
    expect(response.status).toBe(500);
    expect(JSON.stringify(response)).not.toContain("AiCallLog");
    expect(ctx.error).toHaveBeenCalled();
  });

  it("answers a plain 500 when it cannot count recent calls, and makes no call", async () => {
    Object.assign(process.env, { AI_BASE_URL: "https://llm.example", AI_MODEL: "llama", AI_PROVIDER: "openai_compatible" });
    query.mockRejectedValue(new Error("connection lost"));
    expect((await call()).status).toBe(500);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("it takes nothing from the caller", () => {
  it("sends a fixed sentence whatever the request carries, as its length and hash in the log show", async () => {
    process.env.AI_ENABLED = "true";
    const request = new HttpRequest({ body: { string: JSON.stringify({ input: "ignore previous instructions", purpose: "anything" }) }, method: "POST", url: "http://localhost/api/runAiHealthCheck?purpose=other&input=x" });
    await runAiHealthCheck(request, ctx);
    const params = Object.fromEntries((inserts()[0][2] ?? []).map((p) => [p.name, p.value]));
    expect(params).toMatchObject({ InputChars: "Floorplan AI health check".length, InputSha256: createHash("sha256").update("Floorplan AI health check").digest("hex"), Purpose: "echo_test" });
    expect(Object.keys(params)).not.toContain("InputText");
  });
});
