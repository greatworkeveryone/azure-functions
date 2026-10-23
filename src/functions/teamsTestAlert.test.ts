/// <reference types="jest" />
// WP63 Test 1: an admin sends one Teams alert to a user through the real sender.
import type { HttpRequest, InvocationContext } from "@azure/functions";

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn(), storageQueue: jest.fn(), timer: jest.fn() } };
});
jest.mock("../db", () => ({
  closeConnection: jest.fn(),
  createRequestConnection: jest.fn().mockResolvedValue({}),
  executeQuery: jest.fn(),
}));
jest.mock("../auth", () => ({
  ...jest.requireActual("../auth"),
  extractToken: jest.fn().mockReturnValue("tok"),
  requireRole: jest.fn().mockResolvedValue(null),
}));
jest.mock("../teams/activity", () => ({ sendActivityNotification: jest.fn() }));
jest.mock("../features/flags", () => ({ isFeatureEnabledForRoles: jest.fn().mockResolvedValue(false) }));
jest.mock("../alerts/rateCap", () => ({ claimWorkflowsSlot: jest.fn().mockResolvedValue(true) }));

import { AppRole } from "../auth";
import { NOT_A_RECORD } from "../test-data";
import { TEAMS_TEST_USER_SQL, teamsTestAlert } from "./teamsTestAlert";

const auth = require("../auth") as { extractToken: jest.Mock; requireRole: jest.Mock };
const db = require("../db") as { executeQuery: jest.Mock };
const activity = require("../teams/activity") as { sendActivityNotification: jest.Mock };
const flags = require("../features/flags") as { isFeatureEnabledForRoles: jest.Mock };
const rateCap = require("../alerts/rateCap") as { claimWorkflowsSlot: jest.Mock };

const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;
const post = (body: unknown) => ({ headers: { get: () => null }, json: async () => body }) as unknown as HttpRequest;
const ENV_KEYS = [
  "TEAMS_ALERTS_ENABLED",
  "TEAMS_ALERTS_DRY_RUN",
  "TEAMS_APP_ID",
  "TEAMS_ALERTS_ROUTE",
  "TEAMS_WORKFLOW_WEBHOOK_URL",
  "TEAMS_WORKFLOW_KEY",
  "ORG_EMAIL_DOMAINS",
] as const;

beforeEach(() => {
  jest.clearAllMocks();
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.TEAMS_ALERTS_ROUTE = "app";
  auth.extractToken.mockReturnValue("tok");
  auth.requireRole.mockResolvedValue(null);
  db.executeQuery.mockResolvedValue([{ Email: "gus@randazzo.properties", EntraOid: " oid-7 ", Role: "director", UserID: 7 }]);
  activity.sendActivityNotification.mockResolvedValue({ mode: "live", status: "sent" });
});

afterAll(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

describe("teamsTestAlert", () => {
  it("needs a token and is for admins only", async () => {
    auth.extractToken.mockReturnValueOnce(null);
    expect((await teamsTestAlert(post({ userId: 7 }), ctx)).status).toBe(401);
    await teamsTestAlert(post({ userId: 7 }), ctx);
    expect(auth.requireRole.mock.calls[0][1]).toEqual([AppRole.ADMIN]);
    auth.requireRole.mockResolvedValue({ jsonBody: { error: "Forbidden" }, status: 403 });
    expect((await teamsTestAlert(post({ userId: 7 }), ctx)).status).toBe(403);
    expect(db.executeQuery).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["no body", null],
    ["missing userId", {}],
    ["text userId", { userId: "7" }],
    ["fractional userId", { userId: 1.5 }],
    ["zero userId", { userId: 0 }],
    ["open redirect route", { route: "//evil.com", userId: 7 }],
    ["off-list route", { route: "/admin/users", userId: 7 }],
    ["non-string route", { route: 5, userId: 7 }],
  ])("400s on %s, before the database", async (_label, body) => {
    expect((await teamsTestAlert(post(body), ctx)).status).toBe(400);
    expect(db.executeQuery).not.toHaveBeenCalled();
    expect(activity.sendActivityNotification).not.toHaveBeenCalled();
  });

  it("looks the oid up by a parameter and sends one alert to /dashboard by default", async () => {
    process.env.TEAMS_ALERTS_ENABLED = "true";
    process.env.TEAMS_APP_ID = "app-1";
    const res = await teamsTestAlert(post({ userId: 7 }), ctx);
    expect(db.executeQuery.mock.calls[0][1]).toBe(TEAMS_TEST_USER_SQL);
    expect(db.executeQuery.mock.calls[0][2]).toEqual([expect.objectContaining({ name: "UserID", value: 7 })]);
    expect(activity.sendActivityNotification).toHaveBeenCalledWith(
      "oid-7",
      expect.objectContaining({ egress: NOT_A_RECORD, route: "/dashboard" }),
      expect.anything(),
    );
    expect(res).toEqual({ jsonBody: { alertsRoute: "app", flagEnabled: false, mode: "live", result: { mode: "live", status: "sent" }, route: "/dashboard", userId: 7 }, status: 200 });
  });

  it("reports the mode, so off reads as off", async () => {
    activity.sendActivityNotification.mockResolvedValue({ mode: "off", status: "skipped" });
    const res = await teamsTestAlert(post({ route: "/jobs?jobId=1&step=decision", userId: 7 }), ctx);
    expect(res.jsonBody).toMatchObject({ mode: "off", result: { status: "skipped" }, route: "/jobs?jobId=1&step=decision" });
  });

  it("passes the sender's typed failure straight back", async () => {
    process.env.TEAMS_ALERTS_ENABLED = "true";
    process.env.TEAMS_APP_ID = "app-1";
    const failure = { error: "Forbidden", httpStatus: 403, mode: "live", status: "not_permitted" };
    activity.sendActivityNotification.mockResolvedValue(failure);
    const res = await teamsTestAlert(post({ userId: 7 }), ctx);
    expect(res.status).toBe(200);
    expect(res.jsonBody).toMatchObject({ result: failure });
  });

  it("400s when the user has no Entra oid, and 404s when there is no such user", async () => {
    db.executeQuery.mockResolvedValueOnce([{ EntraOid: null, UserID: 7 }]);
    expect((await teamsTestAlert(post({ userId: 7 }), ctx)).status).toBe(400);
    db.executeQuery.mockResolvedValueOnce([]);
    expect((await teamsTestAlert(post({ userId: 8 }), ctx)).status).toBe(404);
    expect(activity.sendActivityNotification).not.toHaveBeenCalled();
  });

  it("503s when enabled without TEAMS_APP_ID", async () => {
    process.env.TEAMS_ALERTS_ENABLED = "true";
    const res = await teamsTestAlert(post({ userId: 7 }), ctx);
    expect(res.status).toBe(503);
    expect(db.executeQuery).not.toHaveBeenCalled();
  });

  it("500s, logged, when the sender throws", async () => {
    activity.sendActivityNotification.mockRejectedValue(new Error("boom"));
    expect((await teamsTestAlert(post({ userId: 7 }), ctx)).status).toBe(500);
    expect(ctx.error).toHaveBeenCalled();
  });
});

describe("teamsTestAlert on the workflows route", () => {
  const fetchMock = jest.fn();
  const realFetch = global.fetch;
  beforeEach(() => {
    delete process.env.TEAMS_ALERTS_ROUTE; // default is workflows
    process.env.TEAMS_ALERTS_ENABLED = "true";
    process.env.TEAMS_WORKFLOW_WEBHOOK_URL = "https://flow.example/hook?sig=SECRET";
    process.env.TEAMS_WORKFLOW_KEY = "KEY";
    process.env.ORG_EMAIL_DOMAINS = "randazzo.properties";
    fetchMock.mockReset().mockResolvedValue({ status: 202 });
    global.fetch = fetchMock as unknown as typeof fetch;
  });
  afterAll(() => {
    global.fetch = realFetch;
  });

  it("is the default route: posts recipient, route and kind only, and reports route and flag state", async () => {
    flags.isFeatureEnabledForRoles.mockResolvedValue(true);
    const res = await teamsTestAlert(post({ route: "/jobs?jobId=1", userId: 7 }), ctx);
    expect(activity.sendActivityNotification).not.toHaveBeenCalled();
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ kind: "escalation", recipient: "gus@randazzo.properties", route: "/jobs?jobId=1" });
    expect(res.jsonBody).toMatchObject({ alertsRoute: "workflows", flagEnabled: true, mode: "live", result: { status: "sent" } });
    expect(flags.isFeatureEnabledForRoles).toHaveBeenCalledWith("teamsAlerts", ["director"], expect.anything());
  });

  it("still sends with the flag off (reported, not enforced) and uses the rate cap", async () => {
    flags.isFeatureEnabledForRoles.mockResolvedValue(false);
    rateCap.claimWorkflowsSlot.mockResolvedValueOnce(false);
    const res = await teamsTestAlert(post({ userId: 7 }), ctx);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.jsonBody).toMatchObject({ flagEnabled: false, result: { detail: "rate cap reached", status: "skipped" } });
  });

  it("400s when the user has no email, 503s when the flow is not configured", async () => {
    db.executeQuery.mockResolvedValueOnce([{ Email: null, Role: "director", UserID: 7 }]);
    expect((await teamsTestAlert(post({ userId: 7 }), ctx)).status).toBe(400);
    delete process.env.TEAMS_WORKFLOW_KEY;
    expect((await teamsTestAlert(post({ userId: 7 }), ctx)).status).toBe(503);
  });
});
