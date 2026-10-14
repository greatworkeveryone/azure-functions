/// <reference types="jest" />
// The money-action gate (S11, decision 16): each of the four conditions, the
// warn-only mode when MONEY_ALLOWED_CIDRS is unset, and the system.health
// warning that mode raises. Tokens are unsigned JWTs read through the dev
// override, as in the other auth tests; nothing touches a database.
import { HttpRequest } from "@azure/functions";
import {
  _setMoneyGateHealthForTests,
  evaluateMoneyGate,
  moneyGateConfig,
  requireMoneyContext,
} from "../moneyGate";

jest.mock("../access/accessEvents", () => ({ noteAccess: jest.fn(), noteMoneyAction: jest.fn(), noteSignIn: jest.fn() }));
jest.mock("../db", () => ({ closeConnection: jest.fn(), createServiceRequestConnection: jest.fn().mockResolvedValue({ conn: true }) }));
jest.mock("../escalation", () => ({ raise: jest.fn().mockResolvedValue({ created: true }) }));
jest.mock("../escalation/adapters", () => ({}));

const access = jest.requireMock("../access/accessEvents") as { noteMoneyAction: jest.Mock };
const escalation = jest.requireMock("../escalation") as { raise: jest.Mock };

const NOW = 1_760_500_000;
const OFFICE = "203.0.113.5";
const HOME = "198.51.100.20";

function makeJwt(payload: Record<string, unknown>): string {
  const encode = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode(payload)}.sig`;
}

const FRESH_MFA = { amr: ["pwd", "mfa"], iat: NOW - 60, oid: "oid-jo" };

function makeRequest(claims: Record<string, unknown> | null, forwardedFor: string | null = OFFICE): HttpRequest {
  const headers: Record<string, string> = {};
  if (claims) headers.authorization = `Bearer ${makeJwt(claims)}`;
  if (forwardedFor) headers["x-forwarded-for"] = forwardedFor;
  return {
    headers: { get: (key: string) => headers[key.toLowerCase()] ?? null },
    url: "https://api.example/api/markPaymentPaid",
  } as unknown as HttpRequest;
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(() => setImmediate(resolve)));

beforeAll(() => {
  process.env.DEV_ROLE_OVERRIDE_ENABLED = "true";
  // The dev-roles header only works on a local Development host (jwt.ts).
  process.env.AZURE_FUNCTIONS_ENVIRONMENT = "Development";
  delete process.env.WEBSITE_INSTANCE_ID;
});
afterAll(() => {
  delete process.env.DEV_ROLE_OVERRIDE_ENABLED;
  delete process.env.AZURE_FUNCTIONS_ENVIRONMENT;
});
beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(Date, "now").mockReturnValue(NOW * 1000);
  jest.spyOn(console, "warn").mockImplementation(() => {});
  process.env.MONEY_ALLOWED_CIDRS = "203.0.113.0/28, 2001:db8::/48";
  delete process.env.MONEY_STEP_UP_MINUTES;
  _setMoneyGateHealthForTests(null);
});
afterEach(() => {
  jest.restoreAllMocks();
  delete process.env.MONEY_ALLOWED_CIDRS;
});

describe("moneyGateConfig", () => {
  it("reads CIDRs and bare addresses, v4 and v6, and skips junk", () => {
    const config = moneyGateConfig({ MONEY_ALLOWED_CIDRS: "203.0.113.0/28 198.51.100.7, 2001:db8::/48, office, 10.0.0.0/33" });
    expect(config).toMatchObject({ entries: 3, invalid: ["office", "10.0.0.0/33"], mode: "enforce", stepUpMinutes: 10 });
  });

  it("is warn-only when unset, and enforcing (refusing all) when set but unreadable", () => {
    expect(moneyGateConfig({}).mode).toBe("warn");
    expect(moneyGateConfig({ MONEY_ALLOWED_CIDRS: "  " }).mode).toBe("warn");
    expect(moneyGateConfig({ MONEY_ALLOWED_CIDRS: "office" })).toMatchObject({ entries: 0, mode: "enforce" });
  });

  it("refuses networks too wide to be a real check, such as 0.0.0.0/0", () => {
    for (const wide of ["0.0.0.0/0", "10.0.0.0/7", "::/0", "2001:db8::/31"]) {
      expect(moneyGateConfig({ MONEY_ALLOWED_CIDRS: wide })).toMatchObject({ entries: 0, invalid: [wide], mode: "enforce" });
    }
    expect(moneyGateConfig({ MONEY_ALLOWED_CIDRS: "10.0.0.0/8, 2001:db8::/32" })).toMatchObject({ entries: 2, invalid: [] });
  });

  it("takes MONEY_STEP_UP_MINUTES from 1 to 60, else 10", () => {
    expect(moneyGateConfig({ MONEY_STEP_UP_MINUTES: "5" }).stepUpMinutes).toBe(5);
    expect(moneyGateConfig({ MONEY_STEP_UP_MINUTES: "0" }).stepUpMinutes).toBe(10);
    expect(moneyGateConfig({ MONEY_STEP_UP_MINUTES: "ten" }).stepUpMinutes).toBe(10);
  });
});

describe("evaluateMoneyGate — the four conditions", () => {
  const config = moneyGateConfig({ MONEY_ALLOWED_CIDRS: "203.0.113.0/28" });
  const run = (claims: Record<string, unknown> | null, address: string | null = OFFICE) =>
    evaluateMoneyGate({ address, claims, config, nowSeconds: NOW });

  it("allows an office request with a fresh MFA sign-in", () => {
    expect(run(FRESH_MFA)).toEqual({ failures: [], outcome: "allowed" });
  });

  it("1. refuses another network, or no address at all", () => {
    expect(run(FRESH_MFA, HOME).outcome).toBe("network_refused");
    expect(run(FRESH_MFA, null).outcome).toBe("network_refused");
  });

  it("2. needs a sign-in within 10 minutes, preferring auth_time over iat", () => {
    expect(run({ ...FRESH_MFA, iat: NOW - 11 * 60 }).outcome).toBe("step_up_stale");
    expect(run({ ...FRESH_MFA, auth_time: NOW - 11 * 60, iat: NOW - 60 }).outcome).toBe("step_up_stale");
    expect(run({ ...FRESH_MFA, auth_time: NOW - 9 * 60, iat: NOW - 60 * 60 }).outcome).toBe("allowed");
    expect(run({ amr: ["mfa"], oid: "x" }).outcome).toBe("step_up_stale");
    expect(run({ ...FRESH_MFA, iat: NOW + 3600 }).outcome).toBe("step_up_stale");
  });

  it("3. needs mfa in amr", () => {
    expect(run({ ...FRESH_MFA, amr: ["pwd"] }).outcome).toBe("step_up_mfa");
    expect(run({ ...FRESH_MFA, amr: undefined }).outcome).toBe("step_up_mfa");
  });

  it("lists every failure, network first", () => {
    expect(run({ amr: ["pwd"], iat: NOW - 3600 }, HOME).failures).toEqual(["network_refused", "step_up_stale", "step_up_mfa"]);
  });

  it("is unauthenticated without claims", () => {
    expect(run(null).outcome).toBe("unauthenticated");
  });
});

describe("requireMoneyContext — enforcing", () => {
  it("lets a good request through and logs it as a money action (4)", async () => {
    expect(await requireMoneyContext(makeRequest(FRESH_MFA))).toBeNull();
    expect(access.noteMoneyAction).toHaveBeenCalledWith(expect.anything(), "oid-jo", {
      failures: [],
      label: "Mark a payment paid",
      mode: "enforce",
      outcome: "allowed",
      route: "markPaymentPaid",
    });
  });

  it("answers 403 money_network_required off the allowed networks", async () => {
    const res = await requireMoneyContext(makeRequest(FRESH_MFA, HOME));
    expect(res).toEqual({
      jsonBody: { code: "money_network_required", error: expect.stringMatching(/office network or the approved remote connection/) },
      status: 403,
    });
    expect(access.noteMoneyAction.mock.calls[0][2]).toMatchObject({ outcome: "network_refused" });
  });

  it("is not fooled by a forwarded-for address the caller prepended", async () => {
    const res = await requireMoneyContext(makeRequest(FRESH_MFA, `${OFFICE}, ${HOME}`));
    expect(res?.status).toBe(403);
  });

  it("answers 428 step_up_required for a stale sign-in", async () => {
    const res = await requireMoneyContext(makeRequest({ ...FRESH_MFA, iat: NOW - 20 * 60 }));
    expect(res).toEqual({
      jsonBody: { code: "step_up_required", error: expect.any(String), maxAgeMinutes: 10, reason: "stale_sign_in" },
      status: 428,
    });
  });

  it("answers 428 step_up_required when MFA did not run", async () => {
    const res = await requireMoneyContext(makeRequest({ ...FRESH_MFA, amr: ["pwd"] }));
    expect(res?.status).toBe(428);
    expect(res?.jsonBody).toMatchObject({ reason: "mfa_missing" });
  });

  it("answers 401 without a token", async () => {
    expect((await requireMoneyContext(makeRequest(null)))?.status).toBe(401);
    expect(access.noteMoneyAction).not.toHaveBeenCalled();
  });

  it("refuses everything when the list is set but unreadable", async () => {
    process.env.MONEY_ALLOWED_CIDRS = "the office";
    expect((await requireMoneyContext(makeRequest(FRESH_MFA)))?.status).toBe(403);
  });

  it("refuses everything for 0.0.0.0/0 and raises system.health instead of waving it through", async () => {
    _setMoneyGateHealthForTests(true);
    process.env.MONEY_ALLOWED_CIDRS = "0.0.0.0/0";
    expect((await requireMoneyContext(makeRequest(FRESH_MFA)))?.status).toBe(403);
    await flush();
    await flush();
    expect(escalation.raise).toHaveBeenCalledTimes(1);
    expect(escalation.raise.mock.calls[0][1]).toMatchObject({
      subjectId: "money_gate",
      summary: expect.stringMatching(/ignored 1 MONEY_ALLOWED_CIDRS entry .*no usable network is left/),
    });
  });

  it("keeps the usable entries and still warns about the rest", async () => {
    _setMoneyGateHealthForTests(true);
    process.env.MONEY_ALLOWED_CIDRS = "203.0.113.0/28, 0.0.0.0/0";
    expect(await requireMoneyContext(makeRequest(FRESH_MFA))).toBeNull();
    expect((await requireMoneyContext(makeRequest(FRESH_MFA, HOME)))?.status).toBe(403);
    await flush();
    await flush();
    expect(escalation.raise).toHaveBeenCalledTimes(1);
  });

  it("uses the given oid when the handler has one", async () => {
    await requireMoneyContext(makeRequest(FRESH_MFA), { oid: "oid-from-handler" });
    expect(access.noteMoneyAction.mock.calls[0][1]).toBe("oid-from-handler");
  });
});

describe("requireMoneyContext — warn-only (MONEY_ALLOWED_CIDRS unset)", () => {
  beforeEach(() => {
    delete process.env.MONEY_ALLOWED_CIDRS;
  });

  it("refuses nothing but logs what would have failed", async () => {
    expect(await requireMoneyContext(makeRequest({ amr: ["pwd"], iat: NOW - 3600, oid: "oid-jo" }, HOME))).toBeNull();
    expect(access.noteMoneyAction.mock.calls[0][2]).toMatchObject({
      failures: ["network_refused", "step_up_stale", "step_up_mfa"],
      mode: "warn",
      outcome: "allowed_warn_only",
    });
    expect(console.warn).toHaveBeenCalledWith("[money-gate] warn-only: markPaymentPaid would be refused (network_refused, step_up_stale, step_up_mfa)");
  });

  it("does not refuse a request it cannot read either", async () => {
    expect(await requireMoneyContext(makeRequest(null))).toBeNull();
  });

  it("raises system.health once per instance", async () => {
    _setMoneyGateHealthForTests(true);
    await requireMoneyContext(makeRequest(FRESH_MFA));
    await requireMoneyContext(makeRequest(FRESH_MFA));
    await flush();
    await flush();
    expect(escalation.raise).toHaveBeenCalledTimes(1);
    expect(escalation.raise.mock.calls[0][1]).toMatchObject({
      policyKey: "system.health",
      skipConditionCheck: true,
      subjectId: "money_gate",
      subjectType: "system",
    });
  });

  it("does not raise system.health under Jest by default", async () => {
    await requireMoneyContext(makeRequest(FRESH_MFA));
    await flush();
    expect(escalation.raise).not.toHaveBeenCalled();
  });
});

describe("system.health condition for the gate", () => {
  it("is active while the list is unset or has unusable entries, and clears when every entry is usable", async () => {
    const { systemAdapter } = jest.requireActual("../escalation/adapters/system") as typeof import("../escalation/adapters/system");
    const ref = { policyKey: "system.health", subjectId: "money_gate", subjectType: "system" };
    const active = () => systemAdapter.isConditionActive({} as never, ref, new Date());
    delete process.env.MONEY_ALLOWED_CIDRS;
    await expect(active()).resolves.toBe(true);
    process.env.MONEY_ALLOWED_CIDRS = "203.0.113.0/28, 0.0.0.0/0";
    await expect(active()).resolves.toBe(true);
    process.env.MONEY_ALLOWED_CIDRS = ", ,";
    await expect(active()).resolves.toBe(true);
    process.env.MONEY_ALLOWED_CIDRS = "203.0.113.0/28";
    await expect(active()).resolves.toBe(false);
  });
});

describe("the /api/health probe", () => {
  it("logs the header shape and the gate's verdict, never the address", async () => {
    jest.resetModules();
    jest.doMock("@azure/functions", () => ({ ...jest.requireActual("@azure/functions"), app: { http: jest.fn() } }));
    const { app } = jest.requireMock("@azure/functions") as { app: { http: jest.Mock } };
    require("../functions/health");
    const handler = app.http.mock.calls.find((c) => c[0] === "health")?.[1].handler;
    const log = jest.fn();
    const headers: Record<string, string> = {
      authorization: `Bearer ${makeJwt({ name: "Ada", oid: "oid-ada", preferred_username: "a@x" })}`,
      "x-dev-roles": "admin",
      "x-forwarded-for": OFFICE,
    };
    await handler(
      { headers: { get: (k: string) => headers[k.toLowerCase()] ?? null }, query: new URLSearchParams({ deep: "true" }) },
      { error: jest.fn(), log },
    );
    const line = log.mock.calls.map((c) => String(c[0])).find((m) => m.startsWith("health: client address headers"));
    expect(line).toBe('health: client address headers {"clientIpHeader":false,"entries":1,"forwardedFor":true,"unreadable":0,"moneyNetwork":"allowed"}');
    expect(line).not.toContain(OFFICE);
  });
});
