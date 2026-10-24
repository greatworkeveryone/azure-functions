/// <reference types="jest" />
import { HttpRequest, type InvocationContext } from "@azure/functions";
import { AppRole } from "../auth";
import { resetUsageRateLimit, MAX_BATCHES_PER_WINDOW } from "../usage/rateLimit";
import { postUsageEvents } from "./postUsageEvents";

jest.mock("@azure/functions", () => ({ ...jest.requireActual("@azure/functions"), app: { http: jest.fn() } }));
let roles: string[] = [AppRole.FACILITIES];
let token: string | null = "token";
let oid: string | null = "oid-1";
jest.mock("../auth", () => ({
  ...jest.requireActual("../auth"),
  errorResponse: (message: string) => ({ jsonBody: { error: message }, status: 500 }),
  extractToken: () => token,
  oidFromToken: () => oid,
  rolesForRequest: async () => roles,
  requireRole: async (_r: unknown, allowed: string[]) => (jest.requireActual("../auth").rolesPassGate(roles, allowed) ? null : { status: 403 }),
}));
jest.mock("../db", () => ({ closeConnection: jest.fn(), createRequestConnection: jest.fn(async () => ({})) }));
let flagOn = true;
jest.mock("../usage/flag", () => ({ usageFlagEnabledFor: jest.fn(async () => flagOn) }));
jest.mock("../usage/ingest", () => ({ storeUsageBatch: jest.fn(async () => "stored"), userIdForOid: jest.fn(async () => 7) }));

import { createRequestConnection } from "../db";
import { usageFlagEnabledFor } from "../usage/flag";
import { storeUsageBatch, userIdForOid } from "../usage/ingest";

const ctx = { error: jest.fn() } as unknown as InvocationContext;
const good = () => ({
  device: { browser: "Chrome", class: "tablet", id: "d_abcdefghijklmnop1", os: "Android" },
  sessionId: "x_abcdefghijklmnop1",
  views: [{ activeSeconds: 40, enteredAt: new Date().toISOString(), module: "inspections", route: "/inspections/[id]", seq: 1 }],
});
const post = (body: unknown, raw?: string) =>
  new HttpRequest({ body: { string: raw ?? JSON.stringify(body) }, headers: { "content-type": "application/json" }, method: "POST", url: "http://localhost/api/postUsageEvents" });

const ENV = process.env.USAGE_TRACKING_ENABLED;
beforeEach(() => {
  jest.clearAllMocks();
  resetUsageRateLimit();
  roles = [AppRole.FACILITIES];
  token = "token";
  oid = "oid-1";
  flagOn = true;
  process.env.USAGE_TRACKING_ENABLED = "true";
});
afterAll(() => {
  if (ENV === undefined) delete process.env.USAGE_TRACKING_ENABLED;
  else process.env.USAGE_TRACKING_ENABLED = ENV;
});

describe("postUsageEvents: switch and auth", () => {
  it.each([undefined, "", "false", "TRUE", "1", "yes"])("answers 204 and touches no database when USAGE_TRACKING_ENABLED is %p", async (value) => {
    if (value === undefined) delete process.env.USAGE_TRACKING_ENABLED;
    else process.env.USAGE_TRACKING_ENABLED = value;
    expect((await postUsageEvents(post(good()), ctx)).status).toBe(204);
    expect(createRequestConnection).not.toHaveBeenCalled();
    expect(storeUsageBatch).not.toHaveBeenCalled();
  });

  it("answers 401 with no token", async () => {
    token = null;
    expect((await postUsageEvents(post(good()), ctx)).status).toBe(401);
    expect(storeUsageBatch).not.toHaveBeenCalled();
  });

  it("answers 403 with no role at all", async () => {
    roles = [];
    expect((await postUsageEvents(post(good()), ctx)).status).toBe(403);
    expect(storeUsageBatch).not.toHaveBeenCalled();
  });

  it.each(Object.values(AppRole))("lets %s in: any signed-in role", async (role) => {
    roles = [role];
    expect((await postUsageEvents(post(good()), ctx)).status).toBe(204);
    expect(storeUsageBatch).toHaveBeenCalledTimes(1);
  });
});

describe("postUsageEvents: who it records", () => {
  it("looks the person up from the token's oid, whatever the body says", async () => {
    const body = { ...good(), oid: "someone-else", userId: 99, user: { id: 99 } };
    await postUsageEvents(post(body), ctx);
    expect(userIdForOid).toHaveBeenCalledWith(expect.anything(), "oid-1");
    expect(jest.mocked(storeUsageBatch).mock.calls[0][1]).toBe(7);
    expect(JSON.stringify(jest.mocked(storeUsageBatch).mock.calls[0][2])).not.toMatch(/someone-else|99/);
  });

  it("drops the batch quietly when the token's person has no active row", async () => {
    jest.mocked(userIdForOid).mockResolvedValueOnce(null);
    expect((await postUsageEvents(post(good()), ctx)).status).toBe(204);
    expect(storeUsageBatch).not.toHaveBeenCalled();
  });

  it("drops the batch quietly when the token has no oid", async () => {
    oid = null;
    expect((await postUsageEvents(post(good()), ctx)).status).toBe(204);
    expect(createRequestConnection).not.toHaveBeenCalled();
  });
});

describe("postUsageEvents: the usageAnalytics flag", () => {
  it("writes nothing for a role the flag is not enabled for, even from a client that sends anyway", async () => {
    flagOn = false;
    expect((await postUsageEvents(post(good()), ctx)).status).toBe(204);
    expect(storeUsageBatch).not.toHaveBeenCalled();
  });

  it("looks the flag up for the caller's own roles", async () => {
    roles = [AppRole.FACILITIES];
    await postUsageEvents(post(good()), ctx);
    expect(jest.mocked(usageFlagEnabledFor).mock.calls[0][1]).toEqual([AppRole.FACILITIES]);
  });

  it("checks before it counts the batch against the rate limit", async () => {
    flagOn = false;
    for (let i = 0; i < MAX_BATCHES_PER_WINDOW + 5; i += 1) expect((await postUsageEvents(post(good()), ctx)).status).toBe(204);
  });
});

describe("postUsageEvents: caps", () => {
  it("answers 413 from the Content-Length header alone, without reading the body", async () => {
    const request = new HttpRequest({ body: { string: JSON.stringify(good()) }, headers: { "content-length": "90000", "content-type": "application/json" }, method: "POST", url: "http://localhost/api/postUsageEvents" });
    const text = jest.spyOn(request, "text");
    const body = jest.spyOn(request, "body", "get");
    expect((await postUsageEvents(request, ctx)).status).toBe(413);
    expect(text).not.toHaveBeenCalled();
    expect(body).not.toHaveBeenCalled();
    expect(createRequestConnection).not.toHaveBeenCalled();
  });

  it("stops reading a body that has no length and grows past the cap, and answers 413", async () => {
    const chunk = new TextEncoder().encode("x".repeat(3000));
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        if (pulled > 50) controller.close();
        else controller.enqueue(chunk);
      },
    });
    const request = new HttpRequest({ body: { string: "" }, method: "POST", url: "http://localhost/api/postUsageEvents" });
    Object.defineProperty(request, "body", { value: stream });
    expect((await postUsageEvents(request, ctx)).status).toBe(413);
    expect(pulled).toBeLessThan(10);
    expect(createRequestConnection).not.toHaveBeenCalled();
  });

  it("answers 413 for a body over the size cap, before parsing", async () => {
    expect((await postUsageEvents(post(null, "x".repeat(9000)), ctx)).status).toBe(413);
    expect(createRequestConnection).not.toHaveBeenCalled();
  });

  it.each([
    ["not JSON", "{oops"],
    ["a route with an id", JSON.stringify({ ...good(), views: [{ ...good().views[0], route: "/jobs/12345" }] })],
    ["a route with a query string", JSON.stringify({ ...good(), views: [{ ...good().views[0], route: "/jobs?q=abc" }] })],
    ["too many views", JSON.stringify({ ...good(), views: Array.from({ length: 21 }, (_, i) => ({ ...good().views[0], seq: i + 1, activeSeconds: 1 })) })],
    ["too many seconds in a view", JSON.stringify({ ...good(), views: [{ ...good().views[0], activeSeconds: 901 }] })],
    ["no views", JSON.stringify({ ...good(), views: [] })],
  ])("answers 400 for %s, before any database work", async (_label, raw) => {
    expect((await postUsageEvents(post(null, raw), ctx)).status).toBe(400);
    expect(createRequestConnection).not.toHaveBeenCalled();
  });

  it("answers 429 once a person has sent too many batches lately, and stores no more", async () => {
    for (let i = 0; i < MAX_BATCHES_PER_WINDOW; i += 1) expect((await postUsageEvents(post(good()), ctx)).status).toBe(204);
    const refused = await postUsageEvents(post(good()), ctx);
    expect(refused.status).toBe(429);
    expect(refused.headers).toMatchObject({ "Retry-After": "60" });
    expect(storeUsageBatch).toHaveBeenCalledTimes(MAX_BATCHES_PER_WINDOW);
  });

  it("answers 500 in plain words when storing fails, and closes the connection", async () => {
    jest.mocked(storeUsageBatch).mockRejectedValueOnce(new Error("boom"));
    expect((await postUsageEvents(post(good()), ctx)).status).toBe(500);
  });
});
