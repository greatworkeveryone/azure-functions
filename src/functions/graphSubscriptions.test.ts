/// <reference types="jest" />
// The Graph mail subscription has a table now (migration 123), renewal heals
// an expired subscription instead of failing every night, and every row says
// which resource and which client state it was made with.
import { createHash } from "crypto";
import { HttpRequest, InvocationContext, Timer } from "@azure/functions";

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn(), storageQueue: jest.fn(), timer: jest.fn() } };
});
jest.mock("../db", () => ({
  closeConnection: jest.fn(),
  createRequestConnection: jest.fn().mockResolvedValue({}),
  createServiceRequestConnection: jest.fn().mockResolvedValue({}),
  executeQuery: jest.fn(),
}));
jest.mock("../auth", () => ({
  ...jest.requireActual("../auth"),
  extractToken: jest.fn().mockReturnValue("tok"),
  requireRole: jest.fn().mockResolvedValue(null),
}));
jest.mock("../graph", () => ({ graphCreateSubscription: jest.fn(), graphRenewSubscription: jest.fn() }));
jest.mock("../rateLimit", () => ({ checkRateLimit: jest.fn().mockReturnValue({ allowed: true, retryAfterMs: 0 }) }));

import { renewGraphSubscription, setupGraphSubscription } from "./graphWebhook";

const db = jest.requireMock("../db") as { executeQuery: jest.Mock };
const graph = jest.requireMock("../graph") as { graphCreateSubscription: jest.Mock; graphRenewSubscription: jest.Mock };
const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;
const RESOURCE = "users/inbox%40example.test/mailFolders/Inbox/messages";
const HASH = createHash("sha256").update("secret-state").digest("hex");

let existing: { SubscriptionID: string }[];
const call = (pattern: RegExp) => {
  const found = db.executeQuery.mock.calls.find((c: unknown[]) => pattern.test(String(c[1])));
  return found && {
    params: Object.fromEntries((found[2] as { name: string; value: unknown }[]).map((p) => [p.name, p.value])),
    sql: String(found[1]),
  };
};

beforeEach(() => {
  jest.clearAllMocks();
  process.env.GRAPH_MAILBOX_DEV = "inbox@example.test";
  process.env.GRAPH_NOTIFICATION_URL = "https://fn.test/api/graphNotification";
  process.env.GRAPH_SUBSCRIPTION_CLIENT_STATE = "secret-state";
  existing = [];
  db.executeQuery.mockImplementation(async (_c: unknown, sql: string) => (/SELECT SubscriptionID/.test(sql) ? existing : []));
  graph.graphCreateSubscription.mockResolvedValue({ expiresAt: "2026-10-17T03:00:00.1234567Z", resource: RESOURCE, subscriptionId: "sub-new" });
  graph.graphRenewSubscription.mockResolvedValue("2026-10-17T03:00:00Z");
});

describe("renewGraphSubscription", () => {
  it("creates a subscription when the mailbox has none, recording resource, client-state hash and a real expiry", async () => {
    await renewGraphSubscription({} as Timer, ctx);

    const merge = call(/MERGE dbo\.GraphSubscriptions/);
    expect(merge?.params).toMatchObject({ ClientStateHash: HASH, Mailbox: "inbox@example.test", Resource: RESOURCE, SubscriptionID: "sub-new" });
    expect(merge?.params.ExpiresAt).toEqual(new Date("2026-10-17T03:00:00.123Z"));
  });

  it("renews the stored subscription", async () => {
    existing = [{ SubscriptionID: "sub-1" }];

    await renewGraphSubscription({} as Timer, ctx);

    expect(graph.graphRenewSubscription).toHaveBeenCalledWith("sub-1");
    expect(call(/UPDATE dbo\.GraphSubscriptions SET ExpiresAt/)?.params).toEqual({ ExpiresAt: new Date("2026-10-17T03:00:00Z"), SubscriptionID: "sub-1" });
    expect(graph.graphCreateSubscription).not.toHaveBeenCalled();
  });

  it("replaces a subscription Graph no longer knows (expired) instead of failing every night", async () => {
    existing = [{ SubscriptionID: "sub-gone" }];
    graph.graphRenewSubscription.mockRejectedValue(Object.assign(new Error("Graph renewSubscription failed: 404"), { status: 404 }));

    await renewGraphSubscription({} as Timer, ctx);

    expect(graph.graphCreateSubscription).toHaveBeenCalled();
    expect(call(/MERGE dbo\.GraphSubscriptions/)?.params.SubscriptionID).toBe("sub-new");
  });

  it("fails loudly on any other renewal error", async () => {
    existing = [{ SubscriptionID: "sub-1" }];
    graph.graphRenewSubscription.mockRejectedValue(Object.assign(new Error("Graph renewSubscription failed: 503"), { status: 503 }));

    await expect(renewGraphSubscription({} as Timer, ctx)).rejects.toThrow(/503/);
    expect(graph.graphCreateSubscription).not.toHaveBeenCalled();
  });
});

describe("renewGraphSubscription: extra mailboxes (EB3)", () => {
  const EXTRA = ["accounts@example.test", "facilities@example.test"];
  const byMailbox = (mailbox: string) => db.executeQuery.mock.calls.filter((c: unknown[]) => /SELECT SubscriptionID/.test(String(c[1])) && (c[2] as { value: unknown }[])[0].value === mailbox);

  afterEach(() => {
    delete process.env.INBOUND_EXTRA_MAILBOXES;
  });

  it("renews or creates only the main mailbox's subscription when no extra mailbox is set", async () => {
    await renewGraphSubscription({} as Timer, ctx);
    expect(graph.graphCreateSubscription).toHaveBeenCalledTimes(1);
    expect(graph.graphCreateSubscription).toHaveBeenCalledWith("inbox@example.test", expect.any(String), "secret-state");
  });

  it("gives each extra mailbox its own subscription, so its mail arrives as promptly as the main one's", async () => {
    process.env.INBOUND_EXTRA_MAILBOXES = EXTRA.join(",");
    await renewGraphSubscription({} as Timer, ctx);
    expect(graph.graphCreateSubscription.mock.calls.map((c: unknown[]) => c[0])).toEqual(["inbox@example.test", ...EXTRA]);
    const merges = db.executeQuery.mock.calls.filter((c: unknown[]) => /MERGE dbo\.GraphSubscriptions/.test(String(c[1])));
    expect(merges.map((c: unknown[]) => (c[2] as { name: string; value: unknown }[]).find((p) => p.name === "Mailbox")?.value)).toEqual(["inbox@example.test", ...EXTRA]);
    expect(byMailbox("accounts@example.test")).toHaveLength(1);
  });

  it("renews an extra mailbox's stored subscription by its own id", async () => {
    process.env.INBOUND_EXTRA_MAILBOXES = EXTRA[0];
    db.executeQuery.mockImplementation(async (_c: unknown, sql: string, params: { value: unknown }[]) => (/SELECT SubscriptionID/.test(sql) ? [{ SubscriptionID: `sub-for-${String(params[0].value)}` }] : []));
    await renewGraphSubscription({} as Timer, ctx);
    expect(graph.graphRenewSubscription.mock.calls.map((c: unknown[]) => c[0])).toEqual(["sub-for-inbox@example.test", "sub-for-accounts@example.test"]);
  });

  it("does not stop at an extra mailbox that fails: the others are renewed, and the run still ends in error so it is recorded", async () => {
    process.env.INBOUND_EXTRA_MAILBOXES = EXTRA.join(",");
    existing = [{ SubscriptionID: "sub-1" }];
    graph.graphRenewSubscription.mockImplementation(async (id: string) => {
      if (graph.graphRenewSubscription.mock.calls.length === 2) throw Object.assign(new Error("Graph renewSubscription failed: 403"), { status: 403 });
      return `2026-10-17T03:00:0${id.length % 9}Z`;
    });
    await expect(renewGraphSubscription({} as Timer, ctx)).rejects.toThrow("could not renew the subscription for accounts@example.test");
    expect(graph.graphRenewSubscription).toHaveBeenCalledTimes(3);
  });

  it("a failing main mailbox is still thrown at once, before any extra is touched", async () => {
    process.env.INBOUND_EXTRA_MAILBOXES = EXTRA[0];
    existing = [{ SubscriptionID: "sub-1" }];
    graph.graphRenewSubscription.mockRejectedValue(Object.assign(new Error("Graph renewSubscription failed: 503"), { status: 503 }));
    await expect(renewGraphSubscription({} as Timer, ctx)).rejects.toThrow(/503/);
    expect(graph.graphRenewSubscription).toHaveBeenCalledTimes(1);
  });
});

describe("setupGraphSubscription", () => {
  it("stores the new subscription with its resource and client-state hash", async () => {
    const req = { headers: { get: () => null } } as unknown as HttpRequest;
    const res = await setupGraphSubscription(req, ctx);

    expect(res.status).toBe(200);
    expect(call(/MERGE dbo\.GraphSubscriptions/)?.params).toMatchObject({ ClientStateHash: HASH, Resource: RESOURCE, SubscriptionID: "sub-new" });
  });
});
