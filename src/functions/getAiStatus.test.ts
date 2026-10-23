/// <reference types="jest" />
import { HttpRequest, type InvocationContext } from "@azure/functions";
import { AppRole } from "../auth";
import { getAiStatus } from "./getAiStatus";

jest.mock("@azure/functions", () => ({
  ...jest.requireActual("@azure/functions"),
  app: { http: jest.fn() },
}));
let roles: string[] = [AppRole.USER];
let token: string | null = "token";
jest.mock("../auth", () => ({
  ...jest.requireActual("../auth"),
  extractToken: () => token,
  requireRole: async (_r: unknown, allowed: string[]) =>
    jest.requireActual("../auth").rolesPassGate(roles, allowed) ? null : { status: 403 },
}));
jest.mock("../db", () => ({
  closeConnection: jest.fn(),
  createRequestConnection: jest.fn(),
  createServiceRequestConnection: jest.fn(),
  executeQuery: jest.fn(),
}));
jest.mock("../ai/registry", () => ({
  ...jest.requireActual("../ai/registry"),
  listPurposeIds: jest.fn(() => ["echo_test"]),
}));

import { createRequestConnection, createServiceRequestConnection, executeQuery } from "../db";
import * as registry from "../ai/registry";

const ctx = { error: jest.fn() } as unknown as InvocationContext;
const call = () => getAiStatus(new HttpRequest({ method: "GET", url: "http://localhost/api/getAiStatus" }), ctx);
const body = (r: { jsonBody?: unknown }) => r.jsonBody as Record<string, unknown>;
const saved = { ...process.env };

beforeEach(() => {
  jest.clearAllMocks();
  roles = [AppRole.USER];
  token = "token";
  process.env = { ...saved };
  for (const name of ["AI_ENABLED", "AI_PROVIDER", "AI_BASE_URL", "AI_MODEL", "AI_API_KEY", "AI_LOG_CONTENT"]) delete process.env[name];
  jest.mocked(registry.listPurposeIds).mockReturnValue(["echo_test"]);
});

afterAll(() => {
  process.env = saved;
});

describe("access", () => {
  it("returns 401 with no token", async () => {
    token = null;
    expect((await call()).status).toBe(401);
  });

  it("returns 403 for someone with no assigned role", async () => {
    roles = [];
    expect((await call()).status).toBe(403);
  });

  it.each(Object.values(AppRole))("lets %s in: any signed-in person may ask", async (role) => {
    roles = [role];
    expect((await call()).status).toBe(200);
  });
});

describe("what it says", () => {
  it("says AI is off, on the mock, with the purposes it allows, when nothing is set", async () => {
    const response = await call();
    expect(response.status).toBe(200);
    expect(response.headers).toMatchObject({ "Cache-Control": "no-store" });
    expect(body(response)).toEqual({ configured: true, enabled: false, model: "mock", provider: "mock", purposes: ["echo_test"] });
  });

  it("reads the settings on every call, so a switch takes effect without a restart", async () => {
    expect(body(await call()).enabled).toBe(false);
    process.env.AI_ENABLED = "true";
    expect(body(await call()).enabled).toBe(true);
    process.env.AI_ENABLED = "TRUE";
    expect(body(await call()).enabled).toBe(false);
  });

  it("names the provider and model of a self-hosted endpoint, and not its address or key", async () => {
    Object.assign(process.env, {
      AI_API_KEY: "s3cret-key",
      AI_BASE_URL: "http://10.4.0.7:8000",
      AI_ENABLED: "true",
      AI_MODEL: "llama-3.1-8b",
      AI_PROVIDER: "openai_compatible",
    });
    const response = await call();
    expect(body(response)).toEqual({ configured: true, enabled: true, model: "llama-3.1-8b", provider: "openai_compatible", purposes: ["echo_test"] });
    const text = JSON.stringify(response);
    for (const secret of ["s3cret-key", "10.4.0.7", "8000"]) expect(text).not.toContain(secret);
  });

  it("says when the endpoint is not fully set up, and when the provider is not one it knows", async () => {
    process.env.AI_PROVIDER = "openai_compatible";
    expect(body(await call())).toMatchObject({ configured: false, model: null });
    process.env.AI_PROVIDER = `openai${"x".repeat(80)}`;
    const unknown = body(await call());
    expect(unknown).toMatchObject({ configured: false });
    expect(String(unknown.provider)).toHaveLength(40);
  });

  it("reads settings only: no database, no model", async () => {
    await call();
    expect(createRequestConnection).not.toHaveBeenCalled();
    expect(createServiceRequestConnection).not.toHaveBeenCalled();
    expect(executeQuery).not.toHaveBeenCalled();
  });
});

describe("when it fails", () => {
  it("answers a plain 500 without internals", async () => {
    jest.mocked(registry.listPurposeIds).mockImplementation(() => {
      throw new Error("AI purpose in secretFile: boom");
    });
    const response = await call();
    expect(response.status).toBe(500);
    expect(JSON.stringify(response)).not.toContain("secretFile");
    expect(ctx.error).toHaveBeenCalled();
  });
});
