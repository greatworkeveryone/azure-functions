/// <reference types="jest" />
import { resolveAlertChannels, teamsChannel, workflowsChannel } from "./channel";
import type { Alert } from "./channel";
import { NOT_A_RECORD } from "../test-data";

const ALERT: Alert = { egress: NOT_A_RECORD, kind: "escalation", previewText: "Floorplan: urgent item needs you", route: "/jobs?jobId=12", text: "Open it." };
const ENV_LIVE = { TEAMS_ALERTS_ENABLED: "true", TEAMS_ALERTS_ROUTE: "app", TEAMS_APP_ID: "app-1" } as NodeJS.ProcessEnv;
const WF_ENV = {
  ORG_EMAIL_DOMAINS: "randazzo.properties, example.org",
  TEAMS_ALERTS_ENABLED: "true",
  TEAMS_WORKFLOW_KEY: "KEY-SECRET",
  TEAMS_WORKFLOW_WEBHOOK_URL: "https://flow.example/hook?sig=URL-SECRET",
} as NodeJS.ProcessEnv;

describe("resolveAlertChannels", () => {
  it("has teams when alerts are live or dry-run and the app id is set", () => {
    expect(resolveAlertChannels(ENV_LIVE).map((c) => c.name)).toEqual(["teams"]);
    expect(resolveAlertChannels({ TEAMS_ALERTS_DRY_RUN: "true", TEAMS_APP_ID: "app-1" } as NodeJS.ProcessEnv)).toHaveLength(1);
  });

  it("has none when the mode is off or TEAMS_APP_ID is missing", () => {
    expect(resolveAlertChannels({ TEAMS_ALERTS_ROUTE: "app", TEAMS_APP_ID: "app-1" } as NodeJS.ProcessEnv)).toEqual([]);
    expect(resolveAlertChannels({ TEAMS_ALERTS_ENABLED: "true", TEAMS_ALERTS_ROUTE: "app" } as NodeJS.ProcessEnv)).toEqual([]);
    expect(resolveAlertChannels({} as NodeJS.ProcessEnv)).toEqual([]);
  });

  it("route selection: app = teams, workflows (the default) = workflows, never both", () => {
    expect(resolveAlertChannels({ ...WF_ENV, TEAMS_ALERTS_ROUTE: "app", TEAMS_APP_ID: "app-1" } as NodeJS.ProcessEnv).map((c) => c.name)).toEqual(["teams"]);
    expect(resolveAlertChannels(WF_ENV).map((c) => c.name)).toEqual(["workflows"]);
    expect(resolveAlertChannels({ ...WF_ENV, TEAMS_ALERTS_ROUTE: "workflows", TEAMS_APP_ID: "app-1" } as NodeJS.ProcessEnv).map((c) => c.name)).toEqual(["workflows"]);
    expect(resolveAlertChannels({ ...WF_ENV, TEAMS_ALERTS_ROUTE: "junk" } as NodeJS.ProcessEnv).map((c) => c.name)).toEqual(["workflows"]);
  });

  it("workflows needs its URL and key when live, and nothing when the mode is off", () => {
    expect(resolveAlertChannels({ ...WF_ENV, TEAMS_WORKFLOW_KEY: " " } as NodeJS.ProcessEnv)).toEqual([]);
    expect(resolveAlertChannels({ ...WF_ENV, TEAMS_WORKFLOW_WEBHOOK_URL: undefined } as NodeJS.ProcessEnv)).toEqual([]);
    expect(resolveAlertChannels({ ...WF_ENV, TEAMS_ALERTS_ENABLED: undefined } as NodeJS.ProcessEnv)).toEqual([]);
    expect(resolveAlertChannels({ TEAMS_ALERTS_DRY_RUN: "true" } as NodeJS.ProcessEnv)).toHaveLength(1);
  });

  it("the workflows channel is rate-capped by the injected claim", async () => {
    const [channel] = resolveAlertChannels(WF_ENV, { claimSlot: async () => false });
    await expect(channel.send({ email: "a@randazzo.properties", entraOid: null }, ALERT)).resolves.toMatchObject({ status: "skipped" });
  });

  it("with no connection or claim there is no cap to enforce, so no post", async () => {
    const [channel] = resolveAlertChannels(WF_ENV);
    await expect(channel.send({ email: "a@randazzo.properties", entraOid: null }, ALERT)).resolves.toMatchObject({ status: "skipped" });
  });
});

describe("teamsChannel", () => {
  const send = (status: number) =>
    teamsChannel({
      env: ENV_LIVE,
      fetch: jest.fn().mockResolvedValue({ headers: new Headers(), ok: status < 300, status, text: async () => "denied" }) as unknown as typeof fetch,
      getToken: async () => "tok",
    }).send({ email: null, entraOid: "oid-1" }, ALERT);

  it("reports sent on a 204", async () => {
    await expect(send(204)).resolves.toEqual({ detail: null, status: "sent" });
  });

  it("passes the typed failure and its error text through", async () => {
    await expect(send(404)).resolves.toEqual({ detail: "denied", status: "no_user" });
  });

  it("reports dry_run without sending", async () => {
    const fetchMock = jest.fn();
    const channel = teamsChannel({ env: { TEAMS_ALERTS_DRY_RUN: "true", TEAMS_APP_ID: "app-1" } as NodeJS.ProcessEnv, fetch: fetchMock, log: jest.fn() });
    await expect(channel.send({ email: null, entraOid: "oid-1" }, ALERT)).resolves.toMatchObject({ status: "dry_run" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("workflowsChannel", () => {
  const TARGET = { email: "gus@randazzo.properties", entraOid: null };
  const make = (status: number | Error, over: { claim?: boolean; env?: NodeJS.ProcessEnv; log?: jest.Mock } = {}) => {
    const fetchMock = jest.fn(async () => {
      if (status instanceof Error) throw status;
      return { status } as Response;
    });
    const claimSlot = jest.fn().mockResolvedValue(over.claim ?? true);
    const log = over.log ?? jest.fn();
    const channel = workflowsChannel({ claimSlot, env: over.env ?? WF_ENV, fetch: fetchMock as unknown as typeof fetch, log });
    return { channel, claimSlot, fetchMock, log };
  };

  it.each([
    [202, "sent"],
    [200, "failed"],
    [400, "failed"],
    [401, "not_permitted"],
    [403, "not_permitted"],
    [404, "not_permitted"],
    [429, "retry"],
    [500, "retry"],
    [503, "retry"],
  ])("maps HTTP %i to %s", async (httpStatus, expected) => {
    const { channel } = make(httpStatus);
    await expect(channel.send(TARGET, ALERT)).resolves.toMatchObject({ status: expected });
  });

  it("maps a network error to retry without leaking the URL", async () => {
    const { channel } = make(new Error("connect ECONNREFUSED https://flow.example/hook?sig=URL-SECRET"));
    const result = await channel.send(TARGET, ALERT);
    expect(result.status).toBe("retry");
    expect(JSON.stringify(result)).not.toContain("URL-SECRET");
  });

  it("posts only recipient, route and kind, with the key header, once", async () => {
    const { channel, fetchMock } = make(202);
    await channel.send(TARGET, { ...ALERT, kind: "decision" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toBe("https://flow.example/hook?sig=URL-SECRET");
    expect(init.method).toBe("POST");
    expect(init.headers["x-floorplan-key"]).toBe("KEY-SECRET");
    expect(JSON.parse(String(init.body))).toEqual({ kind: "decision", recipient: "gus@randazzo.properties", route: "/jobs?jobId=12" });
  });

  it("refuses a recipient outside ORG_EMAIL_DOMAINS, a lookalike domain, or an empty domain list", async () => {
    for (const email of ["x@evil.com", "x@randazzo.properties.evil.com", "x@sub.randazzo.properties", "not-an-address"]) {
      const { channel, fetchMock, claimSlot } = make(202);
      await expect(channel.send({ email, entraOid: null }, ALERT)).resolves.toMatchObject({ status: "failed" });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(claimSlot).not.toHaveBeenCalled();
    }
    const { channel, fetchMock } = make(202, { env: { ...WF_ENV, ORG_EMAIL_DOMAINS: "" } as NodeJS.ProcessEnv });
    await expect(channel.send(TARGET, ALERT)).resolves.toMatchObject({ status: "failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses an unsafe route", async () => {
    for (const route of ["//evil.com", "https://evil.com", "/admin/users", "/jobs/../x"]) {
      const { channel, fetchMock } = make(202);
      await expect(channel.send(TARGET, { ...ALERT, route })).resolves.toMatchObject({ detail: "unsafe route", status: "failed" });
      expect(fetchMock).not.toHaveBeenCalled();
    }
  });

  it("has no email, no send", async () => {
    const { channel, fetchMock } = make(202);
    await expect(channel.send({ email: null, entraOid: null }, ALERT)).resolves.toMatchObject({ status: "no_user" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a test record before anything else", async () => {
    const { channel, fetchMock, claimSlot } = make(202);
    const testAlert = { ...ALERT, egress: { channel: "email", isTest: true } as unknown as Alert["egress"] };
    await expect(channel.send(TARGET, testAlert)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(claimSlot).not.toHaveBeenCalled();
  });

  it("over the cap: skipped, no post", async () => {
    const { channel, fetchMock } = make(202, { claim: false });
    await expect(channel.send(TARGET, ALERT)).resolves.toMatchObject({ detail: "rate cap reached", status: "skipped" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("dry-run logs without the URL or key and posts nothing or claims nothing", async () => {
    const log = jest.fn();
    const { channel, fetchMock, claimSlot } = make(202, { env: { ...WF_ENV, TEAMS_ALERTS_DRY_RUN: "true" } as NodeJS.ProcessEnv, log });
    await expect(channel.send(TARGET, ALERT)).resolves.toMatchObject({ status: "dry_run" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(claimSlot).not.toHaveBeenCalled();
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/SECRET/);
  });

  it("mode off sends nothing", async () => {
    const { channel, fetchMock } = make(202, { env: { ...WF_ENV, TEAMS_ALERTS_ENABLED: undefined } as NodeJS.ProcessEnv });
    await expect(channel.send(TARGET, ALERT)).resolves.toMatchObject({ status: "skipped" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never logs the URL or key on any outcome", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    const log = jest.fn();
    for (const status of [202, 401, 500, new Error("boom https://flow.example/hook?sig=URL-SECRET")]) {
      await make(status, { log }).channel.send(TARGET, ALERT);
    }
    expect(JSON.stringify([log.mock.calls, warn.mock.calls])).not.toMatch(/SECRET/);
    warn.mockRestore();
  });
});
