/// <reference types="jest" />
import { HttpRequest, InvocationContext } from "@azure/functions";

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn(), storageQueue: jest.fn(), timer: jest.fn() } };
});

jest.mock("../db", () => ({
  closeConnection: jest.fn(),
  createRequestConnection: jest.fn().mockResolvedValue({}),
  createServiceConnection: jest.fn().mockResolvedValue({}),
  createServiceRequestConnection: jest.fn().mockResolvedValue({}),
  executeQuery: jest.fn().mockResolvedValue([]),
}));

jest.mock("../auth", () => {
  const actual = jest.requireActual("../auth");
  return {
    ...actual,
    extractToken: jest.fn().mockReturnValue("tok"),
    requireRole: jest.fn().mockResolvedValue(null),
  };
});

jest.mock("../graph", () => ({
  graphCreateSubscription: jest.fn(),
  graphFetchEmails: jest.fn().mockResolvedValue([]),
  graphRenewSubscription: jest.fn(),
}));

jest.mock("../blob-storage", () => ({ generateReadSasUrl: jest.fn() }));

jest.mock("./parseEmails", () => ({
  runParseBatch: jest.fn().mockResolvedValue({ claimed: 0, errored: 0, flagged: 0, succeeded: 0 }),
}));

jest.mock("../rateLimit", () => ({
  checkRateLimit: jest.fn().mockReturnValue({ allowed: true, retryAfterMs: 0 }),
}));

import { emailSyncQueueOutput } from "../email/sync-queue";

const db = require("../db") as { createServiceRequestConnection: jest.Mock; executeQuery: jest.Mock };
const graph = require("../graph") as { graphFetchEmails: jest.Mock };
const parseEmails = require("./parseEmails") as { runParseBatch: jest.Mock };

type Handler = (req: HttpRequest, ctx: InvocationContext) => Promise<{ status?: number; jsonBody?: unknown }>;
const { graphNotification } = require("./graphWebhook") as { graphNotification: Handler };
const { syncEmailsNow } = require("./emails") as { syncEmailsNow: Handler };

function notification(clientState: string): HttpRequest {
  return {
    json: async () => ({ value: [{ changeType: "created", clientState, resource: "x" }] }),
    url: "https://fn.test/api/graphNotification",
  } as unknown as HttpRequest;
}

function expectNothingSyncedOrParsed(): void {
  expect(graph.graphFetchEmails).not.toHaveBeenCalled();
  expect(db.createServiceRequestConnection).not.toHaveBeenCalled();
  expect(db.executeQuery).not.toHaveBeenCalled();
  expect(parseEmails.runParseBatch).not.toHaveBeenCalled();
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.GRAPH_SUBSCRIPTION_CLIENT_STATE = "secret-state";
  process.env.GRAPH_MAILBOX_DEV = "inbox@example.test";
  // Only the pre-change handler reads this; set so the red run reaches the
  // sync instead of returning early on a missing token.
  process.env.MYBUILDINGS_BEARER_TOKEN = "tok";
});

describe("graphNotification", () => {
  it("enqueues one email-sync message and returns 202 without syncing or parsing", async () => {
    const context = new InvocationContext();

    const res = await graphNotification(notification("secret-state"), context);

    expect(res.status).toBe(202);
    expect(context.extraOutputs.get(emailSyncQueueOutput)).toMatchObject({ source: "graph" });
    expectNothingSyncedOrParsed();
  });

  it("returns 202 and enqueues nothing when clientState does not match", async () => {
    const context = new InvocationContext();

    const res = await graphNotification(notification("wrong"), context);

    expect(res.status).toBe(202);
    expect(context.extraOutputs.get(emailSyncQueueOutput)).toBeUndefined();
    expectNothingSyncedOrParsed();
  });
});

describe("graphNotification → robustness", () => {
  function requestWithBody(json: () => Promise<unknown>): HttpRequest {
    return { json, url: "https://fn.test/api/graphNotification" } as unknown as HttpRequest;
  }

  it("echoes validationToken as text/plain with 200", async () => {
    const context = new InvocationContext();
    const request = { json: jest.fn(), url: "https://fn.test/api/graphNotification?validationToken=abc%20123" } as unknown as HttpRequest;

    const res = (await graphNotification(request, context)) as { status?: number; headers?: Record<string, string>; body?: string };

    expect(res.status).toBe(200);
    expect(res.headers).toMatchObject({ "Content-Type": "text/plain" });
    expect(res.body).toBe("abc 123");
    expect(context.extraOutputs.get(emailSyncQueueOutput)).toBeUndefined();
  });

  it.each([
    ["value is an object", async () => ({ value: {} })],
    ["value holds null", async () => ({ value: [null] })],
    ["value holds a non-object", async () => ({ value: ["x", 1] })],
    ["value is missing", async () => ({})],
    ["body is null", async () => null],
    ["body is not JSON", async () => { throw new SyntaxError("Unexpected token"); }],
  ])("returns 202 with no enqueue and a 'no notifications' warning when %s", async (_label, json) => {
    const context = new InvocationContext();
    const warn = jest.spyOn(context, "warn").mockImplementation(() => undefined);

    const res = await graphNotification(requestWithBody(json), context);

    expect(res.status).toBe(202);
    expect(context.extraOutputs.get(emailSyncQueueOutput)).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("no notifications in body"));
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("clientState mismatch"));
  });

  it("skips bad entries but still enqueues for a valid one", async () => {
    const context = new InvocationContext();
    const body = { value: [null, "x", { clientState: "secret-state" }] };

    const res = await graphNotification(requestWithBody(async () => body), context);

    expect(res.status).toBe(202);
    expect(context.extraOutputs.get(emailSyncQueueOutput)).toMatchObject({ source: "graph" });
  });

  it("warns about clientState mismatch (not 'no notifications') when entries exist but none match", async () => {
    const context = new InvocationContext();
    const warn = jest.spyOn(context, "warn").mockImplementation(() => undefined);

    await graphNotification(notification("wrong"), context);

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("clientState mismatch"));
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("no notifications in body"));
  });
});

describe("syncEmailsNow", () => {
  it("enqueues a manual sync and returns 202 without touching Graph or SQL", async () => {
    const context = new InvocationContext();
    const request = { headers: { get: () => null }, json: jest.fn(), query: new URLSearchParams() } as unknown as HttpRequest;

    const res = await syncEmailsNow(request, context);

    expect(res.status).toBe(202);
    expect(context.extraOutputs.get(emailSyncQueueOutput)).toMatchObject({ source: "manual" });
    expectNothingSyncedOrParsed();
  });
});
