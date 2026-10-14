/// <reference types="jest" />
// The escalation endpoints: the role gates, request validation, who may do what
// with a row, and how engine errors become responses. The engine and the store
// are replaced (they have their own tests); auth runs for real through the
// dev-override header and an unsigned JWT, as the other endpoint tests do.
import type { HttpRequest, InvocationContext } from "@azure/functions";
import { clearRoleCache } from "../auth";
import { acknowledgeEscalation } from "../functions/acknowledgeEscalation";
import { escalateFurther } from "../functions/escalateFurther";
import { getEscalation } from "../functions/getEscalation";
import { getEscalations } from "../functions/getEscalations";
import { previewEscalationTarget } from "../functions/previewEscalationTarget";
import { raiseEscalation } from "../functions/raiseEscalation";
import { resolveEscalation } from "../functions/resolveEscalation";
import { withdrawEscalation } from "../functions/withdrawEscalation";
import { registerAdapter, type EscalationAdapter } from "../escalation/adapters/registry";
import * as engine from "../escalation/engine";
import { EscalationError } from "../escalation/errors";
import { describeTarget } from "../escalation/ladder";
import * as store from "../escalation/store";
import type { DirectoryUser, EscalationRow } from "../escalation/types";
import { LedgerValidationError } from "../ledger";

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn(), timer: jest.fn() } };
});
jest.mock("../db", () => ({
  closeConnection: jest.fn(),
  createRequestConnection: jest.fn(),
  createServiceConnection: jest.fn(),
  executeQuery: jest.fn(),
}));
jest.mock("../escalation/engine");
jest.mock("../escalation/manual", () => ({ manualPolicyKey: jest.fn(async () => "job.manual") }));
jest.mock("../escalation/store");
jest.mock("../rateLimit", () => ({ checkRateLimit: jest.fn(() => ({ allowed: true })) }));

const db = require("../db") as {
  closeConnection: jest.Mock;
  createRequestConnection: jest.Mock;
  createServiceConnection: jest.Mock;
  executeQuery: jest.Mock;
};
const { checkRateLimit } = require("../rateLimit") as { checkRateLimit: jest.Mock };
const eng = jest.mocked(engine);
const st = jest.mocked(store);

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeJwt(payload: Record<string, unknown>): string {
  const encode = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${encode({ alg: "none" })}.${encode(payload)}.sig`;
}

// One person per role, so "who is asking" differs from "who raised it" (Fay, the facilities user).
const USER_ID = 8;
const PEOPLE: Record<string, { id: number; name: string }> = {
  accounts: { id: 9, name: "Gus" },
  accounts_manager: { id: 3, name: "Cam" },
  admin: { id: 7, name: "Ada" },
  cfo: { id: 4, name: "Joh" },
  director: { id: 5, name: "Dee" },
  facilities: { id: USER_ID, name: "Fay Staff" },
  facilities_manager: { id: 1, name: "Adam" },
  user: { id: 20, name: "Una" },
};
const headersFor = (roles: string | null): Record<string, string> => {
  const person = PEOPLE[roles ?? "facilities"];
  return {
    authorization: `Bearer ${makeJwt({ name: person.name, oid: `oid-${roles ?? "none"}`, preferred_username: `${person.name.toLowerCase()}@example.com` })}`,
    ...(roles ? { "x-dev-roles": roles } : {}),
  };
};

interface RequestOptions {
  body?: unknown;
  headers?: Record<string, string>;
  jsonThrows?: boolean;
  query?: Record<string, string>;
}

function makeRequest({ body, headers = headersFor("facilities"), jsonThrows, query = {} }: RequestOptions = {}): HttpRequest {
  return {
    headers: { get: (key: string) => headers[key.toLowerCase()] ?? null },
    json: async () => {
      if (jsonThrows) throw new Error("Unexpected token");
      return body;
    },
    query: new URLSearchParams(query),
  } as unknown as HttpRequest;
}

const context = (): InvocationContext => ({ error: jest.fn(), log: jest.fn(), warn: jest.fn() }) as unknown as InvocationContext;

const NOW_ISO = "2026-10-13T00:00:00.000Z";
const VERSION = "AAAAAAAAB9A=";

function row(overrides: Partial<EscalationRow> = {}): EscalationRow {
  return {
    acknowledgedAt: null,
    acknowledgedByName: null,
    acknowledgedByUserId: null,
    buildingId: 5,
    context: { title: "Leaking roof" },
    createdAt: new Date(NOW_ISO),
    dueAt: new Date("2026-10-14T06:00:00Z"),
    escalationId: 42,
    kind: "attention",
    lastFollowUpAt: null,
    lastNotificationAttemptAt: null,
    lastNotificationError: "Graph sendMail failed",
    lastNotifiedAt: null,
    level: 1,
    noIndependentTarget: false,
    note: "Tenant is chasing",
    notificationAttempts: 1,
    notificationState: "failed",
    parentEscalationId: null,
    policyKey: "job.manual",
    raisedByKind: "user",
    raisedByName: "Fay Staff",
    raisedByUserId: USER_ID,
    reason: "stalled",
    resolutionCode: null,
    resolutionNote: null,
    resolvedAt: null,
    resolvedByName: null,
    resolvedByUserId: null,
    rowVersion: VERSION,
    status: "open",
    subjectId: "12",
    subjectType: "job",
    summary: "Job #12 · Leaking roof",
    targetRole: "facilities_manager",
    targetUserId: null,
    updatedAt: new Date(NOW_ISO),
    urgent: false,
    ...overrides,
  };
}

const DIRECTORY: DirectoryUser[] = [
  { email: "fay@example.com", name: "Fay Staff", role: "facilities", userId: USER_ID },
  { email: "adam@example.com", name: "Adam", role: "facilities_manager", userId: 1 },
];

const jobAdapter = {
  deepLink: (id: string) => `/jobs?jobId=${id}`,
  isConditionActive: jest.fn(async () => true),
  loadSummary: jest.fn(async () => ({ buildingId: 5, context: {}, summary: "Job #12" })),
  subjectType: "job",
  visibleTo: jest.fn(() => true),
};

const ALL_HANDLERS = {
  acknowledgeEscalation: [acknowledgeEscalation, { method: "POST", body: { escalationId: 42, rowVersion: VERSION } }],
  escalateFurther: [escalateFurther, { method: "POST", body: { escalationId: 42, rowVersion: VERSION } }],
  getEscalation: [getEscalation, { method: "GET", query: { escalationId: "42" } }],
  getEscalations: [getEscalations, { method: "GET", query: {} }],
  previewEscalationTarget: [previewEscalationTarget, { method: "GET", query: { subjectId: "12", subjectType: "job" } }],
  raiseEscalation: [raiseEscalation, { method: "POST", body: { note: "n", reason: "stalled", subjectId: 12, subjectType: "job" } }],
  resolveEscalation: [resolveEscalation, { method: "POST", body: { escalationId: 42, rowVersion: VERSION } }],
  withdrawEscalation: [withdrawEscalation, { method: "POST", body: { escalationId: 42, reason: "no longer needed", rowVersion: VERSION } }],
} as const;

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "warn").mockImplementation(() => undefined); // the dev-role override warns on every request
  clearRoleCache();
  process.env.DEV_ROLE_OVERRIDE_ENABLED = "true";
  process.env.AZURE_FUNCTIONS_ENVIRONMENT = "Development";
  db.createRequestConnection.mockResolvedValue({});
  db.createServiceConnection.mockResolvedValue({});
  // resolveLedgerActor's AppUsers lookup: the person for the caller's oid.
  db.executeQuery.mockImplementation(async (_conn: unknown, _sql: string, params?: { name: string; value: unknown }[]) => {
    const oid = String(params?.find((p) => p.name === "Oid")?.value ?? "");
    const person = PEOPLE[oid.replace("oid-", "")];
    return person ? [{ UserID: person.id }] : [];
  });
  checkRateLimit.mockReturnValue({ allowed: true });
  jobAdapter.visibleTo.mockReturnValue(true);
  registerAdapter(jobAdapter as unknown as EscalationAdapter);
  st.getEscalationRow.mockResolvedValue(row());
  st.listActiveUsers.mockResolvedValue(DIRECTORY);
  st.listChain.mockResolvedValue([row()]);
  st.listEscalations.mockResolvedValue({ rows: [row()], total: 1 });
});

// ── Gates (every handler) ────────────────────────────────────────────────────

describe.each(Object.entries(ALL_HANDLERS))("%s gate", (_name, [handler, shape]) => {
  const call = (headers: Record<string, string>) =>
    handler(makeRequest({ body: "body" in shape ? shape.body : undefined, headers, query: "query" in shape ? shape.query : {} }), context());

  it("answers 401 without a token and touches nothing", async () => {
    const res = await call({});
    expect(res.status).toBe(401);
    expect(db.createRequestConnection).not.toHaveBeenCalled();
  });

  it.each(["user"])("answers 403 for the baseline %s role, before opening a connection", async (role) => {
    const res = await call(headersFor(role));
    expect(res.status).toBe(403);
    expect(db.createRequestConnection).not.toHaveBeenCalled();
  });

  it("answers 403 for an account with no role", async () => {
    db.executeQuery.mockResolvedValue([]); // no AppUsers row: roles are []
    const res = await call(headersFor(null));
    expect(res.status).toBe(403);
    expect(db.createRequestConnection).not.toHaveBeenCalled();
  });

  // The connection is only opened once the role gate has passed. What each role may
  // then do with a particular escalation is checked per row, in the tests below.
  it.each(["facilities", "facilities_manager", "accounts", "accounts_manager", "cfo", "director", "admin"])("lets %s through the role gate", async (role) => {
    const res = await call(headersFor(role));
    expect(res.status).not.toBe(401);
    expect(db.createRequestConnection).toHaveBeenCalled();
  });

  it("closes its connection", async () => {
    await call(headersFor("director"));
    expect(db.closeConnection).toHaveBeenCalled();
  });
});

// ── getEscalations ───────────────────────────────────────────────────────────

describe("getEscalations", () => {
  const list = (query: Record<string, string> = {}, roles = "facilities_manager") => getEscalations(makeRequest({ headers: headersFor(roles), query }), context());

  it("defaults to my active escalations and returns them with the total", async () => {
    const res = await list();

    expect(res.status).toBe(200);
    expect(st.listEscalations).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: "active", view: "mine", viewer: expect.objectContaining({ roles: ["facilities_manager"], userId: PEOPLE.facilities_manager.id }) }),
      expect.objectContaining({ active: false }),
    );
    const body = res.jsonBody as { items: Record<string, unknown>[]; total: number };
    expect(body.total).toBe(1);
    expect(body.items[0]).toMatchObject({ deepLink: "/jobs?jobId=12", escalationId: 42, rowVersion: VERSION, targetRoleLabel: "Facilities manager" });
  });

  it("serves the top-bar badge: view=mine with a page size of one still reports the whole count", async () => {
    st.listEscalations.mockResolvedValue({ rows: [row()], total: 7 });
    const res = await list({ pageSize: "1", view: "mine" });
    expect(res.jsonBody).toMatchObject({ page: 1, pageSize: 1, total: 7 });
  });

  it("shows everything visible for one subject by default (the banner on a job)", async () => {
    await list({ subjectId: "12", subjectType: "job" }, "facilities");
    expect(st.listEscalations).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ subjectId: "12", subjectType: "job", view: "visible" }), expect.anything());
  });

  it("accepts status=open for a count of the ones nobody has picked up", async () => {
    await list({ status: "open" });
    expect(st.listEscalations).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ status: "open" }), expect.anything());
  });

  it("passes the filters through", async () => {
    await list({ kind: "authority", policyKey: "quote.over_limit", status: "closed", urgent: "true", view: "raised" });
    expect(st.listEscalations).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ kind: "authority", policyKey: "quote.over_limit", status: "closed", urgent: true, view: "raised" }),
      expect.anything(),
    );
  });

  it.each([
    [{ view: "everything" }],
    [{ status: "old" }],
    [{ status: "ACTIVE" }],
    [{ kind: "other" }],
    [{ urgent: "maybe" }],
    [{ subjectId: "12" }],
    [{ policyKey: "x".repeat(65) }],
    [{ subjectId: "x".repeat(65), subjectType: "job" }],
  ])("refuses a bad filter %j with a 400", async (query) => {
    const res = await list(query);
    expect(res.status).toBe(400);
    expect(st.listEscalations).not.toHaveBeenCalled();
  });

  it("gates the team view to managers, the CFO, directors and admin", async () => {
    for (const role of ["facilities", "accounts"]) {
      expect((await list({ view: "team" }, role)).status).toBe(403);
    }
    for (const role of ["facilities_manager", "accounts_manager", "cfo", "director", "admin"]) {
      expect((await list({ view: "team" }, role)).status).toBe(200);
    }
  });

  it("gates the all view to directors and admin", async () => {
    for (const role of ["facilities", "facilities_manager", "accounts_manager", "cfo"]) {
      expect((await list({ view: "all" }, role)).status).toBe(403);
    }
    for (const role of ["director", "admin"]) {
      expect((await list({ view: "all" }, role)).status).toBe(200);
    }
  });

  it("drops rows the subject's own rule hides from this viewer", async () => {
    st.listEscalations.mockResolvedValue({ rows: [row({ escalationId: 1, subjectId: "12" }), row({ escalationId: 2, subjectId: "13" })], total: 2 });
    jobAdapter.visibleTo.mockImplementation(((_viewer: unknown, ref: { subjectId: string }) => ref.subjectId !== "12") as never);

    const res = await list();

    expect((res.jsonBody as { items: { escalationId: number }[] }).items.map((i) => i.escalationId)).toEqual([2]);
  });

  it("shows the email error only to directors and admin", async () => {
    const asManager = (await list()).jsonBody as { items: { lastNotificationError: string | null }[] };
    expect(asManager.items[0].lastNotificationError).toBeNull();
    const asDirector = (await list({}, "director")).jsonBody as { items: { lastNotificationError: string | null }[] };
    expect(asDirector.items[0].lastNotificationError).toBe("Graph sendMail failed");
  });

  it("answers 500 and logs it when the query fails", async () => {
    st.listEscalations.mockRejectedValue(new Error("SELECT blew up"));
    const ctx = context();
    const res = await getEscalations(makeRequest({ headers: headersFor("facilities_manager") }), ctx);
    expect(res.status).toBe(500);
    expect(res.jsonBody).toMatchObject({ error: "getEscalations failed" });
    expect(ctx.error).toHaveBeenCalledWith("getEscalations failed:", "SELECT blew up");
  });
});

// ── getEscalation ────────────────────────────────────────────────────────────

describe("getEscalation", () => {
  const get = (query: Record<string, string>, roles = "facilities_manager") => getEscalation(makeRequest({ headers: headersFor(roles), query }), context());

  it("returns the escalation and its chain", async () => {
    st.listChain.mockResolvedValue([row({ escalationId: 41, status: "superseded" }), row()]);
    const res = await get({ escalationId: "42" });

    expect(res.status).toBe(200);
    const body = res.jsonBody as { chain: { escalationId: number }[]; escalation: { escalationId: number; targetUserName: string | null } };
    expect(body.escalation.escalationId).toBe(42);
    expect(body.chain.map((c) => c.escalationId)).toEqual([41, 42]);
  });

  it("answers 400 for a missing or bad id and 404 for one that doesn't exist", async () => {
    expect((await get({})).status).toBe(400);
    expect((await get({ escalationId: "abc" })).status).toBe(400);
    st.getEscalationRow.mockResolvedValue(null);
    expect((await get({ escalationId: "42" })).status).toBe(404);
  });

  it("answers 404, not 403, when the caller may not see it (peers on the other side)", async () => {
    const res = await get({ escalationId: "42" }, "accounts_manager");
    expect(res.status).toBe(404);
    expect((res.jsonBody as { code: string }).code).toBe("not_found");
  });

  it("lets the raiser, the directors and the CFO see it", async () => {
    for (const roles of ["facilities", "director", "cfo", "admin"]) {
      expect((await get({ escalationId: "42" }, roles)).status).toBe(200);
    }
  });

  it("also asks the subject's own rule", async () => {
    jobAdapter.visibleTo.mockReturnValue(false);
    expect((await get({ escalationId: "42" }, "director")).status).toBe(404);
  });
});

// ── previewEscalationTarget ──────────────────────────────────────────────────

describe("previewEscalationTarget", () => {
  const preview = (query: Record<string, string>, roles = "facilities") => previewEscalationTarget(makeRequest({ headers: headersFor(roles), query }), context());

  const target = {
    fallbackEmails: [],
    hasNextLevel: true,
    level: 1,
    levelCount: 2,
    noIndependentTarget: false,
    role: "facilities_manager",
    skippedLevels: [],
    slaHours: 8,
    source: "raiser_manager" as const,
    targetUserId: null,
    users: [{ email: "adam@example.com", name: "Adam", role: "facilities_manager", userId: 1 }],
  };

  beforeEach(() => {
    eng.previewTarget.mockResolvedValue({
      policy: { active: true, autoReescalate: "yes", clock: "business", kind: "attention", ladder: [], policyKey: "job.manual", updatedAt: null, updatedBy: null, urgent: false },
      target,
    });
  });

  it("says where it would go, as the dialog shows it", async () => {
    const res = await preview({ subjectId: "12", subjectType: "job" });

    expect(res.status).toBe(200);
    expect(res.jsonBody).toEqual({
      goesTo: "Facilities manager (Adam)",
      label: "Goes to: Facilities manager (Adam)",
      level: 1,
      noIndependentTarget: false,
      policyKey: "job.manual",
      slaHours: 8,
      targetRole: "facilities_manager",
      targetRoleLabel: "Facilities manager",
      targetUserId: null,
      targets: [{ name: "Adam", userId: 1 }],
      urgent: false,
    });
    expect(describeTarget(target)).toBe("Facilities manager (Adam)");
    expect(eng.previewTarget).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ actor: expect.objectContaining({ name: "Fay Staff", role: "facilities", userId: USER_ID }), policyKey: "job.manual", preferredUserId: null }),
    );
  });

  it("passes a picked person on", async () => {
    await preview({ subjectId: "12", subjectType: "job", targetUserId: "1" });
    expect(eng.previewTarget).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ preferredUserId: 1 }));
  });

  it("refuses missing or bad parameters with 400", async () => {
    expect((await preview({})).status).toBe(400);
    expect((await preview({ subjectType: "job" })).status).toBe(400);
    expect((await preview({ subjectId: "12", subjectType: "job", targetUserId: "abc" })).status).toBe(400);
  });

  it("answers 404 for a subject that doesn't exist, can't be seen, or has no adapter", async () => {
    jobAdapter.loadSummary.mockResolvedValueOnce(null as never);
    expect((await preview({ subjectId: "404", subjectType: "job" })).status).toBe(404);
    jobAdapter.visibleTo.mockReturnValueOnce(false);
    expect((await preview({ subjectId: "12", subjectType: "job" })).status).toBe(404);
    expect((await preview({ subjectId: "12", subjectType: "mystery" })).status).toBe(422);
  });

  it("passes the engine's refusal of a person who isn't at the level", async () => {
    eng.previewTarget.mockRejectedValue(new EscalationError("target_not_eligible", "That person isn't at the level this escalation goes to"));
    const res = await preview({ subjectId: "12", subjectType: "job", targetUserId: "5" });
    expect(res.status).toBe(422);
    expect(res.jsonBody).toMatchObject({ code: "target_not_eligible" });
  });
});

// ── raiseEscalation ──────────────────────────────────────────────────────────

describe("raiseEscalation", () => {
  const body = { note: "The tenant is chasing and the plumber hasn't come", reason: "needs_decision", subjectId: 12, subjectType: "job", targetUserId: 1 };
  const raise = (b: unknown = body, over: Partial<RequestOptions> = {}) => raiseEscalation(makeRequest({ body: b, ...over }), context());

  beforeEach(() => {
    eng.raise.mockResolvedValue({ created: true, escalation: row() });
  });

  it("raises the subject's manual escalation as the caller and answers 201 with the row", async () => {
    const res = await raise();

    expect(res.status).toBe(201);
    expect(res.jsonBody).toMatchObject({ escalation: { escalationId: 42, status: "open" } });
    expect(eng.raise).toHaveBeenCalledTimes(1);
    expect(eng.raise).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        actor: { kind: "user", name: "Fay Staff", role: "facilities", userId: USER_ID },
        headline: "Escalated by Fay Staff: Needs a decision",
        note: "The tenant is chasing and the plumber hasn't come",
        policyKey: "job.manual",
        preferredUserId: 1,
        reason: "needs_decision",
        subjectId: "12",
        subjectType: "job",
      }),
    );
  });

  it("takes the policy from the server, never from the caller", async () => {
    await raise({ ...body, policyKey: "job.critical" });
    expect(eng.raise).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ policyKey: "job.manual" }));
  });

  it("answers 409 with the existing escalation when that subject is already escalated", async () => {
    eng.raise.mockResolvedValue({ created: false, escalation: row({ escalationId: 7 }) });
    const res = await raise();
    expect(res.status).toBe(409);
    expect(res.jsonBody).toMatchObject({ code: "already_open", escalation: { escalationId: 7 } });
  });

  it.each([
    ["no body", null],
    ["a non-object body", "text"],
    ["no subject", { ...body, subjectId: undefined }],
    ["no subject type", { ...body, subjectType: "" }],
    ["an unknown reason", { ...body, reason: "because" }],
    ["no reason", { ...body, reason: undefined }],
    ["no note", { ...body, note: undefined }],
    ["a blank note", { ...body, note: "   " }],
    ["a note over 2000 characters", { ...body, note: "n".repeat(2001) }],
    ["a bad target user", { ...body, targetUserId: "abc" }],
  ])("refuses %s with a 400 before writing", async (_label, b) => {
    const res = await raise(b);
    expect(res.status).toBe(400);
    expect(eng.raise).not.toHaveBeenCalled();
  });

  it("refuses a body that isn't JSON", async () => {
    const res = await raise(undefined, { jsonThrows: true });
    expect(res.status).toBe(400);
  });

  it("accepts all four of the dialog's reasons", async () => {
    for (const reason of ["stalled", "needs_decision", "over_my_authority", "other"]) {
      eng.raise.mockClear();
      expect((await raise({ ...body, reason })).status).toBe(201);
    }
  });

  it("answers 404 when the subject can't be seen by this caller", async () => {
    jobAdapter.visibleTo.mockReturnValue(false);
    expect((await raise()).status).toBe(404);
    expect(eng.raise).not.toHaveBeenCalled();
  });

  it("limits how fast one person can escalate", async () => {
    checkRateLimit.mockReturnValue({ allowed: false, retryAfterMs: 12_000 });
    const res = await raise();
    expect(res.status).toBe(429);
    expect(res.headers).toMatchObject({ "Retry-After": "12" });
    expect(eng.raise).not.toHaveBeenCalled();
  });

  it("passes the engine's refusals on with their status", async () => {
    eng.raise.mockRejectedValue(new EscalationError("condition_not_met", "There is nothing to escalate"));
    expect((await raise()).status).toBe(422);
    eng.raise.mockRejectedValue(new EscalationError("target_not_eligible", "That person isn't at the level"));
    expect((await raise()).status).toBe(422);
    eng.raise.mockRejectedValue(new LedgerValidationError("Reason is longer than 2000 characters"));
    expect((await raise()).status).toBe(400);
  });
});

// ── The four state changes ───────────────────────────────────────────────────

describe("acknowledgeEscalation", () => {
  const ack = (b: unknown, roles = "facilities_manager") => acknowledgeEscalation(makeRequest({ body: b, headers: headersFor(roles) }), context());
  const good = { escalationId: 42, rowVersion: VERSION };

  it("lets a target claim it, sending the version it read", async () => {
    eng.acknowledge.mockResolvedValue(row({ status: "acknowledged", targetUserId: USER_ID }));
    const res = await ack(good);

    expect(res.status).toBe(200);
    expect(res.jsonBody).toMatchObject({ escalation: { status: "acknowledged" } });
    expect(eng.acknowledge).toHaveBeenCalledWith(expect.anything(), { actor: expect.objectContaining({ role: "facilities_manager" }), escalationId: 42, expectedRowVersion: VERSION });
  });

  it("lets a director or admin acknowledge on the target's behalf", async () => {
    eng.acknowledge.mockResolvedValue(row({ status: "acknowledged" }));
    expect((await ack(good, "director")).status).toBe(200);
    expect((await ack(good, "admin")).status).toBe(200);
  });

  it("refuses the person who raised it", async () => {
    const res = await ack(good, "facilities");
    expect(res.status).toBe(403);
    expect(eng.acknowledge).not.toHaveBeenCalled();
  });

  it("refuses someone who can't even see it with a 404", async () => {
    expect((await ack(good, "accounts_manager")).status).toBe(404);
    expect(eng.acknowledge).not.toHaveBeenCalled();
  });

  it("needs the escalation id and the version it read", async () => {
    expect((await ack({ rowVersion: VERSION })).status).toBe(400);
    expect((await ack({ escalationId: 42 })).status).toBe(400);
    expect((await ack({ escalationId: 42, rowVersion: "" })).status).toBe(400);
    expect(eng.acknowledge).not.toHaveBeenCalled();
  });

  it("answers 409 when someone else changed it, with the current row so the screen can say what changed", async () => {
    eng.acknowledge.mockRejectedValue(
      new EscalationError("stale", "Someone else changed this escalation. Reload it to see their change.", { current: row({ status: "acknowledged", acknowledgedByName: "Bea" }) }),
    );
    const res = await ack(good);

    expect(res.status).toBe(409);
    expect(res.jsonBody).toMatchObject({ code: "stale", current: { acknowledgedByName: "Bea", status: "acknowledged" } });
  });
});

describe("resolveEscalation", () => {
  const resolveIt = (b: unknown, roles = "facilities_manager") => resolveEscalation(makeRequest({ body: b, headers: headersFor(roles) }), context());
  const good = { escalationId: 42, note: "Rang the contractor", resolutionCode: "action_taken", rowVersion: VERSION };

  it("ends an attention escalation with the code and note", async () => {
    eng.resolve.mockResolvedValue(row({ resolutionCode: "action_taken", status: "resolved" }));
    const res = await resolveIt(good);

    expect(res.status).toBe(200);
    expect(eng.resolve).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ escalationId: 42, expectedRowVersion: VERSION, note: "Rang the contractor", resolutionCode: "action_taken" }),
    );
  });

  it("refuses an authority escalation with a 422 that points at the subject", async () => {
    eng.resolve.mockRejectedValue(
      new EscalationError("authority_resolve", "This is waiting on a decision, so it can't be resolved from here. Open it and approve or reject it there.", {
        deepLink: "/quotes/7",
        subjectId: "7",
        subjectType: "quote",
      }),
    );

    const res = await resolveIt(good);

    expect(res.status).toBe(422);
    expect(res.jsonBody).toEqual({
      code: "authority_resolve",
      deepLink: "/quotes/7",
      error: "This is waiting on a decision, so it can't be resolved from here. Open it and approve or reject it there.",
      subjectId: "7",
      subjectType: "quote",
    });
  });

  it("refuses the raiser and people who can't see it", async () => {
    expect((await resolveIt(good, "facilities")).status).toBe(403);
    expect((await resolveIt(good, "accounts")).status).toBe(404);
    expect(eng.resolve).not.toHaveBeenCalled();
  });

  it("needs the version, and a note of the right size", async () => {
    expect((await resolveIt({ escalationId: 42 })).status).toBe(400);
    expect((await resolveIt({ ...good, note: "n".repeat(2001) })).status).toBe(400);
    expect((await resolveIt({ ...good, note: 5 })).status).toBe(400);
  });
});

describe("withdrawEscalation", () => {
  const withdrawIt = (b: unknown, roles = "facilities") => withdrawEscalation(makeRequest({ body: b, headers: headersFor(roles) }), context());
  const good = { escalationId: 42, reason: "Sorted it with the tenant", rowVersion: VERSION };

  it("lets the raiser take it back with a reason", async () => {
    eng.withdraw.mockResolvedValue(row({ resolutionCode: "withdrawn", status: "withdrawn" }));
    const res = await withdrawIt(good);

    expect(res.status).toBe(200);
    expect(eng.withdraw).toHaveBeenCalledWith(expect.anything(), { actor: expect.objectContaining({ userId: USER_ID }), escalationId: 42, expectedRowVersion: VERSION, reason: "Sorted it with the tenant" });
  });

  it("passes on the engine's refusal when there is no reason", async () => {
    eng.withdraw.mockRejectedValue(new EscalationError("reason_required", "Say why you are withdrawing it"));
    const res = await withdrawIt({ escalationId: 42, rowVersion: VERSION });
    expect(res.status).toBe(400);
    expect(res.jsonBody).toMatchObject({ code: "reason_required" });
    expect(eng.withdraw).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ reason: null }));
  });

  it("refuses everyone but the raiser (and admin)", async () => {
    expect((await withdrawIt(good, "facilities_manager")).status).toBe(403);
    expect((await withdrawIt(good, "director")).status).toBe(403);
    eng.withdraw.mockResolvedValue(row({ status: "withdrawn" }));
    expect((await withdrawIt(good, "admin")).status).toBe(200);
  });

  it("answers 409 when it was acknowledged in the meantime", async () => {
    eng.withdraw.mockRejectedValue(new EscalationError("not_live", "Adam has already acknowledged this, so it can't be withdrawn.", { current: row({ status: "acknowledged" }) }));
    const res = await withdrawIt(good);
    expect(res.status).toBe(409);
    expect(res.jsonBody).toMatchObject({ code: "not_live", current: { status: "acknowledged" } });
  });
});

describe("escalateFurther", () => {
  const push = (b: unknown, roles = "facilities_manager") => escalateFurther(makeRequest({ body: b, headers: headersFor(roles) }), context());
  const good = { escalationId: 42, note: "Needs the director", rowVersion: VERSION, targetUserId: 5 };

  it("pushes it up one level and returns the new row and the one it replaced", async () => {
    eng.escalateFurther.mockResolvedValue({ next: row({ escalationId: 43, level: 2, parentEscalationId: 42, targetRole: "director" }), previous: row({ status: "superseded" }) });
    const res = await push(good);

    expect(res.status).toBe(200);
    expect(res.jsonBody).toMatchObject({ escalation: { escalationId: 43, parentEscalationId: 42, targetRole: "director" }, previous: { escalationId: 42, status: "superseded" } });
    expect(eng.escalateFurther).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ escalationId: 42, expectedRowVersion: VERSION, mode: "next_level", note: "Needs the director", preferredUserId: 5 }),
    );
  });

  it("lets the raiser push it up too, and refuses people with no part in it", async () => {
    eng.escalateFurther.mockResolvedValue({ next: row({ escalationId: 43 }), previous: row() });
    expect((await push(good, "facilities")).status).toBe(200);
    expect((await push(good, "accounts")).status).toBe(404);
  });

  it("says there is nowhere further to go from the top", async () => {
    eng.escalateFurther.mockRejectedValue(new EscalationError("no_further_level", "This is already with the top of the ladder, so there is nowhere further to send it."));
    const res = await push(good, "director");
    expect(res.status).toBe(422);
    expect(res.jsonBody).toMatchObject({ code: "no_further_level" });
  });

  it("answers 409 when someone else changed it", async () => {
    eng.escalateFurther.mockRejectedValue(new EscalationError("stale", "Someone else changed this escalation. Reload it to see their change.", { current: row({ status: "superseded" }) }));
    const res = await push(good);
    expect(res.status).toBe(409);
    expect(res.jsonBody).toMatchObject({ current: { status: "superseded" } });
  });

  it("needs the version", async () => {
    expect((await push({ escalationId: 42 })).status).toBe(400);
  });
});
