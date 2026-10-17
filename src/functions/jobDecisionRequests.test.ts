/// <reference types="jest" />
// The three decision-request endpoints (jobs plan A1) end to end, short of the
// database: the real handlers, auth, service, escalation engine, notifier and
// ledger validation, against an in-memory stand-in for the tables they write.
// Only the mail transport and the ledger's INSERT are replaced, so what is proved
// is the whole path: who may ask, that the request, the escalation and the ledger
// rows commit or roll back together, and who is emailed (and who is not), when.
import type { HttpRequest, InvocationContext } from "@azure/functions";
import { clearRoleCache } from "../auth";
import { graphSendMail } from "../graph";
import { getPolicy } from "../escalation/policies";
import { assertLedgerEntry, record, type LedgerEntryInput } from "../ledger";
import { checkRateLimit } from "../rateLimit";
import { Sentry } from "../sentry";
import { getJobDecisionRequest } from "./getJobDecisionRequest";
import { requestJobDecision } from "./requestJobDecision";
import { withdrawJobDecisionRequest } from "./withdrawJobDecisionRequest";
import type { EscalationPolicy, EscalationRow } from "../escalation/types";

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn(), timer: jest.fn() } };
});
jest.mock("../db", () => ({
  beginTransaction: jest.fn(),
  closeConnection: jest.fn(),
  commitTransaction: jest.fn(),
  createRequestConnection: jest.fn(),
  createServiceConnection: jest.fn(),
  executeQuery: jest.fn(),
  rollbackTransaction: jest.fn(),
}));
jest.mock("../ledger", () => ({ ...jest.requireActual("../ledger"), record: jest.fn() }));
jest.mock("../graph", () => ({ graphSendMail: jest.fn() }));
jest.mock("../rateLimit", () => ({ checkRateLimit: jest.fn(() => ({ allowed: true })) }));
jest.mock("../sentry", () => ({ Sentry: { captureException: jest.fn(), captureMessage: jest.fn(), flush: jest.fn() } }));
jest.mock("../escalation/policies", () => ({ getPolicy: jest.fn() }));

// ── The in-memory tables ─────────────────────────────────────────────────────

type Row = Record<string, unknown>;

const mockWorld = {
  attachments: new Map<number, number>(),
  clock: 1,
  escalations: new Map<number, EscalationRow>(),
  events: [] as string[],
  jobs: new Map<number, Row>(),
  ledger: [] as LedgerEntryInput[],
  mail: [] as { body: string; subject: string; to: string[] }[],
  mailFails: false,
  nextEscalationId: 100,
  requests: [] as Row[],
  snapshot: null as null | { escalations: Map<number, EscalationRow>; ledger: LedgerEntryInput[]; requests: Row[] },
  users: [] as { email: string | null; name: string; role: string; userId: number }[],
};

jest.mock("../escalation/store", () => {
  const actual = jest.requireActual("../escalation/store");
  const live = (row: EscalationRow) => row.status === "open" || row.status === "acknowledged";
  const COLUMN_TO_FIELD: Record<string, string> = {
    AcknowledgedAt: "acknowledgedAt",
    AcknowledgedByName: "acknowledgedByName",
    AcknowledgedByUserId: "acknowledgedByUserId",
    DueAt: "dueAt",
    ResolutionCode: "resolutionCode",
    ResolutionNote: "resolutionNote",
    ResolvedAt: "resolvedAt",
    ResolvedByName: "resolvedByName",
    ResolvedByUserId: "resolvedByUserId",
    Status: "status",
    TargetUserId: "targetUserId",
  };
  const version = () => Buffer.from(String(mockWorld.clock++).padStart(8, "0")).toString("base64");
  return {
    ...actual,
    findLiveEscalation: jest.fn(async (_c: unknown, type: string, id: string, policy: string) => {
      const found = [...mockWorld.escalations.values()].find((r) => r.subjectType === type && r.subjectId === id && r.policyKey === policy && live(r));
      return found ? { ...found } : null;
    }),
    getEscalationRow: jest.fn(async (_c: unknown, id: number) => {
      const row = mockWorld.escalations.get(id);
      return row ? { ...row } : null;
    }),
    insertEscalation: jest.fn(async (_c: unknown, values: Record<string, unknown>) => {
      const id = mockWorld.nextEscalationId++;
      const now = new Date("2026-10-12T00:00:00Z");
      mockWorld.escalations.set(id, {
        acknowledgedAt: null,
        acknowledgedByName: null,
        acknowledgedByUserId: null,
        buildingId: null,
        context: null,
        createdAt: now,
        dueAt: null,
        escalationId: id,
        kind: "authority",
        lastFollowUpAt: null,
        lastNotificationAttemptAt: null,
        lastNotificationError: null,
        lastNotifiedAt: null,
        level: 1,
        noIndependentTarget: false,
        note: null,
        notificationAttempts: 0,
        notificationState: "pending",
        parentEscalationId: null,
        policyKey: "",
        raisedByKind: "user",
        raisedByName: "",
        raisedByUserId: null,
        reason: null,
        resolutionCode: null,
        resolutionNote: null,
        resolvedAt: null,
        resolvedByName: null,
        resolvedByUserId: null,
        rowVersion: version(),
        status: "open",
        subjectId: "",
        subjectType: "",
        summary: "",
        targetRole: null,
        targetUserId: null,
        updatedAt: now,
        urgent: false,
        ...(values as Partial<EscalationRow>),
      } as EscalationRow);
      return id;
    }),
    listActiveUsers: jest.fn(async () => mockWorld.users.map((u) => ({ ...u }))),
    recordNotification: jest.fn(async (_c: unknown, id: number, outcome: { notifiedAt: Date | null; state: string }, attempts: number) => {
      const row = mockWorld.escalations.get(id);
      if (!row) return;
      row.notificationState = outcome.state as EscalationRow["notificationState"];
      row.notificationAttempts += attempts;
      if (outcome.notifiedAt) row.lastNotifiedAt = outcome.notifiedAt;
    }),
    updateEscalation: jest.fn(async (_c: unknown, id: number, expected: string, changes: Record<string, unknown>) => {
      const row = mockWorld.escalations.get(id);
      if (!row || row.rowVersion !== expected) return false;
      const next: Record<string, unknown> = { ...row };
      for (const [column, value] of Object.entries(changes)) next[COLUMN_TO_FIELD[column]] = value;
      next.rowVersion = version();
      mockWorld.escalations.set(id, next as unknown as EscalationRow);
      return true;
    }),
  };
});

const db = require("../db") as {
  beginTransaction: jest.Mock;
  closeConnection: jest.Mock;
  commitTransaction: jest.Mock;
  createRequestConnection: jest.Mock;
  createServiceConnection: jest.Mock;
  executeQuery: jest.Mock;
  rollbackTransaction: jest.Mock;
};
const ledger = jest.mocked(record);
const send = jest.mocked(graphSendMail);
const policyOf = jest.mocked(getPolicy);
const rateLimit = jest.mocked(checkRateLimit);

// ── People ───────────────────────────────────────────────────────────────────

interface Person {
  id: number;
  name: string;
  role: string;
}
const PEOPLE: Record<string, Person> = {
  ada: { id: 7, name: "Ada", role: "admin" },
  alana: { id: 9, name: "Alana", role: "accounts" },
  cam: { id: 3, name: "Cam", role: "accounts_manager" },
  dee: { id: 5, name: "Dee", role: "director" },
  eli: { id: 6, name: "Eli", role: "director" },
  fay: { id: 8, name: "Fay", role: "facilities" },
  gus: { id: 10, name: "Gus", role: "accounts" },
  kirstin: { id: 4, name: "Kirstin", role: "accounts_manager" },
  una: { id: 20, name: "Una", role: "user" },
};
const KEYS = Object.keys(PEOPLE);

const jwt = (payload: Record<string, unknown>): string => {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${enc({ alg: "none" })}.${enc(payload)}.sig`;
};
const as = (key: string | null): Record<string, string> => {
  const person = PEOPLE[key ?? "alana"];
  return {
    authorization: `Bearer ${jwt({ name: person.name, oid: `oid-${key}`, preferred_username: `${person.name.toLowerCase()}@example.com` })}`,
    ...(key ? { "x-dev-roles": person.role } : {}),
  };
};

function req({ body, headers = as("alana"), jsonThrows, query = {} }: { body?: unknown; headers?: Record<string, string>; jsonThrows?: boolean; query?: Record<string, string> } = {}): HttpRequest {
  return {
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    json: async () => {
      if (jsonThrows) throw new Error("Unexpected token");
      return body;
    },
    query: new URLSearchParams(query),
  } as unknown as HttpRequest;
}
const context = (): InvocationContext => ({ error: jest.fn(), log: jest.fn(), warn: jest.fn() }) as unknown as InvocationContext;

// ── The fake database ────────────────────────────────────────────────────────

const rowVersion = (n: number): Buffer => Buffer.from([0, 0, 0, 0, 0, 0, 0, n]);

function installDatabase(): void {
  db.executeQuery.mockImplementation(async (_c: unknown, sql: string, params: { name: string; value: unknown }[] = []) => {
    const p = Object.fromEntries(params.map((x) => [x.name, x.value]));
    const text = sql.replace(/\s+/g, " ");

    if (/SELECT UserID FROM dbo\.AppUsers WHERE EntraOid = @Oid/.test(text)) {
      const person = PEOPLE[String(p.Oid).replace("oid-", "")];
      return person ? [{ UserID: person.id }] : [];
    }
    if (/FROM dbo\.AppUsers WHERE UserID IN/.test(text)) {
      return params.map((x) => PEOPLE_BY_ID.get(x.value as number)).filter(Boolean).map((u) => ({ DisplayName: u!.name, Email: `${u!.name.toLowerCase()}@example.com`, IsActive: true, Role: u!.role, UserID: u!.id }));
    }
    if (/FROM dbo\.Jobs j WITH \(UPDLOCK, HOLDLOCK\)/.test(text)) {
      const job = mockWorld.jobs.get(p.JobID as number);
      return job ? [job] : [];
    }
    if (/FROM dbo\.Jobs j LEFT JOIN dbo\.Buildings b ON b\.BuildingID = j\.BuildingID WHERE j\.JobID = @JobID/.test(text)) {
      const job = mockWorld.jobs.get(p.JobID as number);
      return job
        ? [{ ...job, AcknowledgedAt: null, AssignedTo: null, AssignedToUserID: null, CreatedAt: new Date("2026-10-01T00:00:00Z"), ExpectedProgressUpdate: null, FirstQuoteRequestAt: null, OldestPendingInvoiceAt: null, PendingInvoices: 0, Priority: "Normal", QuoteCount: 0, RequestedContractors: 0, StatusSince: null }]
        : [];
    }
    if (/SELECT BuildingID FROM dbo\.Jobs WHERE JobID = @JobID/.test(text)) {
      const job = mockWorld.jobs.get(p.JobID as number);
      return job ? [{ BuildingID: job.BuildingID }] : [];
    }
    if (/UPDATE dbo\.Jobs SET EscalatedAt/.test(text)) {
      mockWorld.events.push("job flag");
      return [];
    }
    // Nothing here has been answered (jobs plan A2 reads the decision beside the request).
    if (/FROM dbo\.JobDecisions WHERE RequestId = @RequestId/.test(text)) return [];
    if (/SELECT TOP 1 .* FROM dbo\.JobDecisions WHERE JobId = @JobId ORDER BY DecisionId DESC/.test(text)) return [];
    if (/FROM dbo\.Attachments WHERE Id = @AttachmentId AND JobID = @JobID/.test(text)) {
      return mockWorld.attachments.get(p.AttachmentId as number) === p.JobID ? [{ Id: p.AttachmentId }] : [];
    }
    if (/FROM dbo\.JobDecisionRequests WHERE JobId = @JobId AND State = N'pending'/.test(text)) {
      return mockWorld.requests.filter((r) => r.JobId === p.JobId && r.State === "pending");
    }
    if (/SELECT TOP 1 .* FROM dbo\.JobDecisionRequests WHERE JobId = @JobId ORDER BY RequestId DESC/.test(text)) {
      return mockWorld.requests.filter((r) => r.JobId === p.JobId).slice(-1);
    }
    if (/INSERT INTO dbo\.JobDecisionRequests/.test(text)) {
      mockWorld.events.push("insert request");
      const RequestId = 7 + mockWorld.requests.length;
      mockWorld.requests.push({
        AssignmentMode: p.AssignmentMode, AutoEscalate: p.AutoEscalate, DecisionMakers: p.DecisionMakers, JobId: p.JobId, Question: p.Question, RequestId, RequestedAt: new Date("2026-10-12T00:00:00Z"),
        RequestedBy: p.RequestedBy, RequestedByUserId: p.RequestedByUserId, RespondBy: p.RespondBy, RoutineWeeks: p.RoutineWeeks, RowVersion: rowVersion(1),
        SourceAttachmentId: p.SourceAttachmentId, State: "pending", Tier: p.Tier, WithdrawnAt: null, WithdrawnBy: null, WithdrawnByUserId: null, WithdrawnReason: null,
      });
      return [{ RequestId }];
    }
    if (/FROM dbo\.JobDecisionRequests (WITH \(UPDLOCK, ROWLOCK\) )?WHERE RequestId = @RequestId/.test(text)) {
      return mockWorld.requests.filter((r) => r.RequestId === p.RequestId);
    }
    if (/UPDATE dbo\.JobDecisionRequests SET State = N'withdrawn'/.test(text)) {
      mockWorld.events.push("mark withdrawn");
      const found = mockWorld.requests.find((r) => r.RequestId === p.RequestId && r.State === "pending");
      if (!found) return [];
      Object.assign(found, { RowVersion: rowVersion(2), State: "withdrawn", WithdrawnAt: p.At, WithdrawnBy: p.By, WithdrawnByUserId: p.ById, WithdrawnReason: p.Reason });
      return [{ RequestId: found.RequestId }];
    }
    throw new Error(`unexpected SQL: ${text}`);
  });
}
const PEOPLE_BY_ID = new Map(Object.values(PEOPLE).map((p) => [p.id, p]));

// ── Fixtures ─────────────────────────────────────────────────────────────────

// Monday 2026-10-12, 09:00 Darwin
const NOW = new Date(Date.UTC(2026, 9, 12, 9, 0) - 9.5 * 3_600_000);

const POLICY: EscalationPolicy = {
  active: true,
  autoReescalate: "yes",
  clock: "business",
  kind: "authority",
  ladder: [{ userTarget: true }, { slaHours: 16, token: "raiser_manager" }, { role: "director" }],
  policyKey: "job.decision_pending",
  updatedAt: null,
  updatedBy: null,
  urgent: false,
};

const job = (JobID: number, Kind: string, over: Row = {}): Row => ({
  BuildingID: 5, BuildingName: "25 Temira Crescent", IsArchived: false, JobID, Kind, Status: "New", Title: "Superseded lighting invoice", ...over,
});

const MAIL_ENV = {
  APP_BASE_URL: "https://floorplan.example",
  GRAPH_CLIENT_ID: "id",
  GRAPH_CLIENT_SECRET: "secret",
  GRAPH_SENDER_EMAIL: "floorplan@example.com",
  GRAPH_TENANT_ID: "tenant",
};

const ask = (over: Record<string, unknown> = {}, who: string | null = "alana") =>
  requestJobDecision(
    req({
      body: {
        assignmentMode: "named",
        decisionMakers: { userIds: [PEOPLE.cam.id, PEOPLE.dee.id] },
        jobId: 12,
        question: "Pay the superseded lighting invoice, or go back to the contractor?",
        tier: "soon",
        ...over,
      },
      headers: as(who),
    }),
    context(),
  );
const get = (jobId: number | string, who = "alana") => getJobDecisionRequest(req({ headers: as(who), query: { jobId: String(jobId) } }), context());
const withdraw = (body: Record<string, unknown>, who = "alana") => withdrawJobDecisionRequest(req({ body, headers: as(who) }), context());

const json = (response: { jsonBody?: unknown }) => response.jsonBody as Record<string, any>;
const nothingWritten = () => {
  expect(mockWorld.requests).toHaveLength(0);
  expect(mockWorld.escalations.size).toBe(0);
  expect(mockWorld.ledger).toHaveLength(0);
  expect(mockWorld.mail).toHaveLength(0);
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers({
    doNotFake: ["nextTick", "setImmediate", "clearImmediate", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "queueMicrotask", "hrtime", "performance"],
    now: NOW,
  });
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
  clearRoleCache();
  Object.assign(process.env, MAIL_ENV, { AZURE_FUNCTIONS_ENVIRONMENT: "Development", DEV_ROLE_OVERRIDE_ENABLED: "true" });
  delete process.env.DEV_EMAIL_OVERRIDE;
  delete process.env.ESCALATION_HOLIDAYS;

  mockWorld.attachments = new Map([[77, 12], [88, 14]]);
  mockWorld.clock = 1;
  mockWorld.escalations = new Map();
  mockWorld.events = [];
  mockWorld.jobs = new Map([[12, job(12, "admin")], [13, job(13, "facilities")], [14, job(14, "admin", { Title: "Another" })]]);
  mockWorld.ledger = [];
  mockWorld.mail = [];
  mockWorld.mailFails = false;
  mockWorld.nextEscalationId = 100;
  mockWorld.requests = [];
  mockWorld.snapshot = null;
  mockWorld.users = Object.values(PEOPLE).map((p) => ({ email: `${p.name.toLowerCase()}@example.com`, name: p.name, role: p.role, userId: p.id }));

  installDatabase();
  db.createRequestConnection.mockResolvedValue({});
  db.createServiceConnection.mockResolvedValue({});
  db.beginTransaction.mockImplementation(async () => {
    mockWorld.events.push("begin");
    mockWorld.snapshot = {
      escalations: new Map([...mockWorld.escalations].map(([id, r]) => [id, { ...r }])),
      ledger: [...mockWorld.ledger],
      requests: mockWorld.requests.map((r) => ({ ...r })),
    };
  });
  db.commitTransaction.mockImplementation(async () => {
    mockWorld.events.push("commit");
    mockWorld.snapshot = null;
  });
  db.rollbackTransaction.mockImplementation(async () => {
    mockWorld.events.push("rollback");
    if (mockWorld.snapshot) {
      mockWorld.escalations = mockWorld.snapshot.escalations;
      mockWorld.ledger = mockWorld.snapshot.ledger;
      mockWorld.requests = mockWorld.snapshot.requests;
    }
    mockWorld.snapshot = null;
  });
  ledger.mockImplementation(async (_c, entry) => {
    assertLedgerEntry(entry); // the real validation: a bad entry fails as it would in production
    mockWorld.events.push(`ledger:${entry.action}`);
    mockWorld.ledger.push(entry);
  });
  send.mockImplementation(async (to, subject, body) => {
    mockWorld.events.push("send");
    if (mockWorld.mailFails) throw new Error("Graph sendMail failed: 503");
    mockWorld.mail.push({ body, subject, to: Array.isArray(to) ? to : [to] });
  });
  policyOf.mockImplementation(async (_c, key) => (key === "job.decision_pending" ? POLICY : null));
  rateLimit.mockReturnValue({ allowed: true, remaining: 29, retryAfterMs: 0 } as never);
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

// ── Gates ────────────────────────────────────────────────────────────────────

// A valid body each, so the handler gets as far as opening its connection once the gate lets it through.
const VALID_ASK = { assignmentMode: "named", decisionMakers: { userIds: [6] }, jobId: 12, question: "Pay it?", tier: "soon" };
describe.each([
  ["requestJobDecision", (headers: Record<string, string>) => requestJobDecision(req({ body: VALID_ASK, headers }), context())],
  ["getJobDecisionRequest", (headers: Record<string, string>) => getJobDecisionRequest(req({ headers, query: { jobId: "12" } }), context())],
  ["withdrawJobDecisionRequest", (headers: Record<string, string>) => withdrawJobDecisionRequest(req({ body: { reason: "x", requestId: 7 }, headers }), context())],
])("%s gate", (_name, call) => {
  it("answers 401 without a token and opens no connection", async () => {
    expect((await call({})).status).toBe(401);
    expect(db.createRequestConnection).not.toHaveBeenCalled();
  });

  it("answers 403 for the baseline user role, before opening a connection", async () => {
    expect((await call(as("una"))).status).toBe(403);
    expect(db.createRequestConnection).not.toHaveBeenCalled();
  });

  it("answers 403 for an account with no role", async () => {
    db.executeQuery.mockResolvedValue([]); // no AppUsers row: roles are []
    expect((await call(as(null))).status).toBe(403);
    expect(db.createRequestConnection).not.toHaveBeenCalled();
  });

  it.each(["fay", "alana", "cam", "dee", "ada"])("lets %s through the role gate", async (key) => {
    const res = await call(as(key));
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
    expect(db.createRequestConnection).toHaveBeenCalled();
  });

  it("closes its connection", async () => {
    await call(as("dee"));
    expect(db.closeConnection).toHaveBeenCalled();
  });
});

// ── Ask ──────────────────────────────────────────────────────────────────────

describe("requestJobDecision", () => {
  it("answers 201 with the request, the chase behind it and no call-them flag", async () => {
    const res = await ask();

    expect(res.status).toBe(201);
    const body = json(res);
    expect(body.callThem).toBe(false);
    expect(body.request).toMatchObject({
      assignmentMode: "named",
      callThem: false,
      decisionMakers: { people: [{ active: true, name: "Cam", role: "accounts_manager", userId: 3 }, { active: true, name: "Dee", role: "director", userId: 5 }], role: null, roleLabel: null },
      fixedDate: null,
      jobId: 12,
      question: "Pay the superseded lighting invoice, or go back to the contractor?",
      requestedBy: "Alana",
      requestedByUserId: 9,
      requestId: 7,
      respondBy: "2026-10-19T07:30:00.000Z",
      routineWeeks: null,
      sourceAttachmentId: null,
      state: "pending",
      tier: "soon",
      withdrawn: null,
    });
    expect(typeof body.request.rowVersion).toBe("string");
    expect(body.chase).toMatchObject({
      deepLink: "/jobs?jobId=12&step=decision&decisionRequestId=7#decision",
      dueAt: "2026-10-19T07:30:00.000Z",
      escalationId: 100,
      isOverdue: false,
      level: 1,
      notificationState: "sent",
      remindAt: ["2026-10-15T23:00:00.000Z"],
      status: "open",
      targetNames: ["Cam", "Dee"],
      targetRole: null,
      urgent: false,
    });
  });

  it("writes the request, raises the escalation and ledgers both in one transaction, and emails only after the commit", async () => {
    await ask();

    // The job's flag is brought in step again once the email is on record (J6).
    expect(mockWorld.events).toEqual(["begin", "insert request", "job flag", "ledger:escalation.raise", "ledger:decision.requested", "commit", "send", "job flag"]);
    expect(db.commitTransaction).toHaveBeenCalledTimes(1);
    expect(db.rollbackTransaction).not.toHaveBeenCalled();
  });

  it("raises the escalation under the decision policy on the job, for the people asked, with the schedule in its context", async () => {
    await ask();

    expect(mockWorld.escalations.size).toBe(1);
    const row = [...mockWorld.escalations.values()][0];
    expect(row).toMatchObject({
      buildingId: 5,
      dueAt: new Date("2026-10-19T07:30:00Z"),
      kind: "authority",
      level: 1,
      noIndependentTarget: false,
      note: "Pay the superseded lighting invoice, or go back to the contractor?",
      policyKey: "job.decision_pending",
      raisedByName: "Alana",
      raisedByUserId: 9,
      reason: "needs_decision",
      status: "open",
      subjectId: "12",
      subjectType: "job",
      targetRole: null,
      targetUserId: null,
      urgent: false,
    });
    expect(row.summary).toBe("Job #12 · Superseded lighting invoice · 25 Temira Crescent — Decision needed: Pay the superseded lighting invoice, or go back to the contractor?");
    expect(row.context).toMatchObject({
      decision: { requestId: 7, tier: "soon" },
      schedule: { escalateAt: "2026-10-19T07:30:00.000Z", remindAt: ["2026-10-15T23:00:00.000Z"] },
      userTargets: [3, 5],
    });
  });

  it("ledgers decision.requested on the job (the request as 'after') beside the escalation's own row, under one correlation id", async () => {
    await ask();

    expect(mockWorld.ledger.map((e) => e.action)).toEqual(["escalation.raise", "decision.requested"]);
    const [escalationRow, requested] = mockWorld.ledger;
    expect(requested).toMatchObject({ action: "decision.requested", actor: { kind: "user", name: "Alana", role: "accounts", userId: 9 }, buildingId: 5, jobId: 12, subject: { id: 12, type: "job" } });
    expect(requested.after).toMatchObject({ question: "Pay the superseded lighting invoice, or go back to the contractor?", requestId: 7, state: "pending", tier: "soon" });
    expect(escalationRow.correlationId).toBe(requested.correlationId);
    expect(escalationRow).toMatchObject({ jobId: 12, subject: { type: "escalation" } });
  });

  describe("emailing the people asked", () => {
    it("emails each person named, in one message, naming the question, the job, the respond-by time and a link", async () => {
      await ask({ decisionMakers: { userIds: [PEOPLE.cam.id, PEOPLE.dee.id, PEOPLE.eli.id] } });

      expect(mockWorld.mail).toHaveLength(1);
      const [mail] = mockWorld.mail;
      expect(mail.to).toEqual(["cam@example.com", "dee@example.com", "eli@example.com"]);
      expect(mail.subject).toBe("Decision needed: Job #12 · Superseded lighting invoice · 25 Temira Crescent");
      expect(mail.body).toContain("Question: Pay the superseded lighting invoice, or go back to the contractor?");
      expect(mail.body).toContain("Job: Job #12 · Superseded lighting invoice · 25 Temira Crescent");
      expect(mail.body).toContain("Asked of: Cam, Dee, Eli");
      expect(mail.body).toContain("Respond by: 19/10/2026 17:00 Darwin time");
      expect(mail.body).toContain("Open it in Floorplan: https://floorplan.example/jobs?jobId=12");
    });

    it("emails every active member of a role, not the person asking", async () => {
      await ask({ assignmentMode: "role", decisionMakers: { role: "accounts_manager" } });

      expect(mockWorld.mail).toHaveLength(1);
      expect(mockWorld.mail[0].to).toEqual(["cam@example.com", "kirstin@example.com"]);
      expect(json(await get(12)).request.decisionMakers).toMatchObject({ role: "accounts_manager", roleLabel: "Accounts manager" });
    });

    it("leaves the person asking out of a role they belong to", async () => {
      await ask({ assignmentMode: "role", decisionMakers: { role: "accounts" } });
      expect(mockWorld.mail[0].to).toEqual(["gus@example.com"]);
    });

    it("sends everything to DEV_EMAIL_OVERRIDE alone, once, when it is set, and still says who was asked", async () => {
      process.env.DEV_EMAIL_OVERRIDE = "dev@example.com";

      await ask({ decisionMakers: { userIds: [PEOPLE.cam.id, PEOPLE.dee.id] } });

      expect(mockWorld.mail).toHaveLength(1);
      expect(mockWorld.mail[0].to).toEqual(["dev@example.com"]);
      expect(mockWorld.mail[0].body).toContain("Asked of: Cam, Dee");
    });

    it("says URGENT for an urgent request", async () => {
      await ask({ tier: "urgent" });
      expect(mockWorld.mail[0].subject).toMatch(/^URGENT decision needed: Job #12/);
      expect([...mockWorld.escalations.values()][0].urgent).toBe(true);
    });

    it("still creates the request when the email fails, and records the failure for the sweep to retry", async () => {
      mockWorld.mailFails = true;

      const res = await ask();

      expect(res.status).toBe(201);
      expect(json(res).chase.notificationState).toBe("failed");
      expect(mockWorld.requests).toHaveLength(1);
      expect(db.commitTransaction).toHaveBeenCalledTimes(1);
      expect(db.rollbackTransaction).not.toHaveBeenCalled();
    });

    it("still creates the request when mail is not configured, noting that it has not been sent", async () => {
      delete process.env.GRAPH_CLIENT_SECRET;

      const res = await ask();

      expect(res.status).toBe(201);
      expect(json(res).chase.notificationState).toBe("pending");
      expect(send).not.toHaveBeenCalled();
    });
  });

  describe("the tiers", () => {
    it("emergency: raises no timed escalation, no reminders, tells the screen to call them, and says so in the email", async () => {
      const res = await ask({ tier: "emergency" });

      expect(res.status).toBe(201);
      const body = json(res);
      expect(body.callThem).toBe(true);
      expect(body.request).toMatchObject({ autoEscalate: false, callThem: true, respondBy: null, tier: "emergency" });
      expect(body.chase).toMatchObject({ dueAt: null, remindAt: [], urgent: true });
      const row = [...mockWorld.escalations.values()][0];
      expect(row.dueAt).toBeNull();
      expect(row.context).toMatchObject({ schedule: { escalateAt: null, remindAt: [] } });
      expect(mockWorld.mail[0].subject).toMatch(/^EMERGENCY decision needed: /);
      expect(mockWorld.mail[0].body).toContain("needs you to call them now");
      expect(mockWorld.mail[0].body).not.toContain("Respond by:");
    });

    it("urgent, ticked to move up: due by the close of tomorrow, one reminder that morning, moves up the morning after", async () => {
      const res = await ask({ autoEscalate: true, tier: "urgent" });
      expect(res.status).toBe(201);
      const body = json(res);
      expect(body.request).toMatchObject({ autoEscalate: true, respondBy: "2026-10-13T07:30:00.000Z", tier: "urgent" });
      expect(body.chase.remindAt).toEqual(["2026-10-12T23:30:00.000Z"]);
      expect(body.chase.dueAt).toBe("2026-10-13T23:00:00.000Z");
      expect([...mockWorld.escalations.values()][0].dueAt).toEqual(new Date("2026-10-13T23:00:00Z"));
      expect(mockWorld.requests[0]).toMatchObject({ AutoEscalate: true });
      expect(json(await get(12)).request.autoEscalate).toBe(true);
    });

    it.each([[{}], [{ autoEscalate: false }], [{ autoEscalate: null }]])(
      "urgent, not ticked (%j, the default): the same deadline and reminder, and nothing moves it up",
      async (extra) => {
        const res = await ask({ tier: "urgent", ...extra });

        expect(res.status).toBe(201);
        const body = json(res);
        expect(body.request).toMatchObject({ autoEscalate: false, callThem: false, respondBy: "2026-10-13T07:30:00.000Z", tier: "urgent" });
        expect(body.chase).toMatchObject({ dueAt: null, isOverdue: false, remindAt: ["2026-10-12T23:30:00.000Z"], urgent: true });
        const row = [...mockWorld.escalations.values()][0];
        expect(row.dueAt).toBeNull();
        expect(row.context).toMatchObject({
          decision: { autoEscalate: false },
          schedule: { escalateAt: null, remindAt: ["2026-10-12T23:30:00.000Z"] },
        });
        expect(mockWorld.requests[0]).toMatchObject({ AutoEscalate: false });
        // the people are told just the same, with the respond-by and as urgent
        expect(mockWorld.mail).toHaveLength(1);
        expect(mockWorld.mail[0].subject).toMatch(/^URGENT decision needed: /);
        expect(mockWorld.mail[0].body).toContain("Respond by: 13/10/2026 17:00 Darwin time");
        // and what reads it back sees the same
        const read = json(await get(12));
        expect(read.request.autoEscalate).toBe(false);
        expect(read.chase.dueAt).toBeNull();
        expect(mockWorld.ledger.find((e) => e.action === "decision.requested")?.after).toMatchObject({
          autoEscalate: false,
          escalateAt: null,
          remindAt: ["2026-10-12T23:30:00.000Z"],
        });
      },
    );

    it("soon always moves up: its request says so and the chase is due at the deadline", async () => {
      const body = json(await ask({ tier: "soon" }));
      expect(body.request.autoEscalate).toBe(true);
      expect(body.chase.dueAt).toBe(body.request.respondBy);
    });

    it("soon accepts the tick set to true, which changes nothing", async () => {
      const plain = json(await ask({ tier: "soon" }));
      mockWorld.requests = [];
      mockWorld.escalations = new Map();
      const ticked = json(await ask({ autoEscalate: true, tier: "soon" }));
      expect(ticked.request).toMatchObject({ autoEscalate: true, respondBy: plain.request.respondBy });
      expect(ticked.chase.dueAt).toBe(plain.chase.dueAt);
    });

    it("routine: the weeks are kept", async () => {
      const body = json(await ask({ routineWeeks: 3, tier: "routine" }));
      expect(body.request).toMatchObject({ autoEscalate: true, respondBy: "2026-11-02T07:30:00.000Z", routineWeeks: 3, tier: "routine" });
      expect(body.chase.remindAt).toEqual(["2026-10-25T23:00:00.000Z"]); // Mon 26 Oct 08:30 Darwin: a week before
    });

    it("fixed: the date given, with reminders 4, 2 and 1 days before and on the day", async () => {
      const body = json(await ask({ fixedDate: "2026-10-23", tier: "fixed" }));
      expect(body.request).toMatchObject({ autoEscalate: true, fixedDate: "2026-10-23", respondBy: "2026-10-23T07:30:00.000Z", tier: "fixed" });
      expect(body.chase.remindAt).toEqual([
        "2026-10-18T23:00:00.000Z",
        "2026-10-20T23:00:00.000Z",
        "2026-10-21T23:00:00.000Z",
        "2026-10-22T23:00:00.000Z",
      ]);
    });

    it("skips a holiday from ESCALATION_HOLIDAYS", async () => {
      process.env.ESCALATION_HOLIDAYS = "2026-10-19";
      const body = json(await ask());
      expect(body.request.respondBy).toBe("2026-10-20T07:30:00.000Z");
    });

    it.each([
      [{ tier: "whenever" }, 400, "invalid_tier"],
      [{ autoEscalate: false, tier: "soon" }, 400, "auto_escalate_not_optional"],
      [{ autoEscalate: false, routineWeeks: 3, tier: "routine" }, 400, "auto_escalate_not_optional"],
      [{ autoEscalate: false, fixedDate: "2026-10-23", tier: "fixed" }, 400, "auto_escalate_not_optional"],
      [{ autoEscalate: "yes", tier: "urgent" }, 400, "auto_escalate_invalid"],
      [{ autoEscalate: 0, tier: "urgent" }, 400, "auto_escalate_invalid"],
      [{ autoEscalate: "false", tier: "emergency" }, 400, "auto_escalate_invalid"],
      [{ tier: "routine" }, 400, "routine_weeks_required"],
      [{ routineWeeks: 12, tier: "routine" }, 400, "routine_weeks_invalid"],
      [{ tier: "fixed" }, 400, "fixed_date_required"],
      [{ fixedDate: "2026-02-30", tier: "fixed" }, 400, "fixed_date_invalid"],
      [{ fixedDate: "2026-10-09", tier: "fixed" }, 422, "fixed_date_past"],
      [{ fixedDate: "2026-10-17", tier: "fixed" }, 422, "fixed_date_not_a_working_day"],
      [{ fixedDate: "2028-01-03", tier: "fixed" }, 422, "fixed_date_too_far"],
    ])("refuses %j with %i %s, before opening a transaction", async (over, status, code) => {
      const res = await ask(over);
      expect(res).toMatchObject({ jsonBody: { code }, status });
      nothingWritten();
      expect(db.beginTransaction).not.toHaveBeenCalled();
    });
  });

  describe("only an Admin / Accounts job", () => {
    it("refuses a facilities job (422) and writes nothing", async () => {
      const res = await ask({ jobId: 13 });

      expect(res).toMatchObject({ jsonBody: { code: "not_an_admin_job", kind: "facilities" }, status: 422 });
      nothingWritten();
      expect(mockWorld.events).toEqual(["begin", "rollback"]);
    });

    it("refuses a job that doesn't exist (404), a closed one (409) and an archived one (409)", async () => {
      expect(await ask({ jobId: 999 })).toMatchObject({ jsonBody: { code: "job_not_found" }, status: 404 });
      mockWorld.jobs.set(12, job(12, "admin", { Status: "Done" }));
      expect(await ask()).toMatchObject({ jsonBody: { code: "job_closed" }, status: 409 });
      mockWorld.jobs.set(12, job(12, "admin", { IsArchived: true }));
      expect(await ask()).toMatchObject({ jsonBody: { code: "job_closed" }, status: 409 });
      nothingWritten();
    });
  });

  describe("who may ask", () => {
    it.each(["fay", "alana", "cam", "dee", "ada"])("%s may, whatever their role, if they may create jobs", async (key) => {
      const asker = PEOPLE[key];
      const res = await ask({ decisionMakers: { userIds: [PEOPLE.eli.id] } }, key);
      // a named person can't be the asker, so Eli is the one asked in each case
      expect(res.status).toBe(201);
      expect(json(res).request.requestedBy).toBe(asker.name);
    });

    it("refuses the baseline user (403) before it reads anything", async () => {
      expect((await ask({}, "una")).status).toBe(403);
      nothingWritten();
    });
  });

  describe("the people asked", () => {
    it.each([
      [{ userIds: [PEOPLE.cam.id, PEOPLE.alana.id] }, "decision_maker_is_requester"],
      [{ userIds: [PEOPLE.cam.id, 999] }, "decision_maker_unknown"],
      [{ userIds: [PEOPLE.cam.id, PEOPLE.una.id] }, "decision_maker_role_not_allowed"],
    ])("refuses %j with 422 %s", async (decisionMakers, code) => {
      expect(await ask({ decisionMakers })).toMatchObject({ jsonBody: { code }, status: 422 });
      nothingWritten();
    });

    it("refuses a role with nobody else in it (422)", async () => {
      expect(await ask({ assignmentMode: "role", decisionMakers: { role: "cfo" } })).toMatchObject({ jsonBody: { code: "role_has_no_one" }, status: 422 });
      nothingWritten();
    });
  });

  describe("the source file", () => {
    it("is kept on the request when it is on the job", async () => {
      const body = json(await ask({ sourceAttachmentId: 77 }));
      expect(body.request.sourceAttachmentId).toBe(77);
      expect(mockWorld.requests[0].SourceAttachmentId).toBe(77);
    });

    it("is refused when it belongs to another job (422), with nothing written", async () => {
      const res = await ask({ sourceAttachmentId: 88 });
      expect(res).toMatchObject({ jsonBody: { code: "attachment_not_on_job", sourceAttachmentId: 88 }, status: 422 });
      nothingWritten();
    });

    it("is refused when there is no such file", async () => {
      expect(await ask({ sourceAttachmentId: 5000 })).toMatchObject({ jsonBody: { code: "attachment_not_on_job" }, status: 422 });
      nothingWritten();
    });
  });

  describe("one question at a time", () => {
    it("refuses a second while the first waits (409) and returns the one that is waiting", async () => {
      await ask();
      mockWorld.mail.length = 0;

      const res = await ask({ question: "Another?" });

      expect(res).toMatchObject({ jsonBody: { code: "already_pending", request: { question: expect.stringContaining("Pay the superseded"), requestId: 7, state: "pending" } }, status: 409 });
      expect(mockWorld.requests).toHaveLength(1);
      expect(mockWorld.escalations.size).toBe(1);
      expect(mockWorld.mail).toHaveLength(0);
    });

    it("lets a job ask again once the question was withdrawn", async () => {
      await ask();
      await withdraw({ reason: "Raised on the wrong job", requestId: 7 });

      const res = await ask({ question: "Right job this time?" });

      expect(res.status).toBe(201);
      expect(json(res).request.requestId).toBe(8);
    });
  });

  describe("no ledger row, no decision", () => {
    it("rolls the request and the escalation back, emails no one and answers 500 when the decision.requested row fails", async () => {
      ledger.mockImplementation(async (_c, entry) => {
        mockWorld.events.push(`ledger:${entry.action}`);
        if (entry.action === "decision.requested") throw new Error("ledger unavailable");
        mockWorld.ledger.push(entry);
      });

      const res = await ask();

      expect(res.status).toBe(500);
      nothingWritten();
      expect(mockWorld.events).toEqual(["begin", "insert request", "job flag", "ledger:escalation.raise", "ledger:decision.requested", "rollback"]);
      expect(db.commitTransaction).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
    });

    it("rolls everything back when the escalation's own ledger row fails", async () => {
      ledger.mockImplementation(async (_c, entry) => {
        mockWorld.events.push(`ledger:${entry.action}`);
        if (entry.action === "escalation.raise") throw new Error("ledger unavailable");
        mockWorld.ledger.push(entry);
      });

      const res = await ask();

      expect(res.status).toBe(500);
      nothingWritten();
      expect(mockWorld.events).toEqual(["begin", "insert request", "job flag", "ledger:escalation.raise", "rollback"]);
    });

    it("rolls everything back when the policy is switched off (422) and writes no request either", async () => {
      policyOf.mockResolvedValue({ ...POLICY, active: false });

      const res = await ask();

      expect(res).toMatchObject({ jsonBody: { code: "policy_inactive" }, status: 422 });
      nothingWritten();
      expect(mockWorld.events).toEqual(["begin", "insert request", "rollback"]);
    });

    it("answers 500 for an unexpected failure, reports it, and leaves nothing behind", async () => {
      ledger.mockRejectedValue(new Error("Msg 2627 something broke"));
      const res = await ask();
      expect(res.status).toBe(500);
      expect(json(res).error).toBe("requestJobDecision failed");
      expect(Sentry.captureException).toHaveBeenCalled();
      nothingWritten();
    });
  });

  describe("bad input", () => {
    it("answers 400 for a body that is not JSON, or not an object", async () => {
      expect(await requestJobDecision(req({ headers: as("alana"), jsonThrows: true }), context())).toMatchObject({ jsonBody: { code: "bad_request" }, status: 400 });
      expect(await requestJobDecision(req({ body: [1], headers: as("alana") }), context())).toMatchObject({ status: 400 });
      expect(await requestJobDecision(req({ body: null, headers: as("alana") }), context())).toMatchObject({ status: 400 });
    });

    it.each([
      [{ question: "" }, "question"],
      [{ jobId: "x" }, "jobId"],
      [{ assignmentMode: "all" }, "assignmentMode"],
      [{ decisionMakers: { userIds: [] } }, "userIds"],
    ])("answers 400 for %j", async (over, word) => {
      const res = await ask(over);
      expect(res.status).toBe(400);
      expect(json(res).error).toContain(word);
      nothingWritten();
    });
  });

  it("is limited to 30 a minute per person", async () => {
    rateLimit.mockReturnValue({ allowed: false, retryAfterMs: 12_000 } as never);
    const res = await ask();
    expect(res).toMatchObject({ headers: { "Retry-After": "12" }, status: 429 });
    nothingWritten();
  });
});

// ── Read ─────────────────────────────────────────────────────────────────────

describe("getJobDecisionRequest", () => {
  it("answers null for a job that never asked", async () => {
    expect(await get(12)).toMatchObject({ jsonBody: { chase: null, request: null }, status: 200 });
  });

  it("shows a pending request, and the chase behind it, to everyone who may read the job", async () => {
    await ask({ routineWeeks: 2, tier: "routine" });

    for (const key of ["alana", "fay", "gus", "cam", "dee", "ada"]) {
      const res = await get(12, key);
      expect(res.status).toBe(200);
      expect(json(res).request).toMatchObject({ jobId: 12, requestId: 7, state: "pending", tier: "routine" });
      expect(json(res).chase).toMatchObject({ escalationId: 100, status: "open", targetNames: ["Cam", "Dee"] });
    }
  });

  it("shows how the last one ended, with no chase, once it was withdrawn", async () => {
    await ask();
    await withdraw({ reason: "Raised on the wrong job", requestId: 7 });

    const body = json(await get(12));

    expect(body.chase).toBeNull();
    expect(body.request).toMatchObject({
      requestId: 7,
      state: "withdrawn",
      withdrawn: { by: "Alana", byUserId: 9, reason: "Raised on the wrong job" },
    });
  });

  it("prefers the one that is waiting over an older one", async () => {
    await ask();
    await withdraw({ reason: "Wrong job", requestId: 7 });
    await ask({ question: "Right job this time?" });

    expect(json(await get(12)).request).toMatchObject({ question: "Right job this time?", requestId: 8, state: "pending" });
  });

  it("answers 404 for a job that doesn't exist and 400 without a job id", async () => {
    expect(await get(999)).toMatchObject({ jsonBody: { code: "job_not_found" }, status: 404 });
    expect(await getJobDecisionRequest(req({ headers: as("alana") }), context())).toMatchObject({ status: 400 });
    expect(await get("abc")).toMatchObject({ status: 400 });
  });
});

// ── Withdraw ─────────────────────────────────────────────────────────────────

describe("withdrawJobDecisionRequest", () => {
  beforeEach(async () => {
    await ask();
    mockWorld.events.length = 0;
    mockWorld.ledger.length = 0;
    mockWorld.mail.length = 0;
    db.commitTransaction.mockClear();
    db.rollbackTransaction.mockClear();
  });

  it("takes the question back: the request, the chase and the ledger, together; nobody is emailed", async () => {
    const res = await withdraw({ reason: "Raised on the wrong job", requestId: 7 });

    expect(res.status).toBe(200);
    expect(json(res).request).toMatchObject({
      requestId: 7,
      state: "withdrawn",
      withdrawn: { by: "Alana", byUserId: 9, reason: "Raised on the wrong job" },
    });
    expect(mockWorld.events).toEqual(["begin", "job flag", "ledger:escalation.withdraw", "mark withdrawn", "ledger:decision.withdrawn", "commit"]);
    expect([...mockWorld.escalations.values()][0]).toMatchObject({ resolutionCode: "withdrawn", resolutionNote: "Raised on the wrong job", status: "withdrawn" });
    expect(mockWorld.mail).toHaveLength(0);
  });

  it("ledgers decision.withdrawn on the job with the reason, as an exception the engine's row shares an id with", async () => {
    await withdraw({ reason: "Raised on the wrong job", requestId: 7 });

    const [fromEngine, withdrawn] = mockWorld.ledger;
    expect(withdrawn).toMatchObject({ action: "decision.withdrawn", jobId: 12, reason: "Raised on the wrong job", subject: { id: 12, type: "job" } });
    expect(withdrawn.before).toMatchObject({ requestId: 7, state: "pending" });
    expect(withdrawn.after).toMatchObject({ requestId: 7, state: "withdrawn" });
    expect(fromEngine).toMatchObject({ action: "escalation.withdraw", reason: "Raised on the wrong job" });
    expect(fromEngine.correlationId).toBe(withdrawn.correlationId);
  });

  it("needs a reason (400), and changes nothing without one", async () => {
    for (const reason of [undefined, "", "   "]) {
      expect(await withdraw({ reason, requestId: 7 })).toMatchObject({ jsonBody: { code: "reason_required" }, status: 400 });
    }
    expect(mockWorld.requests[0].State).toBe("pending");
    expect(mockWorld.ledger).toHaveLength(0);
  });

  it("is for the person who asked, or an admin", async () => {
    expect(await withdraw({ reason: "x", requestId: 7 }, "gus")).toMatchObject({ jsonBody: { code: "forbidden" }, status: 403 });
    expect(await withdraw({ reason: "x", requestId: 7 }, "dee")).toMatchObject({ status: 403 });
    expect(mockWorld.requests[0].State).toBe("pending");
    expect([...mockWorld.escalations.values()][0].status).toBe("open");

    const res = await withdraw({ reason: "Raised in error", requestId: 7 }, "ada");
    expect(res.status).toBe(200);
    expect(json(res).request.withdrawn).toMatchObject({ by: "Ada", reason: "Raised in error" });
  });

  it("answers 404 for a request that doesn't exist and 400 for an id that isn't one", async () => {
    expect(await withdraw({ reason: "x", requestId: 99 })).toMatchObject({ jsonBody: { code: "not_found" }, status: 404 });
    expect(await withdraw({ reason: "x", requestId: "abc" })).toMatchObject({ status: 400 });
    expect(await withdraw({ reason: "x" })).toMatchObject({ status: 400 });
  });

  it("answers 409 for one that is already withdrawn, carrying it", async () => {
    await withdraw({ reason: "first", requestId: 7 });
    const res = await withdraw({ reason: "again", requestId: 7 });
    expect(res).toMatchObject({ jsonBody: { code: "not_pending", request: { state: "withdrawn" } }, status: 409 });
  });

  it("answers 409 for a stale version, carrying the request as it is", async () => {
    const res = await withdraw({ reason: "x", requestId: 7, rowVersion: rowVersion(9).toString("base64") });
    expect(res).toMatchObject({ jsonBody: { code: "stale", request: { requestId: 7, state: "pending" } }, status: 409 });
    expect(mockWorld.requests[0].State).toBe("pending");
  });

  it("accepts the version it was given", async () => {
    const asked = json(await get(12)).request.rowVersion as string;
    expect((await withdraw({ reason: "x", requestId: 7, rowVersion: asked })).status).toBe(200);
  });

  it("rolls the request and the chase back together when the ledger fails, leaving the question waiting", async () => {
    ledger.mockImplementation(async (_c, entry) => {
      mockWorld.events.push(`ledger:${entry.action}`);
      if (entry.action === "decision.withdrawn") throw new Error("ledger unavailable");
      mockWorld.ledger.push(entry);
    });

    const res = await withdraw({ reason: "x", requestId: 7 });

    expect(res.status).toBe(500);
    expect(mockWorld.requests[0].State).toBe("pending");
    expect([...mockWorld.escalations.values()][0].status).toBe("open");
    expect(mockWorld.ledger).toHaveLength(0);
    expect(db.commitTransaction).not.toHaveBeenCalled();
  });

  it("ends the chase at whichever level it has reached", async () => {
    // moved up to the manager by the sweep: a new row, the first superseded
    const first = [...mockWorld.escalations.values()][0];
    first.status = "superseded";
    mockWorld.escalations.set(101, { ...first, escalationId: 101, level: 2, parentEscalationId: first.escalationId, status: "open", targetRole: "accounts_manager" });

    await withdraw({ reason: "Sorted out by phone", requestId: 7 });

    expect(mockWorld.escalations.get(101)).toMatchObject({ resolutionCode: "withdrawn", status: "withdrawn" });
    expect(mockWorld.escalations.get(first.escalationId)?.status).toBe("superseded");
  });

  it("can't be done through the generic escalation endpoint either", async () => {
    // the engine refuses to withdraw a decision request's escalation by itself
    const { withdraw: engineWithdraw } = require("../escalation/engine") as typeof import("../escalation/engine");
    await expect(engineWithdraw({} as never, { actor: { kind: "user", name: "Alana", role: "accounts", userId: 9 }, escalationId: 100, reason: "x" })).rejects.toMatchObject({ code: "bad_request" });
    expect([...mockWorld.escalations.values()][0].status).toBe("open");
  });
});

describe("the people it was asked of see it", () => {
  it("is in each named person's inbox rows by the same test the inbox query makes", async () => {
    await ask({ decisionMakers: { userIds: [PEOPLE.cam.id, PEOPLE.dee.id] } });
    const row = [...mockWorld.escalations.values()][0];
    const { canSee, isTargetOf } = require("../escalation/permissions") as typeof import("../escalation/permissions");
    const viewer = (key: string) => ({ name: PEOPLE[key].name, roles: [PEOPLE[key].role], userId: PEOPLE[key].id });

    for (const key of ["cam", "dee"]) {
      expect({ key, target: isTargetOf(viewer(key), row), see: canSee(viewer(key), row) }).toEqual({ key, see: true, target: true });
    }
    for (const key of ["fay", "gus", "kirstin"]) {
      expect({ key, target: isTargetOf(viewer(key), row), see: canSee(viewer(key), row) }).toEqual({ key, see: false, target: false });
    }
    expect(KEYS).toContain("kirstin");
  });
});
