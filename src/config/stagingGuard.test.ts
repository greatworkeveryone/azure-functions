/// <reference types="jest" />
jest.mock("../db", () => ({
  closeConnection: jest.fn(),
  createServiceRequestConnection: jest.fn(),
  executeQuery: jest.fn(),
}));
jest.mock("../sentry", () => ({ Sentry: { captureException: jest.fn(), captureMessage: jest.fn(), flush: jest.fn() } }));

import type { InvocationContext } from "@azure/functions";
import { workflowsChannel } from "../alerts/channel";
import { createGraphSender } from "../comms/graphSend";
import { graphCreateSubscription, graphFetchEmailPages, graphRenewSubscription, graphSendMail, graphSendReply } from "../graph";
import { parseEmailsDailyRetry, parseEmailsTimer, processEmailSync } from "../functions/parseEmails";
import { renewGraphSubscription } from "../functions/graphWebhook";
import { myobReadbackTimer } from "../functions/myobReadbackTimer";
import { myobRequest, MyobNotConnectedOnStagingError, MyobRequestRefusedError } from "../myob-api-log";
import { guardMyobRequest } from "../myob-request-guard";
import { sendActivityNotification } from "../teams/activity";
import { NOT_A_RECORD } from "../test-data";
import { mayPushWorkRequests } from "./mybuildingsSwitches";
import { isStaging, skipOnStaging } from "./stagingGuard";

const fetchMock = jest.fn();
const saved = { ...process.env };
const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;
const draft = { from: { address: "n@example.test", name: "N" }, html: "<p>x</p>", replyTo: { address: "a@example.test", name: null }, subject: "S", to: "pat@example.test" };
const ACTOR = { kind: "system", name: "test" } as const;

beforeEach(() => {
  jest.clearAllMocks();
  fetchMock.mockReset().mockResolvedValue(new Response("{}", { status: 200 }));
  global.fetch = fetchMock as unknown as typeof fetch;
  process.env = { ...saved, AZURE_FUNCTIONS_ENVIRONMENT: "Staging", MYOB_WRITES_ENABLED: "true", GRAPH_SENDER_EMAIL: "n@example.test", TEAMS_ALERTS_ENABLED: "true" };
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterAll(() => {
  process.env = saved;
});

describe("isStaging", () => {
  it("is true only for exactly Staging", () => {
    expect(isStaging({ AZURE_FUNCTIONS_ENVIRONMENT: "Staging" })).toBe(true);
    for (const value of ["Production", "Development", "staging", undefined]) expect(isStaging({ AZURE_FUNCTIONS_ENVIRONMENT: value })).toBe(false);
  });
  it("skipOnStaging logs and says skip only on staging", () => {
    const log = jest.fn();
    expect(skipOnStaging(log, "x", { AZURE_FUNCTIONS_ENVIRONMENT: "Production" })).toBe(false);
    expect(log).not.toHaveBeenCalled();
    expect(skipOnStaging(log, "x", { AZURE_FUNCTIONS_ENVIRONMENT: "Staging" })).toBe(true);
    expect(log).toHaveBeenCalledWith("staging: x skipped");
  });
});

describe("on staging: outbound email makes no network call", () => {
  it("graphSendMail and graphSendReply succeed without fetch", async () => {
    await expect(graphSendMail(NOT_A_RECORD, "pat@example.test", "S", "B")).resolves.toBeUndefined();
    const id = await graphSendReply(NOT_A_RECORD, "pat@example.test", "S", "B", null);
    expect(id).toMatch(/^graph-sent-staging-/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith("staging: email not sent");
    expect(JSON.stringify((console.warn as jest.Mock).mock.calls)).not.toContain("pat@example.test");
  });

  it("the comms sender returns a synthetic draft and sends nothing", async () => {
    const token = jest.fn(async () => "tok");
    const sender = createGraphSender(fetchMock as unknown as typeof fetch, token);
    const created = await sender.createDraft(draft);
    expect(created.graphMessageId).toMatch(/^staging-not-sent-/);
    await sender.sendDraft("n@example.test", created.graphMessageId);
    await sender.sendWithoutCopy(draft);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(token).not.toHaveBeenCalled();
  });

  it("outside staging the sender still calls Graph", async () => {
    process.env.AZURE_FUNCTIONS_ENVIRONMENT = "Production";
    fetchMock.mockResolvedValue(new Response(null, { status: 202 }));
    await createGraphSender(fetchMock as unknown as typeof fetch, async () => "tok").sendWithoutCopy(draft);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("on staging: no mailbox is read", () => {
  it("the Graph read and subscription calls fail closed without fetch", async () => {
    await expect(graphCreateSubscription("m@example.test", "https://x.test", "s")).rejects.toThrow(/staging/);
    await expect(graphRenewSubscription("sub")).rejects.toThrow(/staging/);
    await expect(graphFetchEmailPages("m@example.test").next()).rejects.toThrow(/staging/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("the mail timers and the sync queue skip early", async () => {
    await parseEmailsTimer(undefined, ctx);
    await parseEmailsDailyRetry(undefined, ctx);
    await processEmailSync({ source: "admin" }, ctx);
    await renewGraphSubscription(undefined, ctx);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining("staging:"));
    expect(ctx.error).not.toHaveBeenCalled();
  });
});

describe("on staging: MYOB fails closed", () => {
  it("myobRequest throws the typed refusal for a read, a write and OAuth, and never fetches", async () => {
    const cf = "0f9e8d7c-6b5a-4f3e-9d2c-1b0a99887766";
    for (const [method, url] of [
      ["GET", `https://api.myob.com/accountright/${cf}/Purchase/Order/Item`],
      ["POST", `https://api.myob.com/accountright/${cf}/Purchase/Order/Item`],
      ["POST", "https://secure.myob.com/oauth2/v1/authorize"],
    ] as const) {
      const call = myobRequest({ actor: ACTOR, headers: {}, method, purpose: "test", url });
      await expect(call).rejects.toBeInstanceOf(MyobNotConnectedOnStagingError);
      await expect(call).rejects.toThrow("MYOB is not connected on staging");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is a refusal, which timers count as a skip, and guardMyobRequest refuses too", async () => {
    await expect(guardMyobRequest({ method: "GET", url: "https://secure.myob.com/oauth2/v1/authorize" })).rejects.toBeInstanceOf(MyobRequestRefusedError);
  });

  it("the read-back timer skips with no error", async () => {
    process.env.MYOB_READBACK_ENABLED = "true";
    await expect(myobReadbackTimer(undefined as never, ctx)).resolves.toEqual({ skipped: true });
    expect(ctx.error).not.toHaveBeenCalled();
  });
});

describe("on staging: myBuildings never pushes", () => {
  it("mayPush is false whatever the settings", () => {
    expect(mayPushWorkRequests({ AZURE_FUNCTIONS_ENVIRONMENT: "Staging", MYBUILDINGS_PUSH_ENABLED: "true", MYBUILDINGS_SYNC_MODE: "normal" })).toBe(false);
    expect(mayPushWorkRequests({ AZURE_FUNCTIONS_ENVIRONMENT: "Production" })).toBe(true);
    expect(mayPushWorkRequests({})).toBe(true);
  });
});

describe("on staging: Teams alerts post nothing", () => {
  const alert = { egress: NOT_A_RECORD, kind: "escalation" as const, previewText: "p", route: "/jobs", text: "t" };
  it("the activity feed route skips", async () => {
    const env = { AZURE_FUNCTIONS_ENVIRONMENT: "Staging", TEAMS_ALERTS_ENABLED: "true", TEAMS_APP_ID: "app" };
    const result = await sendActivityNotification("oid", alert, { env, fetch: fetchMock as unknown as typeof fetch, getToken: async () => "t", log: jest.fn() });
    expect(result.status).toBe("skipped");
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("the Workflows route skips, and posts outside staging", async () => {
    const base = { ORG_EMAIL_DOMAINS: "example.test", TEAMS_ALERTS_ENABLED: "true", TEAMS_WORKFLOW_KEY: "k", TEAMS_WORKFLOW_WEBHOOK_URL: "https://flow.test/x" };
    const channel = (env: NodeJS.ProcessEnv) => workflowsChannel({ claimSlot: async () => true, env, fetch: fetchMock as unknown as typeof fetch, log: jest.fn() });
    const target = { email: "pat@example.test", entraOid: null };
    const onStaging = await channel({ ...base, AZURE_FUNCTIONS_ENVIRONMENT: "Staging" }).send(target, alert);
    expect(onStaging.status).toBe("skipped");
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValue(new Response(null, { status: 202 }));
    const live = await channel({ ...base, AZURE_FUNCTIONS_ENVIRONMENT: "Production" }).send(target, alert);
    expect(live.status).toBe("sent");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("what counts as staging", () => {
  it.each([
    [{ AZURE_FUNCTIONS_ENVIRONMENT: "Staging" }, true],
    [{ AZURE_FUNCTIONS_ENVIRONMENT: " staging " }, true],
    [{ WEBSITE_SITE_NAME: "rpcc-api-staging" }, true],
    [{ AZURE_FUNCTIONS_ENVIRONMENT: "Production", WEBSITE_SITE_NAME: "rpcc-api-staging" }, true],
    [{ AZURE_FUNCTIONS_ENVIRONMENT: "Production", WEBSITE_SITE_NAME: "rpcc-api2" }, false],
    [{}, false],
  ])("%j is %s", (env, expected) => {
    expect(isStaging(env)).toBe(expected);
  });
});
