/// <reference types="jest" />
// Answering a decision request and finishing what it hands on (jobs plan A2), from
// the HTTP handlers down: ask -> respond -> next step -> done, and a deferral coming
// back on its day. The real handlers, auth, services, escalation engine, notifier,
// sweep and ledger validation run against an in-memory stand-in for the tables they
// write (the SQL itself is proved separately, against a real SQL Server). Only the mail
// transport and the ledger's INSERT are replaced, so what is shown is the whole path:
// who may answer, that the decision, the request, the chase, the job and the ledger
// commit or roll back together, and who is emailed (and who is not), when.
import type { HttpRequest, InvocationContext } from "@azure/functions";
import { clearRoleCache } from "../auth";
import { graphSendMail } from "../graph";
import { getPolicy } from "../escalation/policies";
import { defaultSweepDeps, runSweep } from "../escalation/sweep";
import type { EscalationPolicy, EscalationRow } from "../escalation/types";
import { assertLedgerEntry, record, type LedgerEntryInput } from "../ledger";
import type { DecisionRow } from "../jobDecisions/decisionsStore";
import type { DecisionRequestRow } from "../jobDecisions/store";
import { checkRateLimit } from "../rateLimit";
import { completeJobNextStep } from "./completeJobNextStep";
import { getJobDecisionRequest } from "./getJobDecisionRequest";
import { requestJobDecision } from "./requestJobDecision";
import { respondToJobDecision } from "./respondToJobDecision";
import { withdrawJobDecisionRequest } from "./withdrawJobDecisionRequest";

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
// Escalation emails ask whether the job is a test record (D9); none is here.
jest.mock("../test-data", () => ({ ...jest.requireActual("../test-data"), readIsTest: jest.fn().mockResolvedValue(false) }));
jest.mock("../graph", () => ({ graphSendMail: jest.fn() }));
jest.mock("../rateLimit", () => ({ checkRateLimit: jest.fn(() => ({ allowed: true })) }));
jest.mock("../sentry", () => ({ Sentry: { captureException: jest.fn(), captureMessage: jest.fn(), flush: jest.fn() } }));
jest.mock("../escalation/policies", () => ({ getPolicy: jest.fn() }));

// ── The in-memory tables ─────────────────────────────────────────────────────

type Row = Record<string, unknown>;

interface JobRec {
  assignedTo: string | null;
  assignedToUserId: number | null;
  awaitingRole: string;
  buildingId: number;
  buildingName: string;
  createdBy: string;
  createdById: string;
  isArchived: boolean;
  isInternal: boolean;
  /** Jobs.IsTest: the job is test data (decision 4). */
  isTest?: boolean;
  jobId: number;
  kind: string;
  status: string;
  title: string;
}

const mockWorld = {
  attachments: new Map<number, number>(),
  clock: 1,
  decisions: [] as DecisionRow[],
  escalations: new Map<number, EscalationRow>(),
  events: [] as string[],
  jobEvents: [] as { createdBy: string; eventType: string; jobId: number; newAssignee?: string | null; newStatus?: string | null; text: string }[],
  jobs: new Map<number, JobRec>(),
  ledger: [] as LedgerEntryInput[],
  mail: [] as { body: string; subject: string; to: string[] }[],
  mailFails: false,
  nextDecisionId: 4,
  nextEscalationId: 100,
  nextRequestId: 7,
  requests: [] as DecisionRequestRow[],
  snapshot: null as null | { decisions: DecisionRow[]; escalations: Map<number, EscalationRow>; jobEvents: unknown[]; jobs: Map<number, JobRec>; ledger: LedgerEntryInput[]; requests: DecisionRequestRow[] },
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
      const now = new Date();
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
    latestTimesBySubject: jest.fn(async () => new Map()),
    listActiveUsers: jest.fn(async () => mockWorld.users.map((u) => ({ ...u }))),
    listLiveEscalations: jest.fn(async () => [...mockWorld.escalations.values()].filter(live).map((r) => ({ ...r }))),
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

const mockRowVersion = (): string => Buffer.from([0, 0, 0, 0, 0, 0, 0, mockWorld.clock++ % 250]).toString("base64");
const mockCopy = <T extends object | null | undefined>(row: T): T => (row ? ({ ...row } as T) : (null as T));
const mockIsPending = (jobId: number) => mockWorld.requests.find((r) => r.jobId === jobId && r.state === "pending");

jest.mock("../jobDecisions/store", () => {
  const actual = jest.requireActual("../jobDecisions/store");
  return {
    ...actual,
    attachmentOnJob: jest.fn(async (_c: unknown, id: number, jobId: number) => mockWorld.attachments.get(id) === jobId),
    findPending: jest.fn(async (_c: unknown, jobId: number) => mockCopy(mockIsPending(jobId))),
    getRequestRow: jest.fn(async (_c: unknown, id: number) => mockCopy(mockWorld.requests.find((r) => r.requestId === id))),
    insertRequest: jest.fn(async (_c: unknown, request: Record<string, unknown>) => {
      mockWorld.events.push("insert request");
      if (mockIsPending(request.jobId as number)) {
        throw Object.assign(new Error("Cannot insert duplicate key row in object 'dbo.JobDecisionRequests' with unique index 'UX_JobDecisionRequests_Pending'."), { number: 2601 });
      }
      const requestId = mockWorld.nextRequestId++;
      mockWorld.requests.push({
        ...(request as object),
        requestId,
        requestedAt: new Date(),
        rowVersion: mockRowVersion(),
        state: "pending",
        withdrawnAt: null,
        withdrawnBy: null,
        withdrawnByUserId: null,
        withdrawnReason: null,
      } as DecisionRequestRow);
      return requestId;
    }),
    jobBuilding: jest.fn(async (_c: unknown, jobId: number) => {
      const job = mockWorld.jobs.get(jobId);
      return job ? { buildingId: job.buildingId } : null;
    }),
    latestForJob: jest.fn(async (_c: unknown, jobId: number) => mockCopy([...mockWorld.requests].reverse().find((r) => r.jobId === jobId))),
    lockJob: jest.fn(async (_c: unknown, jobId: number) => {
      const job = mockWorld.jobs.get(jobId);
      return job
        ? { buildingId: job.buildingId, buildingName: job.buildingName, isArchived: job.isArchived, jobId, kind: job.kind, status: job.status, title: job.title }
        : null;
    }),
    markWithdrawn: jest.fn(async (_c: unknown, requestId: number, w: { at: Date; by: string; byUserId: number | null; reason: string }) => {
      mockWorld.events.push("mark withdrawn");
      const found = mockWorld.requests.find((r) => r.requestId === requestId && r.state === "pending");
      if (!found) return false;
      Object.assign(found, { rowVersion: mockRowVersion(), state: "withdrawn", withdrawnAt: w.at, withdrawnBy: w.by, withdrawnByUserId: w.byUserId, withdrawnReason: w.reason });
      return true;
    }),
    peopleByIds: jest.fn(async (_c: unknown, ids: number[]) => {
      const people = new Map<number, { active: boolean; name: string; role: string | null }>();
      for (const id of ids) {
        const u = mockWorld.users.find((x) => x.userId === id);
        if (u) people.set(id, { active: true, name: u.name, role: u.role });
      }
      return people;
    }),
    requestsAboutAttachment: jest.fn(async () => []),
  };
});

jest.mock("../jobDecisions/decisionsStore", () => {
  const unique = (index: string) => Object.assign(new Error(`Cannot insert duplicate key row in object 'dbo.JobDecisions' with unique index '${index}'.`), { number: 2601 });
  return {
    activeUserIdByOid: jest.fn(async (_c: unknown, oid: string) => mockWorld.users.find((u) => `oid-${u.name.toLowerCase()}` === oid)?.userId ?? null),
    closeNextStep: jest.fn(async (_c: unknown, id: number, closing: { at: Date; byId: number | null; byName: string; expectedRowVersion?: string | null; kind: "done" | "replaced"; note: string | null }) => {
      mockWorld.events.push(`close step ${closing.kind}`);
      const found = mockWorld.decisions.find((d) => d.decisionId === id);
      if (!found || found.nextStep === null || found.nextStepClosed || (closing.expectedRowVersion && closing.expectedRowVersion !== found.rowVersion)) return false;
      found.nextStepClosed = { at: closing.at, byId: closing.byId, byName: closing.byName, kind: closing.kind, note: closing.note };
      found.rowVersion = mockRowVersion();
      return true;
    }),
    decisionForRequest: jest.fn(async (_c: unknown, requestId: number) => mockCopy(mockWorld.decisions.find((d) => d.requestId === requestId))),
    dueDeferrals: jest.fn(async (_c: unknown, today: string, limit: number) =>
      mockWorld.decisions
        .filter(
          (d) =>
            d.outcome === "defer" &&
            d.reaskRequestId === null &&
            (d.deferUntil ?? "9999") <= today &&
            !mockWorld.jobs.get(d.jobId)?.isArchived &&
            mockWorld.jobs.get(d.jobId)?.status !== "Done" &&
            !mockWorld.requests.some((r) => r.jobId === d.jobId && r.requestId > d.requestId),
        )
        .slice(0, limit)
        .map((d) => ({ decisionId: d.decisionId, deferUntil: d.deferUntil as string, jobId: d.jobId, requestId: d.requestId })),
    ),
    getDecisionRow: jest.fn(async (_c: unknown, id: number) => mockCopy(mockWorld.decisions.find((d) => d.decisionId === id))),
    hasLaterRequest: jest.fn(async (_c: unknown, jobId: number, after: number) => mockWorld.requests.some((r) => r.jobId === jobId && r.requestId > after)),
    hasScheduledReask: jest.fn(async (_c: unknown, jobId: number) =>
      mockWorld.decisions.some((d) => d.jobId === jobId && d.outcome === "defer" && d.reaskRequestId === null && !mockWorld.requests.some((r) => r.jobId === jobId && r.requestId > d.requestId)),
    ),
    insertDecision: jest.fn(async (_c: unknown, d: Record<string, unknown>) => {
      mockWorld.events.push("insert decision");
      if (mockWorld.decisions.some((x) => x.requestId === d.requestId)) throw unique("UX_JobDecisions_Request");
      const decisionId = mockWorld.nextDecisionId++;
      mockWorld.decisions.push({
        decisionId,
        deferUntil: (d.deferUntil as string | null) ?? null,
        jobId: d.jobId as number,
        nextStep: (d.nextStep as string | null) ?? null,
        nextStepClosed: null,
        nextStepDueAt: (d.nextStepDueAt as Date | null) ?? null,
        nextStepOwnerRole: (d.nextStepOwnerRole as string | null) ?? null,
        nextStepOwnerUserId: (d.nextStepOwnerUserId as number | null) ?? null,
        outcome: d.outcome as DecisionRow["outcome"],
        rationale: d.rationale as string,
        reaskRequestId: null,
        requestId: d.requestId as number,
        respondedAt: d.respondedAt as Date,
        respondedById: (d.respondedById as number | null) ?? null,
        respondedByName: d.respondedByName as string,
        rowVersion: mockRowVersion(),
      });
      return decisionId;
    }),
    insertJobEvent: jest.fn(async (_c: unknown, event: { createdBy: string; eventType: string; jobId: number; newAssignee?: string | null; newStatus?: string | null; text: string }) => {
      mockWorld.events.push(`job event ${event.eventType}`);
      mockWorld.jobEvents.push(event);
    }),
    jobParties: jest.fn(async (_c: unknown, jobId: number) => {
      const job = mockWorld.jobs.get(jobId);
      return job ? { assignedTo: job.assignedTo, assignedToUserId: job.assignedToUserId, createdBy: job.createdBy, createdById: job.createdById } : null;
    }),
    latestDecisionForJob: jest.fn(async (_c: unknown, jobId: number) => mockCopy([...mockWorld.decisions].reverse().find((d) => d.jobId === jobId))),
    markRequestAnswered: jest.fn(async (_c: unknown, requestId: number, expected: string) => {
      mockWorld.events.push("mark answered");
      const found = mockWorld.requests.find((r) => r.requestId === requestId && r.state === "pending" && r.rowVersion === expected);
      if (!found) return false;
      Object.assign(found, { rowVersion: mockRowVersion(), state: "answered" });
      return true;
    }),
    openNextSteps: jest.fn(async (_c: unknown, jobId: number) =>
      mockWorld.decisions
        .filter((d) => d.jobId === jobId && d.nextStep !== null && !d.nextStepClosed)
        .sort((a, b) => b.decisionId - a.decisionId)
        .map((d) => ({ ...d })),
    ),
    reassignJob: jest.fn(async (_c: unknown, jobId: number, assignee: { name: string; userId: number | null }) => {
      mockWorld.events.push("reassign");
      const job = mockWorld.jobs.get(jobId);
      if (job) Object.assign(job, { assignedTo: assignee.name, assignedToUserId: assignee.userId });
    }),
    stampReask: jest.fn(async (_c: unknown, decisionId: number, requestId: number) => {
      mockWorld.events.push("stamp");
      const found = mockWorld.decisions.find((d) => d.decisionId === decisionId);
      if (!found || found.outcome !== "defer" || found.reaskRequestId !== null) return false;
      if (mockWorld.decisions.some((d) => d.reaskRequestId === requestId)) throw unique("UX_JobDecisions_Reask");
      found.reaskRequestId = requestId;
      return true;
    }),
  };
});

jest.mock("../jobTransitionFacts", () => ({
  loadJobForTransition: jest.fn(async (_c: unknown, jobId: number) => {
    const job = mockWorld.jobs.get(jobId);
    if (!job) return null;
    return {
      buildingId: job.buildingId,
      current: { awaitingRole: job.awaitingRole, status: job.status },
      facts: {
        allInvoicesPaid: false,
        approvedInvoicesNotInMyob: 0,
        hasApprovedQuote: false,
        hasQuote: false,
        incomingInvoices: 0,
        incomingInvoicesAwaitingApproval: 0,
        isContract: false,
        isInternal: job.isInternal,
      },
      hasMoneyRecords: false,
      preBlock: null,
    };
  }),
}));

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

const jwt = (payload: Record<string, unknown>): string => {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${enc({ alg: "none" })}.${enc(payload)}.sig`;
};
const as = (key: string): Record<string, string> => {
  const person = PEOPLE[key];
  return {
    authorization: `Bearer ${jwt({ name: person.name, oid: `oid-${key}`, preferred_username: `${person.name.toLowerCase()}@example.com` })}`,
    "x-dev-roles": person.role,
  };
};

function req({ body, headers = as("alana"), query = {} }: { body?: unknown; headers?: Record<string, string>; query?: Record<string, string> } = {}): HttpRequest {
  return {
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    json: async () => body,
    query: new URLSearchParams(query),
  } as unknown as HttpRequest;
}
const context = (): InvocationContext => ({ error: jest.fn(), log: jest.fn(), warn: jest.fn() }) as unknown as InvocationContext;

// ── The fake database (what the real engine and adapters still ask SQL) ──────

function installDatabase(): void {
  db.executeQuery.mockImplementation(async (_c: unknown, sql: string, params: { name: string; value: unknown }[] = []) => {
    const p = Object.fromEntries(params.map((x) => [x.name, x.value]));
    const text = sql.replace(/\s+/g, " ");

    if (/SELECT UserID FROM dbo\.AppUsers WHERE EntraOid = @Oid/.test(text)) {
      const person = PEOPLE[String(p.Oid).replace("oid-", "")];
      return person ? [{ UserID: person.id }] : [];
    }
    if (/SELECT COL_LENGTH\('dbo\.Jobs', 'IsTest'\) AS Len/.test(text)) return [{ Len: 1 }];
    if (/SELECT IsTest FROM Jobs WHERE JobID = @JobID/.test(text)) {
      const job = mockWorld.jobs.get(p.JobID as number);
      return job ? [{ IsTest: job.isTest ? 1 : 0 }] : [];
    }
    if (/SELECT BuildingID FROM Jobs WHERE JobID = @JobID/.test(text)) {
      const job = mockWorld.jobs.get(p.JobID as number);
      return job ? [{ BuildingID: job.buildingId }] : [];
    }
    if (/FROM dbo\.Jobs j LEFT JOIN dbo\.Buildings b ON b\.BuildingID = j\.BuildingID WHERE j\.JobID = @JobID/.test(text)) {
      const job = mockWorld.jobs.get(p.JobID as number);
      return job
        ? [
            {
              AcknowledgedAt: null, AssignedTo: job.assignedTo, AssignedToUserID: job.assignedToUserId, BuildingID: job.buildingId, BuildingName: job.buildingName,
              CreatedAt: new Date("2026-10-01T00:00:00Z"), ExpectedProgressUpdate: null, FirstQuoteRequestAt: null, IsArchived: job.isArchived, JobID: job.jobId, Kind: job.kind,
              OldestPendingInvoiceAt: null, PendingInvoices: 0, Priority: "Normal", QuoteCount: 0, RequestedContractors: 0, Status: job.status, StatusSince: null, Title: job.title,
            },
          ]
        : [];
    }
    // The sweep's TR1 step (unacknowledged tenant requests): none here.
    if (/FROM dbo\.WorkRequests wr[\s\S]*INNER JOIN dbo\.IntakeResponseTargets/.test(text)) return [];
    // The sweep's attribution-notice step (R2, R13): nothing unanswered here.
    if (/ApprovalAttributedToUserID IS NOT NULL AND AttributionAnsweredAt IS NULL/.test(text)) return [];
    if (/UPDATE dbo\.Jobs SET EscalatedAt/.test(text)) {
      mockWorld.events.push("job flag");
      return [];
    }
    if (/FROM dbo\.JobDecisions d JOIN dbo\.Jobs j ON j\.JobID = d\.JobId WHERE d\.JobId = @JobID AND d\.NextStep IS NOT NULL/.test(text)) {
      const job = mockWorld.jobs.get(p.JobID as number);
      const open = mockWorld.decisions.some((d) => d.jobId === p.JobID && d.nextStep !== null && !d.nextStepClosed);
      return [{ IsOpen: open && job && !job.isArchived && job.status !== "Done" ? 1 : 0 }];
    }
    if (/UPDATE dbo\.Jobs SET Status = @Status/.test(text)) {
      const job = mockWorld.jobs.get(p.JobID as number);
      if (!job || job.status !== p.ExpectedStatus) return [];
      mockWorld.events.push("close job");
      Object.assign(job, { awaitingRole: p.AwaitingRole, status: p.Status });
      return [{ JobID: job.jobId }];
    }
    throw new Error(`unexpected SQL: ${text}`);
  });
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

// Monday 2026-10-12, 09:00 Darwin
const NOW = new Date(Date.UTC(2026, 9, 12, 9, 0) - 9.5 * 3_600_000);
const darwin = (date: string, hhmm: string): Date => {
  const [y, m, d] = date.split("-").map(Number);
  const [h, min] = hhmm.split(":").map(Number);
  return new Date(Date.UTC(y, m - 1, d, h, min) - 9.5 * 3_600_000);
};

const POLICIES: Record<string, EscalationPolicy> = {
  "job.decision_pending": {
    active: true, autoReescalate: "yes", clock: "business", kind: "authority", updatedAt: null, updatedBy: null, urgent: false,
    ladder: [{ userTarget: true }, { slaHours: 16, token: "raiser_manager" }, { role: "director" }],
    policyKey: "job.decision_pending",
  },
  "job.next_step": {
    active: true, autoReescalate: "yes", clock: "business", kind: "attention", updatedAt: null, updatedBy: null, urgent: false,
    ladder: [{ userTarget: true }, { slaHours: 16, token: "raiser_manager" }, { role: "director" }],
    policyKey: "job.next_step",
  },
};

const job = (jobId: number, kind: string, over: Partial<JobRec> = {}): JobRec => ({
  assignedTo: null, assignedToUserId: null, awaitingRole: "facilities", buildingId: 5, buildingName: "25 Temira Crescent", createdBy: "Alana", createdById: "oid-alana",
  isArchived: false, isInternal: kind === "admin", jobId, kind, status: "New", title: "Superseded lighting invoice", ...over,
});

const MAIL_ENV = {
  APP_BASE_URL: "https://floorplan.example",
  GRAPH_CLIENT_ID: "id",
  GRAPH_CLIENT_SECRET: "secret",
  GRAPH_SENDER_EMAIL: "floorplan@example.com",
  GRAPH_TENANT_ID: "tenant",
};

const json = (response: { jsonBody?: unknown }) => response.jsonBody as Record<string, any>;

const ask = (over: Record<string, unknown> = {}, who = "alana") =>
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
const get = (jobId: number | string = 12, who = "alana") => getJobDecisionRequest(req({ headers: as(who), query: { jobId: String(jobId) } }), context());
const withdraw = (body: Record<string, unknown>, who = "alana") => withdrawJobDecisionRequest(req({ body, headers: as(who) }), context());

/** The request as the screen last read it. */
const pending = async (jobId = 12) => json(await get(jobId)).request as { requestId: number; rowVersion: string };

const respond = async (over: Record<string, unknown> = {}, who = "cam", jobId = 12) => {
  const { requestId, rowVersion } = await pending(jobId);
  return respondToJobDecision(
    req({
      body: { nextStep: "Pay the invoice", outcome: "approve", rationale: "The lighting was ordered twice and the first order was paid.", requestId, rowVersion, ...over },
      headers: as(who),
    }),
    context(),
  );
};
const complete = (body: Record<string, unknown>, who = "alana") => completeJobNextStep(req({ body, headers: as(who) }), context());

/** A sweep at `now`, the real one, with the database's job-facts reads left out (no live job here is stalled). */
const sweep = (now: Date) =>
  runSweep(
    {} as never,
    { dryRun: false, env: MAIL_ENV as unknown as NodeJS.ProcessEnv, log: () => undefined, now, warn: () => undefined },
    { ...defaultSweepDeps, countExhaustedNotifications: async () => 0, latestEmailArrivals: async () => new Map(), loadLiveJobFacts: async () => [] },
  );

const rows = (): EscalationRow[] => [...mockWorld.escalations.values()];
const byPolicy = (policyKey: string): EscalationRow[] => rows().filter((r) => r.policyKey === policyKey);
const actions = (): string[] => mockWorld.ledger.map((e) => e.action);
const mailTo = (address: string) => mockWorld.mail.filter((m) => m.to.includes(address));
const theJob = () => mockWorld.jobs.get(12) as JobRec;

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

  mockWorld.attachments = new Map([[77, 12]]);
  mockWorld.clock = 1;
  mockWorld.decisions = [];
  mockWorld.escalations = new Map();
  mockWorld.events = [];
  mockWorld.jobEvents = [];
  mockWorld.jobs = new Map([[12, job(12, "admin")], [13, job(13, "facilities")]]);
  mockWorld.ledger = [];
  mockWorld.mail = [];
  mockWorld.mailFails = false;
  mockWorld.nextDecisionId = 4;
  mockWorld.nextEscalationId = 100;
  mockWorld.nextRequestId = 7;
  mockWorld.requests = [];
  mockWorld.snapshot = null;
  mockWorld.users = Object.values(PEOPLE).map((p) => ({ email: `${p.name.toLowerCase()}@example.com`, name: p.name, role: p.role, userId: p.id }));

  installDatabase();
  db.createRequestConnection.mockResolvedValue({});
  db.createServiceConnection.mockResolvedValue({});
  db.beginTransaction.mockImplementation(async () => {
    mockWorld.events.push("begin");
    mockWorld.snapshot = {
      decisions: structuredClone(mockWorld.decisions),
      escalations: new Map([...mockWorld.escalations].map(([id, r]) => [id, { ...r }])),
      jobEvents: [...mockWorld.jobEvents],
      jobs: new Map([...mockWorld.jobs].map(([id, j]) => [id, { ...j }])),
      ledger: [...mockWorld.ledger],
      requests: structuredClone(mockWorld.requests),
    };
  });
  db.commitTransaction.mockImplementation(async () => {
    mockWorld.events.push("commit");
    mockWorld.snapshot = null;
  });
  db.rollbackTransaction.mockImplementation(async () => {
    mockWorld.events.push("rollback");
    if (mockWorld.snapshot) {
      mockWorld.decisions = mockWorld.snapshot.decisions;
      mockWorld.escalations = mockWorld.snapshot.escalations;
      mockWorld.jobEvents = mockWorld.snapshot.jobEvents as typeof mockWorld.jobEvents;
      mockWorld.jobs = mockWorld.snapshot.jobs;
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
  send.mockImplementation(async (_egress, to, subject, body) => {
    mockWorld.events.push("send");
    if (mockWorld.mailFails) throw new Error("Graph sendMail failed: 503");
    mockWorld.mail.push({ body, subject, to: Array.isArray(to) ? to : [to] });
  });
  policyOf.mockImplementation(async (_c, key) => POLICIES[key] ?? null);
  rateLimit.mockReturnValue({ allowed: true, remaining: 29, retryAfterMs: 0 } as never);
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

// ── Gates ────────────────────────────────────────────────────────────────────

describe.each([
  ["respondToJobDecision", (headers: Record<string, string>) => respondToJobDecision(req({ body: { outcome: "approve", rationale: "x", requestId: 7, rowVersion: "AAAAAAAAAAc=", nextStep: "x" }, headers }), context())],
  ["completeJobNextStep", (headers: Record<string, string>) => completeJobNextStep(req({ body: { decisionId: 4 }, headers }), context())],
])("%s gate", (_name, call) => {
  it("answers 401 without a token and opens no connection", async () => {
    expect((await call({})).status).toBe(401);
    expect(db.createRequestConnection).not.toHaveBeenCalled();
  });

  it("answers 403 for the baseline user role", async () => {
    expect((await call(as("una"))).status).toBe(403);
  });

  it.each(["fay", "alana", "cam", "dee", "ada"])("lets %s through the role gate", async (key) => {
    const res = await call(as(key));
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  it("closes its connection", async () => {
    await call(as("dee"));
    expect(db.closeConnection).toHaveBeenCalled();
  });
});

describe("a role that cannot be asked at all", () => {
  it("is refused at the gate, and the attempt is ledgered as denied against the job (answering)", async () => {
    await ask();
    const { requestId, rowVersion } = await pending();
    mockWorld.ledger = [];

    const res = await respondToJobDecision(req({ body: { nextStep: "x", outcome: "approve", rationale: "x", requestId, rowVersion }, headers: as("una") }), context());

    expect(res.status).toBe(403);
    expect(mockWorld.ledger).toHaveLength(1);
    expect(mockWorld.ledger[0]).toMatchObject({
      action: "denied",
      actor: { kind: "user", name: "Una", role: "user", userId: 20 },
      before: { attempted: "decision.approve" },
      buildingId: 5,
      jobId: 12,
      ruleApplied: "role_not_permitted",
      subject: { id: 12, type: "job" },
    });
    expect(mockWorld.decisions).toHaveLength(0);
  });

  it("and so is a step finished by one", async () => {
    await ask();
    await respond();
    mockWorld.ledger = [];

    const res = await complete({ decisionId: 4 }, "una");

    expect(res.status).toBe(403);
    expect(mockWorld.ledger.map((e) => e.action)).toEqual(["denied"]);
    expect(mockWorld.ledger[0]).toMatchObject({ before: { attempted: "decision.next_step_done" }, jobId: 12 });
  });

  it("writes nothing when the body names nothing real", async () => {
    const res = await respondToJobDecision(req({ body: { outcome: "approve", requestId: 999 }, headers: as("una") }), context());
    expect(res.status).toBe(403);
    expect(mockWorld.ledger).toHaveLength(0);
  });
});

// ── Who may answer ───────────────────────────────────────────────────────────

describe("who may answer a request", () => {
  it("each person named may: 200, and the ledger says it was one of those named", async () => {
    for (const who of ["cam", "dee"]) {
      mockWorld.requests = [];
      mockWorld.decisions = [];
      mockWorld.escalations = new Map();
      mockWorld.ledger = [];
      await ask();

      const res = await respond({}, who);

      expect(res.status).toBe(200);
      expect(mockWorld.ledger.find((e) => e.action === "decision.approve")).toMatchObject({ actor: { name: PEOPLE[who].name }, ruleApplied: "responder.named" });
    }
  });

  it("a director who was not named may not: 403 with a plain reason, ledgered as denied, and nothing changes", async () => {
    await ask();
    const before = await pending();
    mockWorld.ledger = [];
    mockWorld.mail = [];

    const res = await respond({ outcome: "deny", rationale: "Not my call", nextStep: "Tell them no" }, "eli");

    expect(res.status).toBe(403);
    expect(json(res)).toMatchObject({ code: "not_a_decision_maker", error: "This question was put to Cam, Dee. You weren't asked, so you can't answer it.", reason: "not_named" });
    expect(mockWorld.ledger).toHaveLength(1);
    expect(mockWorld.ledger[0]).toMatchObject({
      action: "denied",
      actor: { kind: "user", name: "Eli", role: "director", userId: 6 },
      before: { assignmentMode: "named", attempted: "decision.deny", requestId: 7, state: "pending", tier: "soon" },
      jobId: 12,
      reason: "This question was put to Cam, Dee. You weren't asked, so you can't answer it.",
      ruleApplied: "not_a_decision_maker",
      subject: { id: 12, type: "job" },
    });
    expect(mockWorld.decisions).toHaveLength(0);
    expect(mockWorld.mail).toHaveLength(0);
    expect(await pending()).toEqual(before);
    expect(byPolicy("job.decision_pending")[0]).toMatchObject({ resolutionCode: null, status: "open" });
    expect(byPolicy("job.next_step")).toHaveLength(0);
    expect(theJob().assignedTo).toBeNull();
  });

  it("an admin who was not named may not either", async () => {
    await ask();
    expect((await respond({}, "ada")).status).toBe(403);
  });

  describe("an admin a request names all the same (it can't be asked now, but an old one may)", () => {
    const namesAda = async () => {
      await ask();
      mockWorld.requests[0].decisionMakers = { role: null, userIds: [PEOPLE.cam.id, PEOPLE.ada.id] };
      mockWorld.ledger = [];
      mockWorld.mail = [];
    };

    it("may not answer on a real job: 403 in plain words, ledgered as denied, and nothing changes", async () => {
      await namesAda();
      const before = await pending();

      const res = await respond({}, "ada");

      expect(res.status).toBe(403);
      expect(json(res)).toMatchObject({
        code: "not_a_decision_maker",
        error: "Admin answers questions on test jobs only. This is a real job, so someone else has to answer it.",
        reason: "admin_test_jobs_only",
      });
      expect(mockWorld.ledger).toHaveLength(1);
      expect(mockWorld.ledger[0]).toMatchObject({
        action: "denied",
        actor: { kind: "user", name: "Ada", role: "admin", userId: 7 },
        before: { attempted: "decision.approve", requestId: 7, state: "pending" },
        jobId: 12,
        ruleApplied: "not_a_decision_maker",
      });
      expect(mockWorld.decisions).toHaveLength(0);
      expect(mockWorld.mail).toHaveLength(0);
      expect(await pending()).toEqual(before);
      expect(byPolicy("job.next_step")).toHaveLength(0);
    });

    it("may answer on a test job, as one of the people named", async () => {
      await namesAda();
      theJob().isTest = true;

      const res = await respond({}, "ada");

      expect(res.status).toBe(200);
      expect(mockWorld.ledger.find((e) => e.action === "decision.approve")).toMatchObject({ actor: { name: "Ada", role: "admin" }, ruleApplied: "responder.named" });
      expect(mockWorld.decisions).toHaveLength(1);
    });

    it("on a test job, the others named still may, and the one not named still may not", async () => {
      await namesAda();
      theJob().isTest = true;
      expect((await respond({}, "eli")).status).toBe(403);
      expect((await respond({}, "cam")).status).toBe(200);
    });
  });

  it("a request put to a role is answered by whoever holds the role now, including someone who joined it since", async () => {
    await ask({ assignmentMode: "role", decisionMakers: { role: "accounts_manager" } });
    // Kirstin is in the role now; pretend she joined after the question was asked.
    mockWorld.requests[0].decisionMakers = { role: "accounts_manager", userIds: [PEOPLE.cam.id] };

    const res = await respond({}, "kirstin");

    expect(res.status).toBe(200);
    expect(mockWorld.ledger.find((e) => e.action === "decision.approve")).toMatchObject({ actor: { name: "Kirstin" }, ruleApplied: "responder.role" });
  });

  it("and not by someone who was in the role when it was asked and has moved on", async () => {
    await ask({ assignmentMode: "role", decisionMakers: { role: "accounts_manager" } });
    expect(mockWorld.requests[0].decisionMakers.userIds).toEqual([PEOPLE.cam.id, PEOPLE.kirstin.id]);
    mockWorld.users.find((u) => u.userId === PEOPLE.kirstin.id)!.role = "facilities";
    const { requestId, rowVersion } = await pending();

    const res = await respondToJobDecision(
      req({ body: { nextStep: "x", outcome: "approve", rationale: "x", requestId, rowVersion }, headers: { ...as("kirstin"), "x-dev-roles": "facilities" } }),
      context(),
    );

    expect(res.status).toBe(403);
    expect(json(res)).toMatchObject({ code: "not_a_decision_maker", reason: "not_in_role" });
  });

  it("the person who asked never answers their own question, even if they hold the role it was put to", async () => {
    await ask({ assignmentMode: "role", decisionMakers: { role: "accounts" } }); // Alana asks accounts: Gus is asked
    const res = await respond({}, "alana");
    expect(res.status).toBe(403);
    expect(json(res)).toMatchObject({ error: "You asked this question, so someone else has to answer it.", reason: "asker" });
    expect(mockWorld.ledger.filter((e) => e.action === "denied")).toHaveLength(1);
  });

  it("a stranger learns nothing from a 409: it is the same 403 whether or not the question was answered", async () => {
    await ask();
    await respond({}, "cam");
    const res = await respondToJobDecision(req({ body: { nextStep: "x", outcome: "approve", rationale: "x", requestId: 7, rowVersion: "AAAAAAAAAAc=" }, headers: as("eli") }), context());
    expect(res.status).toBe(403);
  });
});

// ── The rationale is mandatory ───────────────────────────────────────────────

describe("the rationale", () => {
  it.each([[undefined], [""], ["   "], [null]])("is mandatory on the server: %j is a 400 and nothing is written or opened", async (rationale) => {
    await ask();
    mockWorld.events = [];
    mockWorld.ledger = [];

    const res = await respond({ rationale }, "cam");

    expect(res.status).toBe(400);
    expect(json(res)).toMatchObject({ code: "rationale_required" });
    expect(mockWorld.events).toEqual([]);
    expect(mockWorld.decisions).toHaveLength(0);
    expect(mockWorld.ledger).toHaveLength(0);
  });

  it("is mandatory for a deferral as well", async () => {
    await ask();
    expect((await respond({ deferUntil: "2026-10-23", nextStep: undefined, outcome: "defer", rationale: " " }, "cam")).status).toBe(400);
  });

  it("is the ledger's reason, and the job's history shows it with the outcome and the owner", async () => {
    await ask();
    await respond({ rationale: "The lighting was ordered twice." }, "cam");

    expect(mockWorld.ledger.find((e) => e.action === "decision.approve")?.reason).toBe("The lighting was ordered twice.");
    expect(mockWorld.jobEvents.find((e) => e.eventType === "decision")).toMatchObject({
      createdBy: "Cam",
      text: "Approved by Cam: The lighting was ordered twice.\nNext step for Alana, due 19/10/2026: Pay the invoice",
    });
  });
});

// ── Each outcome's effects ───────────────────────────────────────────────────

describe("approving", () => {
  it("answers 200 with the request answered, the decision, the job and the chase on the step", async () => {
    await ask();
    const res = await respond();

    expect(res.status).toBe(200);
    const body = json(res);
    expect(body.request).toMatchObject({ requestId: 7, state: "answered" });
    expect(body.decision).toMatchObject({
      decisionId: 4,
      deferUntil: null,
      outcome: "approve",
      rationale: "The lighting was ordered twice and the first order was paid.",
      reask: null,
      requestId: 7,
      respondedBy: { name: "Cam", userId: 3 },
    });
    expect(body.decision.nextStep).toMatchObject({
      dueAt: "2026-10-19T07:30:00.000Z",
      isOverdue: false,
      owner: { active: true, name: "Alana", role: null, roleLabel: null, userId: 9 },
      state: "open",
      text: "Pay the invoice",
    });
    expect(body.decision.nextStep.chase).toMatchObject({ dueAt: "2026-10-19T07:30:00.000Z", level: 1, status: "open", targetRole: "accounts", urgent: false });
    expect(body.job).toEqual({ assignedTo: "Alana", assignedToUserId: 9, jobId: 12 });
    expect(body.replaced).toEqual([]);
  });

  it("does all of it in one transaction, in order, and emails only after the commit", async () => {
    await ask();
    mockWorld.events = [];

    await respond();

    expect(mockWorld.events).toEqual([
      "begin",
      "insert decision",
      "mark answered",
      "ledger:decision.approve",
      "job flag",
      "ledger:escalation.resolve",
      "reassign",
      "job event assignment_change",
      "job event decision",
      "job flag",
      "ledger:escalation.raise",
      "commit",
      "send",
      // J6: once the email is on record the job's flag is brought in step again.
      "job flag",
    ]);
    expect(db.rollbackTransaction).not.toHaveBeenCalled();
  });

  it("ends the request's escalation as resolved, with the outcome as its code and the rationale as its note", async () => {
    await ask();
    await respond({}, "dee");

    expect(byPolicy("job.decision_pending")).toHaveLength(1);
    expect(byPolicy("job.decision_pending")[0]).toMatchObject({
      resolutionCode: "approve",
      resolutionNote: "The lighting was ordered twice and the first order was paid.",
      resolvedByName: "Dee",
      resolvedByUserId: 5,
      status: "resolved",
    });
  });

  it("hands the job to the creator by default, and raises a next step for them, due when the tier says, chased through their manager", async () => {
    await ask();
    await respond();

    expect(theJob()).toMatchObject({ assignedTo: "Alana", assignedToUserId: 9 });
    expect(mockWorld.jobEvents.find((e) => e.eventType === "assignment_change")).toMatchObject({ createdBy: "Cam", newAssignee: "Alana", text: "Reassigned to Alana (was —)" });

    const [step] = byPolicy("job.next_step");
    expect(step).toMatchObject({
      dueAt: darwin("2026-10-19", "17:00"),
      kind: "attention",
      level: 1,
      note: "Pay the invoice",
      raisedByName: "Cam",
      raisedByUserId: 3,
      status: "open",
      subjectId: "12",
      subjectType: "job",
      targetRole: "accounts",
      targetUserId: 9,
      urgent: false,
    });
    expect(step.context).toMatchObject({
      ladder: { role: "accounts", userId: 9 },
      nextStep: { decisionId: 4, nextStep: "Pay the invoice", outcome: "approve", ownerUserId: 9, requestId: 7, respondedBy: "Cam" },
      schedule: { escalateAt: "2026-10-19T07:30:00.000Z" },
      userTargets: [9],
    });
  });

  it("ledgers the decision with the rationale as the reason, beside the escalation rows, under one correlation id", async () => {
    await ask();
    mockWorld.ledger = [];

    await respond();

    expect(actions()).toEqual(["decision.approve", "escalation.resolve", "escalation.raise"]);
    const [decision, resolved, raised] = mockWorld.ledger;
    expect(decision).toMatchObject({
      action: "decision.approve",
      actor: { kind: "user", name: "Cam", role: "accounts_manager", userId: 3 },
      buildingId: 5,
      jobId: 12,
      reason: "The lighting was ordered twice and the first order was paid.",
      subject: { id: 12, type: "job" },
    });
    expect(decision.after).toMatchObject({ decisionId: 4, outcome: "approve", requestId: 7 });
    expect(decision.before).toMatchObject({ requestId: 7, state: "pending" });
    expect(resolved).toMatchObject({ action: "escalation.resolve", jobId: 12, subject: { type: "escalation" } });
    expect(raised).toMatchObject({ action: "escalation.raise", jobId: 12 });
    expect(resolved.correlationId).toBe(decision.correlationId);
    expect(raised.correlationId).toBe(decision.correlationId);
  });

  it("emails the owner of the step once, naming what was decided, why, the step, when it is due and a link, and nobody else", async () => {
    await ask({ decisionMakers: { userIds: [PEOPLE.cam.id, PEOPLE.dee.id] } });
    mockWorld.mail = [];

    await respond();

    expect(mockWorld.mail).toHaveLength(1);
    const [mail] = mockWorld.mail;
    expect(mail.to).toEqual(["alana@example.com"]);
    expect(mail.subject).toBe("Next step for you: Job #12 · Superseded lighting invoice · 25 Temira Crescent");
    expect(mail.body).toContain("Cam has decided on a job and handed the next step to you.");
    expect(mail.body).toContain("Decision: Approved by Cam");
    expect(mail.body).toContain("Why: The lighting was ordered twice and the first order was paid.");
    expect(mail.body).toContain("Next step: Pay the invoice");
    expect(mail.body).toContain("Due: 19/10/2026 17:00 Darwin time");
    expect(mail.body).toContain("Open it in Floorplan: https://floorplan.example/jobs?jobId=12");
  });

  it("tells the person who asked in the app only, never by email, when the next step is someone else's", async () => {
    await ask();
    mockWorld.mail = [];

    await respond({ nextStepOwner: { userId: PEOPLE.fay.id } }, "cam");

    expect(mailTo("alana@example.com")).toHaveLength(0);
    expect(mockWorld.mail.map((m) => m.to)).toEqual([["fay@example.com"]]);
    // The asker's outcome is their request's escalation, closed, in the inbox they already look at.
    const mine = byPolicy("job.decision_pending")[0];
    expect(mine).toMatchObject({ raisedByUserId: 9, resolutionCode: "approve", status: "resolved" });
  });

  it("sends the owner's email to DEV_EMAIL_OVERRIDE alone when it is set", async () => {
    await ask();
    mockWorld.mail = [];
    process.env.DEV_EMAIL_OVERRIDE = "dev@example.com";

    await respond();

    expect(mockWorld.mail).toHaveLength(1);
    expect(mockWorld.mail[0].to).toEqual(["dev@example.com"]);
  });

  it("still answers when the email fails, and records the failure for the sweep to retry", async () => {
    await ask();
    mockWorld.mailFails = true;

    const res = await respond();

    expect(res.status).toBe(200);
    expect(json(res).decision.nextStep.chase.notificationState).toBe("failed");
    expect(byPolicy("job.next_step")[0].notificationState).toBe("failed");
    expect(db.rollbackTransaction).not.toHaveBeenCalled();
  });

  it("hands the step to a person named, who then has the job, and not to the creator", async () => {
    await ask();
    const res = await respond({ nextStepOwner: { userId: PEOPLE.fay.id } }, "cam");

    expect(json(res).job).toEqual({ assignedTo: "Fay", assignedToUserId: 8, jobId: 12 });
    expect(byPolicy("job.next_step")[0]).toMatchObject({ targetRole: "facilities", targetUserId: 8 });
  });

  it("hands the step to a whole role, which everyone in it is emailed about, and the job takes the role's label", async () => {
    await ask();
    mockWorld.mail = [];

    const res = await respond({ nextStepOwner: { role: "accounts" } }, "cam");

    expect(res.status).toBe(200);
    expect(json(res).job).toEqual({ assignedTo: "Accounts", assignedToUserId: null, jobId: 12 });
    expect(json(res).decision.nextStep.owner).toMatchObject({ name: null, role: "accounts", roleLabel: "Accounts", userId: null });
    expect(mockWorld.mail[0].to).toEqual(["alana@example.com", "gus@example.com"]);
    expect(byPolicy("job.next_step")[0]).toMatchObject({ targetRole: null, targetUserId: null });
    expect(byPolicy("job.next_step")[0].context).toMatchObject({ userTargets: [9, 10] });
  });

  it("lets a decision-maker take the step themselves, and does not email them about it", async () => {
    await ask();
    mockWorld.mail = [];

    const res = await respond({ nextStepOwner: { userId: PEOPLE.cam.id } }, "cam");

    expect(res.status).toBe(200);
    expect(theJob()).toMatchObject({ assignedTo: "Cam", assignedToUserId: 3 });
    expect(byPolicy("job.next_step")[0]).toMatchObject({ targetUserId: 3, raisedByUserId: 3 });
    expect(mockWorld.mail).toHaveLength(0);
  });

  it("refuses an owner who can't be handed it (422), writing nothing", async () => {
    await ask();
    mockWorld.ledger = [];
    for (const [nextStepOwner, code] of [
      [{ userId: 99 }, "next_step_owner_unknown"],
      [{ userId: PEOPLE.una.id }, "next_step_owner_role_not_allowed"],
      [{ role: "cfo" }, "next_step_owner_role_empty"],
    ] as const) {
      const res = await respond({ nextStepOwner }, "cam");
      expect(res.status).toBe(422);
      expect(json(res).code).toBe(code);
    }
    expect(mockWorld.decisions).toHaveLength(0);
    expect(mockWorld.ledger).toHaveLength(0);
    expect((await pending()).requestId).toBe(7);
  });
});

describe("the urgency of the step follows the request", () => {
  it.each([
    ["soon", {}, darwin("2026-10-19", "17:00"), false],
    ["routine", { routineWeeks: 3 }, darwin("2026-11-02", "17:00"), false],
    ["urgent", { autoEscalate: false }, darwin("2026-10-13", "17:00"), true],
    ["fixed", { fixedDate: "2026-10-23" }, darwin("2026-10-23", "17:00"), false],
    ["emergency", {}, darwin("2026-10-13", "17:00"), true],
  ] as const)("a %s request gives a step due %#", async (tier, extra, due, urgent) => {
    await ask({ tier, ...extra });
    const res = await respond();

    expect(res.status).toBe(200);
    expect(json(res).decision.nextStep.dueAt).toBe(due.toISOString());
    const [step] = byPolicy("job.next_step");
    expect(step.urgent).toBe(urgent);
    expect(step.dueAt).not.toBeNull();
    expect(step.dueAt!.getTime()).toBeGreaterThanOrEqual(due.getTime());
    if (urgent) expect(mockWorld.mail[mockWorld.mail.length - 1].subject).toMatch(/^URGENT next step for you:/);
  });
});

describe("denying", () => {
  it("is the same shape: decision.deny with the rationale as its reason, a step, an owner", async () => {
    await ask();
    const res = await respond({ nextStep: "Tell the contractor we won't pay", outcome: "deny", rationale: "A duplicate of INV-2231" }, "dee");

    expect(res.status).toBe(200);
    expect(json(res).decision).toMatchObject({ outcome: "deny", rationale: "A duplicate of INV-2231" });
    expect(mockWorld.ledger.find((e) => e.action === "decision.deny")).toMatchObject({ reason: "A duplicate of INV-2231" });
    expect(byPolicy("job.decision_pending")[0].resolutionCode).toBe("deny");
    expect(byPolicy("job.next_step")).toHaveLength(1);
    expect(mockWorld.jobEvents.find((e) => e.eventType === "decision")?.text).toMatch(/^Denied by Dee: A duplicate of INV-2231/);
  });
});

describe("asking for revisions", () => {
  it("passes the job back to the person who raised it, with the rationale as the note, and the email says what to change", async () => {
    await ask({}, "fay"); // Fay asks; Alana raised the job
    mockWorld.mail = [];

    const res = await respond({ nextStep: "Correct the ABN and send it again", outcome: "revise", rationale: "The ABN is for a different company" }, "cam");

    expect(res.status).toBe(200);
    expect(json(res).decision).toMatchObject({ outcome: "revise", rationale: "The ABN is for a different company" });
    expect(json(res).decision.nextStep.owner).toMatchObject({ name: "Alana", userId: 9 });
    expect(theJob()).toMatchObject({ assignedTo: "Alana", assignedToUserId: 9 });
    expect(mockWorld.ledger.find((e) => e.action === "decision.revise")).toMatchObject({ reason: "The ABN is for a different company" });
    expect(byPolicy("job.decision_pending")[0]).toMatchObject({ resolutionCode: "revise", resolutionNote: "The ABN is for a different company" });

    expect(mockWorld.mail).toHaveLength(1);
    expect(mockWorld.mail[0].to).toEqual(["alana@example.com"]);
    expect(mockWorld.mail[0].subject).toBe("Revisions requested: Job #12 · Superseded lighting invoice · 25 Temira Crescent");
    expect(mockWorld.mail[0].body).toContain("Cam has asked for changes and passed the job back for the next step.");
    expect(mockWorld.mail[0].body).toContain("Why: The ABN is for a different company");
    expect(mockWorld.mail[0].body).toContain("Next step: Correct the ABN and send it again");
  });

  it("needs the changes spelt out: a revision with no next step is a 400", async () => {
    await ask();
    const res = await respond({ nextStep: undefined, outcome: "revise", rationale: "Wrong ABN" }, "cam");
    expect(res.status).toBe(400);
    expect(json(res).code).toBe("next_step_required");
  });
});

describe("deferring", () => {
  it("with no step: records the day, ends the chase, raises nothing and moves nobody", async () => {
    await ask();
    mockWorld.mail = [];

    const res = await respond({ deferUntil: "2026-10-23", nextStep: undefined, outcome: "defer", rationale: "Wait for the corrected invoice" }, "cam");

    expect(res.status).toBe(200);
    expect(json(res).decision).toMatchObject({ deferUntil: "2026-10-23", nextStep: null, outcome: "defer", reask: { dueDate: "2026-10-23", requestId: null } });
    expect(byPolicy("job.decision_pending")[0]).toMatchObject({ resolutionCode: "defer", status: "resolved" });
    expect(byPolicy("job.next_step")).toHaveLength(0);
    expect(theJob().assignedTo).toBeNull();
    expect(mockWorld.mail).toHaveLength(0);
    expect(mockWorld.ledger.find((e) => e.action === "decision.defer")).toMatchObject({ reason: "Wait for the corrected invoice" });
    expect(mockWorld.jobEvents.find((e) => e.eventType === "decision")?.text).toBe("Deferred by Cam: Wait for the corrected invoice\nThe question comes back on 23/10/2026.");
  });

  it.each([
    ["today", "2026-10-12", "defer_until_past"],
    ["a weekend", "2026-10-17", "defer_until_not_a_working_day"],
    ["more than a year away", "2028-01-03", "defer_until_too_far"],
  ])("refuses %s (422) before it touches anything", async (_label, deferUntil, code) => {
    await ask();
    mockWorld.events = [];

    const res = await respond({ deferUntil, nextStep: undefined, outcome: "defer" }, "cam");

    expect(res.status).toBe(422);
    expect(json(res).code).toBe(code);
    expect(mockWorld.events).toEqual([]);
  });

  it("refuses a public holiday named in ESCALATION_HOLIDAYS", async () => {
    process.env.ESCALATION_HOLIDAYS = "2026-10-14";
    await ask();
    const res = await respond({ deferUntil: "2026-10-14", nextStep: undefined, outcome: "defer" }, "cam");
    expect(res.status).toBe(422);
    expect(json(res).code).toBe("defer_until_not_a_working_day");
  });
});

// ── A deferral comes back, once, on its day ──────────────────────────────────

describe("a deferred question comes back on its day (the sweep)", () => {
  const defer = async (over: Record<string, unknown> = {}) => {
    await ask();
    mockWorld.mail = [];
    const res = await respond({ deferUntil: "2026-10-23", nextStep: undefined, outcome: "defer", rationale: "Wait for the corrected invoice", ...over }, "cam");
    expect(res.status).toBe(200);
  };
  const FRIDAY_OPENS = darwin("2026-10-23", "08:30");

  it("does nothing before the day, and nothing before it opens", async () => {
    await defer();

    const early = await sweep(darwin("2026-10-22", "12:00"));
    const dawn = await sweep(darwin("2026-10-23", "07:00"));

    expect(early.reasked).toBe(0);
    expect(dawn.reasked).toBe(0);
    expect(mockWorld.requests).toHaveLength(1);
    expect(mockWorld.mail).toHaveLength(0);
  });

  it("asks the same people the same question again when the day opens, as a new pending request in the original asker's name", async () => {
    await defer();

    const report = await sweep(FRIDAY_OPENS);

    expect(report.reasked).toBe(1);
    expect(report.errors).toEqual([]);
    expect(mockWorld.requests).toHaveLength(2);
    expect(mockWorld.requests[1]).toMatchObject({
      assignmentMode: "named",
      decisionMakers: { role: null, userIds: [3, 5] },
      jobId: 12,
      question: "Pay the superseded lighting invoice, or go back to the contractor?",
      requestId: 8,
      requestedBy: "Alana",
      requestedByUserId: 9,
      state: "pending",
      tier: "soon",
    });
    expect(mockWorld.decisions[0].reaskRequestId).toBe(8);
    const [chase] = byPolicy("job.decision_pending").filter((r) => r.status === "open");
    expect(chase).toMatchObject({ kind: "authority", raisedByKind: "system", raisedByName: "Floorplan", subjectId: "12", targetRole: null, urgent: false });
    expect(chase.context).toMatchObject({ decision: { reaskOf: { askedBy: "Alana", decisionId: 4, deferredUntil: "2026-10-23" }, requestId: 8 }, ladder: { role: "accounts", userId: 9 }, userTargets: [3, 5] });
    expect(chase.dueAt).toEqual(darwin("2026-10-30", "17:00"));
  });

  it("emails the decision-makers, saying it is due again and who first asked", async () => {
    await defer();

    await sweep(FRIDAY_OPENS);

    expect(mockWorld.mail).toHaveLength(1);
    expect(mockWorld.mail[0].to).toEqual(["cam@example.com", "dee@example.com"]);
    expect(mockWorld.mail[0].subject).toBe("Decision due again: Job #12 · Superseded lighting invoice · 25 Temira Crescent");
    expect(mockWorld.mail[0].body).toContain("A question that was put off until 23/10/2026 is due again. It was first asked by Alana.");
    expect(mockWorld.mail[0].body).toContain("Raised by: Floorplan (automatic)");
  });

  it("ledgers it as the sweep, under decision_request.reask, saying which deferral it follows", async () => {
    await defer();
    mockWorld.ledger = [];

    await sweep(FRIDAY_OPENS);

    const requested = mockWorld.ledger.find((e) => e.action === "decision.requested");
    expect(requested).toMatchObject({ actor: { kind: "system", name: "escalationSweepTimer" }, jobId: 12, ruleApplied: "decision_request.reask", subject: { id: 12, type: "job" } });
    expect(requested?.after).toMatchObject({ reaskOf: { decisionId: 4 }, requestId: 8, state: "pending" });
    expect(mockWorld.ledger.find((e) => e.action === "escalation.raise")?.correlationId).toBe(requested?.correlationId);
  });

  it("asks exactly once however often the sweep runs: the same day, and every day after", async () => {
    await defer();

    const runs = [FRIDAY_OPENS, new Date(FRIDAY_OPENS.getTime() + 30 * 60_000), darwin("2026-10-23", "16:00"), darwin("2026-10-26", "09:00"), darwin("2026-11-03", "09:00")];
    const reasked: number[] = [];
    for (const at of runs) reasked.push((await sweep(at)).reasked);

    expect(reasked).toEqual([1, 0, 0, 0, 0]);
    expect(mockWorld.requests).toHaveLength(2);
    expect(byPolicy("job.decision_pending").filter((r) => r.parentEscalationId === null)).toHaveLength(2);
    expect(mockWorld.ledger.filter((e) => e.action === "decision.requested")).toHaveLength(2);
  });

  it("asks late, once, when the sweep was off on the day", async () => {
    await defer();
    const report = await sweep(darwin("2026-11-02", "10:00"));
    expect(report.reasked).toBe(1);
    expect(mockWorld.requests).toHaveLength(2);
  });

  it("can then be answered like any request, and the chain is readable from the job", async () => {
    await defer();
    await sweep(FRIDAY_OPENS);

    const read = json(await get());
    expect(read.request).toMatchObject({ requestId: 8, state: "pending" });
    expect(read.previousDecision).toMatchObject({ decisionId: 4, outcome: "defer", reask: { dueDate: "2026-10-23", requestId: 8 }, rationale: "Wait for the corrected invoice" });
    expect(read.decision).toBeNull();

    const res = await respond({ rationale: "Corrected invoice received" }, "dee");
    expect(res.status).toBe(200);
    expect(mockWorld.decisions).toHaveLength(2);
    expect(json(res).decision).toMatchObject({ decisionId: 5, outcome: "approve", requestId: 8 });
  });

  it("is not done if someone already asked again by hand: that request stands, and the sweep leaves the job be", async () => {
    await defer();
    await ask({ question: "Pay it now that the corrected invoice is in?" });

    const report = await sweep(FRIDAY_OPENS);

    expect(report.reasked).toBe(0);
    expect(mockWorld.requests).toHaveLength(2);
    expect(mockWorld.decisions[0].reaskRequestId).toBeNull();
  });

  it("is not done for a job that has been closed or archived in the meantime", async () => {
    await defer();
    theJob().status = "Done";
    expect((await sweep(FRIDAY_OPENS)).reasked).toBe(0);
    theJob().status = "New";
    theJob().isArchived = true;
    expect((await sweep(FRIDAY_OPENS)).reasked).toBe(0);
    expect(mockWorld.requests).toHaveLength(1);
  });

  it("is reported, not lost, when nobody it was put to can be asked any more; and goes ahead the moment someone can", async () => {
    await defer();
    const people = mockWorld.users;
    mockWorld.users = people.filter((u) => ![3, 5].includes(u.userId));

    const failed = await sweep(FRIDAY_OPENS);
    expect(failed.reasked).toBe(0);
    expect(failed.errors[0]).toMatch(/^asking job #12 again: Nobody this question was put to can be asked any more/);
    expect(mockWorld.requests).toHaveLength(1);
    expect(mockWorld.ledger.filter((e) => e.action === "decision.requested")).toHaveLength(1);

    mockWorld.users = people;
    expect((await sweep(new Date(FRIDAY_OPENS.getTime() + 30 * 60_000))).reasked).toBe(1);
  });

  it("is not done while job.decision_pending is switched off, and says so", async () => {
    await defer();
    POLICIES["job.decision_pending"].active = false;
    const log = jest.fn();
    try {
      const report = await runSweep(
        {} as never,
        { dryRun: false, env: MAIL_ENV as unknown as NodeJS.ProcessEnv, log, now: FRIDAY_OPENS, warn: () => undefined },
        { ...defaultSweepDeps, countExhaustedNotifications: async () => 0, latestEmailArrivals: async () => new Map(), loadLiveJobFacts: async () => [] },
      );
      expect(report.reasked).toBe(0);
      expect(log).toHaveBeenCalledWith(expect.stringMatching(/deferred decision is due, but job\.decision_pending is switched off/));
    } finally {
      POLICIES["job.decision_pending"].active = true;
    }
  });

  it("in a dry run says what it would ask and asks nothing", async () => {
    await defer();
    const log = jest.fn();

    const report = await runSweep(
      {} as never,
      { dryRun: true, env: MAIL_ENV as unknown as NodeJS.ProcessEnv, log, now: FRIDAY_OPENS, warn: () => undefined },
      { ...defaultSweepDeps, countExhaustedNotifications: async () => 0, latestEmailArrivals: async () => new Map(), loadLiveJobFacts: async () => [] },
    );

    expect(report.reasked).toBe(1);
    expect(mockWorld.requests).toHaveLength(1);
    expect(log).toHaveBeenCalledWith("escalationSweep: would ask job #12 again (decision #4, deferred until 2026-10-23)");
  });
});

// ── Finishing the next step closes the loop ──────────────────────────────────

describe("completing the next step", () => {
  const approved = async () => {
    await ask();
    await respond({}, "cam");
    mockWorld.mail = [];
    mockWorld.ledger = [];
    mockWorld.events = [];
  };

  it("closes the step, ends the chase, ledgers it and finishes the Admin job, as one transaction", async () => {
    await approved();

    const res = await complete({ decisionId: 4, note: "Paid on the 14th" }, "alana");

    expect(res.status).toBe(200);
    expect(json(res)).toMatchObject({ job: { jobId: 12, status: "Done" }, jobClosed: true, jobStaysOpen: null, jobStaysOpenReason: null });
    expect(json(res).decision.nextStep).toMatchObject({ chase: null, closed: { by: "Alana", byUserId: 9, kind: "done", note: "Paid on the 14th" }, state: "done" });
    expect(mockWorld.events).toEqual([
      "begin",
      "close step done",
      "job flag",
      "ledger:escalation.resolve",
      "job event decision",
      "close job",
      "job event status_change",
      "ledger:decision.next_step_done",
      "commit",
    ]);
    expect(theJob().status).toBe("Done");
    expect(byPolicy("job.next_step")[0]).toMatchObject({ resolutionCode: "next_step_done", resolutionNote: "Paid on the 14th", resolvedByName: "Alana", status: "resolved" });
  });

  it("when the transition guard refuses to close the job, the step is still done and the job stays open with the guard's sentence, and nothing is written to the job", async () => {
    await approved();
    // Not internal, so the machine has no direct close for it: the guard says so.
    theJob().isInternal = false;

    const res = await complete({ decisionId: 4, note: "Paid on the 14th" }, "alana");

    expect(res.status).toBe(200);
    expect(json(res)).toMatchObject({
      job: { jobId: 12, status: "New" },
      jobClosed: false,
      jobStaysOpen: "refused",
      jobStaysOpenReason: "A job can't move there from where it is now.",
    });
    expect(json(res).decision.nextStep).toMatchObject({ closed: { kind: "done" }, state: "done" });
    expect(theJob().status).toBe("New");
    expect(mockWorld.events).not.toContain("close job");
    expect(mockWorld.jobEvents.filter((e) => e.eventType === "status_change")).toEqual([]);
    expect(mockWorld.ledger.find((e) => e.action === "decision.next_step_done")?.after).toMatchObject({ jobClosed: false, jobStaysOpen: "refused" });
  });

  it("ledgers decision.next_step_done on the job with the note as the reason, under the chase's correlation id", async () => {
    await approved();
    await complete({ decisionId: 4, note: "Paid on the 14th" }, "alana");

    expect(actions()).toEqual(["escalation.resolve", "decision.next_step_done"]);
    const [resolved, done] = mockWorld.ledger;
    expect(done).toMatchObject({
      action: "decision.next_step_done",
      actor: { name: "Alana", role: "accounts", userId: 9 },
      jobId: 12,
      reason: "Paid on the 14th",
      ruleApplied: "next_step.owner",
      subject: { id: 12, type: "job" },
    });
    expect(done.after).toMatchObject({ doneAs: "owner", jobClosed: true });
    expect(resolved.correlationId).toBe(done.correlationId);
  });

  it("writes it in the job's history: the step done, and the job closed with the same words", async () => {
    await approved();
    await complete({ decisionId: 4, note: "Paid on the 14th" }, "alana");

    expect(mockWorld.jobEvents.filter((e) => e.createdBy === "Alana")).toEqual([
      { createdBy: "Alana", eventType: "decision", jobId: 12, text: "Alana marked the next step done: Pay the invoice\nPaid on the 14th" },
      { createdBy: "Alana", eventType: "status_change", jobId: 12, newAwaitingRole: "facilities", newStatus: "Done", text: "Next step done: Pay the invoice (Paid on the 14th)" },
    ]);
  });

  it("sends no email: the loop is closed in the app", async () => {
    await approved();
    await complete({ decisionId: 4 }, "alana");
    expect(mockWorld.mail).toHaveLength(0);
  });

  it("can be finished by a manager instead of its owner, who is not told off for it", async () => {
    await approved();
    const res = await complete({ decisionId: 4 }, "kirstin");
    expect(res.status).toBe(200);
    expect(mockWorld.ledger.find((e) => e.action === "decision.next_step_done")).toMatchObject({ actor: { name: "Kirstin" }, ruleApplied: "next_step.manager" });
  });

  it("can be finished by anyone in the role it was handed to", async () => {
    await ask();
    await respond({ nextStepOwner: { role: "accounts" } }, "cam");
    const res = await complete({ decisionId: 4 }, "gus");
    expect(res.status).toBe(200);
    expect(mockWorld.ledger.find((e) => e.action === "decision.next_step_done")).toMatchObject({ actor: { name: "Gus" }, ruleApplied: "next_step.role" });
  });

  it("is refused for a colleague who is neither: 403 naming whose it is, ledgered as denied, and nothing changes", async () => {
    await approved();

    const res = await complete({ decisionId: 4 }, "gus");

    expect(res.status).toBe(403);
    expect(json(res)).toMatchObject({ code: "not_next_step_owner", error: "This step was handed to Alana. Only they, or a manager, can mark it done." });
    expect(mockWorld.ledger.map((e) => e.action)).toEqual(["denied"]);
    expect(mockWorld.ledger[0]).toMatchObject({ before: { attempted: "decision.next_step_done", decisionId: 4 }, jobId: 12, ruleApplied: "not_next_step_owner" });
    expect(theJob().status).toBe("New");
    expect(mockWorld.decisions[0].nextStepClosed).toBeNull();
    expect(byPolicy("job.next_step")[0].status).toBe("open");
  });

  it("is a 409 the second time, naming who did it and carrying the decision", async () => {
    await approved();
    await complete({ decisionId: 4 }, "alana");

    const res = await complete({ decisionId: 4 }, "alana");

    expect(res.status).toBe(409);
    expect(json(res)).toMatchObject({ code: "already_done", error: "This step was already marked done by Alana.", decision: { decisionId: 4, nextStep: { state: "done" } } });
  });

  it("is a 404 for a decision that is not there, and a 400 without one", async () => {
    expect((await complete({ decisionId: 99 }, "alana")).status).toBe(404);
    expect((await complete({}, "alana")).status).toBe(400);
  });

  it("takes the version the screen read, and refuses a stale one with a 409", async () => {
    await approved();
    const stale = await complete({ decisionId: 4, rowVersion: "AAAAAAAAAH0=" }, "alana");
    expect(stale.status).toBe(409);
    expect(json(stale).code).toBe("stale");

    const current = json(await get()).decision.rowVersion as string;
    expect((await complete({ decisionId: 4, rowVersion: current }, "alana")).status).toBe(200);
  });

  describe("does not finish the job when it is not finished", () => {
    it("a revision: the person who raised the job asks again", async () => {
      await ask();
      await respond({ nextStep: "Correct the ABN and ask again", outcome: "revise", rationale: "Wrong ABN" }, "cam");

      const res = await complete({ decisionId: 4 }, "alana");

      expect(res.status).toBe(200);
      expect(json(res)).toMatchObject({ job: { jobId: 12, status: "New" }, jobClosed: false, jobStaysOpen: "revise" });
      expect(theJob().status).toBe("New");
      expect(mockWorld.decisions[0].nextStepClosed).toMatchObject({ kind: "done" });
    });

    it("a question waiting for an answer", async () => {
      await ask();
      await respond({}, "cam");
      await ask({ question: "And the freight?" }); // the next question, while the first step is open

      const res = await complete({ decisionId: 4 }, "alana");

      expect(json(res)).toMatchObject({ jobClosed: false, jobStaysOpen: "pending_request" });
      expect(theJob().status).toBe("New");
    });

    it("a deferral still to come back", async () => {
      await ask();
      await respond({ deferUntil: "2026-10-23", nextStep: "Chase the contractor for a corrected invoice", outcome: "defer", rationale: "Wait" }, "cam");

      const res = await complete({ decisionId: 4 }, "alana");

      expect(json(res)).toMatchObject({ jobClosed: false, jobStaysOpen: "deferred" });
      expect(theJob().status).toBe("New");
    });
  });
});

// ── A later decision takes over from an earlier step ─────────────────────────

describe("a later decision replaces the step an earlier one handed on", () => {
  it("closes the old step as replaced, ledgers that, ends its chase, and chases only the new one", async () => {
    await ask({}, "fay");
    await respond({ nextStep: "Correct the ABN and ask again", outcome: "revise", rationale: "Wrong ABN" }, "cam");
    // Alana revises and asks again; the same people answer.
    await ask({ question: "Pay it, now the ABN is right?" }, "alana");
    mockWorld.ledger = [];
    mockWorld.mail = [];

    const res = await respond({ nextStep: "Pay the invoice", outcome: "approve", rationale: "ABN corrected" }, "dee");

    expect(res.status).toBe(200);
    expect(json(res).replaced).toEqual([4]);
    expect(actions()).toEqual(["decision.approve", "escalation.resolve", "decision.next_step_replaced", "escalation.resolve", "escalation.raise"]);
    expect(mockWorld.decisions[0].nextStepClosed).toMatchObject({ byName: "Dee", kind: "replaced", note: "Replaced by the decision of 12/10/2026" });
    const steps = byPolicy("job.next_step");
    expect(steps.map((s) => [s.status, s.resolutionCode])).toEqual([["resolved", "replaced"], ["open", null]]);
    expect(mockWorld.mail.map((m) => m.subject)).toEqual(["Next step for you: Job #12 · Superseded lighting invoice · 25 Temira Crescent"]);
    expect((await complete({ decisionId: 4 }, "alana")).status).toBe(409);
    expect(json(await complete({ decisionId: 4 }, "alana")).code).toBe("step_replaced");
  });
});

// ── Errors on the answer ─────────────────────────────────────────────────────

describe("what cannot be answered", () => {
  it("a request that is not there: 404", async () => {
    const res = await respondToJobDecision(req({ body: { nextStep: "x", outcome: "approve", rationale: "x", requestId: 99, rowVersion: "AAAAAAAAAAc=" }, headers: as("cam") }), context());
    expect(res.status).toBe(404);
  });

  it("a question already answered: 409 not_pending, carrying the request and the answer it got", async () => {
    await ask();
    const { requestId, rowVersion } = await pending();
    await respond({}, "cam");

    const res = await respondToJobDecision(req({ body: { nextStep: "x", outcome: "deny", rationale: "x", requestId, rowVersion }, headers: as("dee") }), context());

    expect(res.status).toBe(409);
    expect(json(res)).toMatchObject({
      code: "not_pending",
      decision: { decisionId: 4, outcome: "approve", respondedBy: { name: "Cam" } },
      error: "This question was already answered.",
      request: { requestId: 7, state: "answered" },
    });
    expect(mockWorld.decisions).toHaveLength(1);
  });

  it("a question taken back: 409 not_pending", async () => {
    await ask();
    const { requestId, rowVersion } = await pending();
    await withdraw({ reason: "Wrong job", requestId }, "alana");

    const res = await respondToJobDecision(req({ body: { nextStep: "x", outcome: "approve", rationale: "x", requestId, rowVersion }, headers: as("cam") }), context());

    expect(res.status).toBe(409);
    expect(json(res)).toMatchObject({ code: "not_pending", error: "This question was already withdrawn." });
  });

  it("an answer to a question that has changed since the screen read it: 409 stale", async () => {
    await ask();
    const res = await respond({ rowVersion: "AAAAAAAAAH0=" }, "cam");
    expect(res.status).toBe(409);
    expect(json(res)).toMatchObject({ code: "stale", request: { requestId: 7 } });
    expect(mockWorld.decisions).toHaveLength(0);
  });

  it("a closed job: 409 job_closed", async () => {
    await ask();
    theJob().status = "Done";
    const res = await respond({}, "cam");
    expect(res.status).toBe(409);
    expect(json(res).code).toBe("job_closed");
  });

  it("a malformed body: 400", async () => {
    await ask();
    expect((await respondToJobDecision(req({ body: [1], headers: as("cam") }), context())).status).toBe(400);
    expect((await respondToJobDecision(req({ body: { requestId: 7 }, headers: as("cam") }), context())).status).toBe(400);
  });

  it("more than 30 a minute from one person: 429", async () => {
    await ask();
    rateLimit.mockReturnValueOnce({ allowed: false, remaining: 0, retryAfterMs: 5000 } as never);
    const res = await respond({}, "cam");
    expect(res.status).toBe(429);
    expect(res.headers).toMatchObject({ "Retry-After": "5" });
  });
});

// ── One transaction ──────────────────────────────────────────────────────────

describe("one transaction", () => {
  /** Everything an answer writes, as it stands: what a rollback must leave exactly as it was. */
  const state = () =>
    JSON.stringify({
      decisions: mockWorld.decisions,
      escalations: [...mockWorld.escalations.values()],
      jobEvents: mockWorld.jobEvents,
      job: mockWorld.jobs.get(12),
      ledger: mockWorld.ledger,
      requests: mockWorld.requests,
    });

  it("rolls everything back and emails no one when the decision's ledger row fails, and the same answer then goes through", async () => {
    await ask();
    const before = state();
    mockWorld.mail = [];
    ledger.mockImplementationOnce(async () => {
      throw new Error("ledger unavailable (injected)");
    });

    const failed = await respond({}, "cam");

    expect(failed.status).toBe(500);
    expect(state()).toBe(before);
    expect(mockWorld.mail).toHaveLength(0);
    expect(db.rollbackTransaction).toHaveBeenCalled();

    const again = await respond({}, "cam");
    expect(again.status).toBe(200);
    expect(mockWorld.decisions).toHaveLength(1);
    expect(mockWorld.mail).toHaveLength(1);
  });

  it.each(["escalation.resolve", "escalation.raise"])("rolls the decision, the request, the job and the history back when the engine's %s ledger row fails", async (failing) => {
    await ask();
    const before = state();
    mockWorld.mail = [];
    ledger.mockImplementation(async (_c, entry) => {
      if (entry.action === failing) throw new Error("ledger unavailable (injected)");
      assertLedgerEntry(entry);
      mockWorld.events.push(`ledger:${entry.action}`);
      mockWorld.ledger.push(entry);
    });

    const failed = await respond({}, "cam");

    expect(failed.status).toBe(500);
    expect(state()).toBe(before);
    expect(mockWorld.mail).toHaveLength(0);
    expect(theJob().assignedTo).toBeNull();
    expect(mockWorld.jobEvents).toEqual([]);
    expect((await pending()).requestId).toBe(7);
  });

  it("rolls the step, its chase and the job back when finishing it fails", async () => {
    await ask();
    await respond({}, "cam");
    const before = state();
    ledger.mockImplementation(async (_c, entry) => {
      if (entry.action === "decision.next_step_done") throw new Error("ledger unavailable (injected)");
      mockWorld.ledger.push(entry);
    });

    const failed = await complete({ decisionId: 4 }, "alana");

    expect(failed.status).toBe(500);
    expect(state()).toBe(before);
    expect(theJob().status).toBe("New");
  });
});

// ── Reading it back ──────────────────────────────────────────────────────────

describe("getJobDecisionRequest", () => {
  it("shows a pending request with no decision yet, and nothing before it", async () => {
    await ask();
    const body = json(await get());
    expect(body.request).toMatchObject({ requestId: 7, state: "pending" });
    expect(body.chase).toMatchObject({ escalationId: 100, status: "open", targetNames: ["Cam", "Dee"] });
    expect(body.decision).toBeNull();
    expect(body.previousDecision).toBeNull();
  });

  it("shows an answered request with the decision, its next step and the chase on it, to everyone who may read the job", async () => {
    await ask();
    await respond({}, "cam");

    for (const who of ["alana", "fay", "gus", "cam", "dee", "ada"]) {
      const res = await get(12, who);
      expect(res.status).toBe(200);
      const body = json(res);
      expect(body.request).toMatchObject({ requestId: 7, state: "answered" });
      expect(body.chase).toBeNull();
      expect(body.decision).toMatchObject({ decisionId: 4, outcome: "approve", requestId: 7, respondedBy: { name: "Cam" } });
      expect(body.decision.nextStep).toMatchObject({ owner: { name: "Alana" }, state: "open", text: "Pay the invoice" });
      expect(body.decision.nextStep.chase).toMatchObject({ level: 1, status: "open", targetRole: "accounts" });
      expect(body.previousDecision).toBeNull();
    }
  });

  it("shows the step overdue and with the owner's manager once the sweep has moved it up", async () => {
    await ask();
    await respond({}, "cam");

    const report = await sweep(darwin("2026-10-19", "17:30"));
    jest.setSystemTime(darwin("2026-10-19", "17:30"));

    expect(report.superseded).toBe(1);
    const step = json(await get()).decision.nextStep;
    expect(step).toMatchObject({ isOverdue: true, state: "open" });
    expect(step.chase).toMatchObject({ level: 2, targetRole: "accounts_manager" });
  });

  it("shows a finished step as done, with who and the note, and no chase", async () => {
    await ask();
    await respond({}, "cam");
    await complete({ decisionId: 4, note: "Paid" }, "alana");

    const body = json(await get());
    expect(body.decision.nextStep).toMatchObject({ chase: null, closed: { by: "Alana", kind: "done", note: "Paid" }, state: "done" });
  });

  it("shows a request that was taken back with no decision", async () => {
    await ask();
    const { requestId } = await pending();
    await withdraw({ reason: "Wrong job", requestId }, "alana");

    const body = json(await get());
    expect(body.request).toMatchObject({ state: "withdrawn" });
    expect(body.decision).toBeNull();
  });

  it("shows, beside a new question, the answer that came before it", async () => {
    await ask();
    await respond({ nextStep: "Correct the ABN", outcome: "revise", rationale: "Wrong ABN" }, "cam");
    await ask({ question: "Pay it now?" });

    const body = json(await get());
    expect(body.request).toMatchObject({ question: "Pay it now?", requestId: 8, state: "pending" });
    expect(body.previousDecision).toMatchObject({ decisionId: 4, outcome: "revise", rationale: "Wrong ABN" });
    expect(body.previousDecision.nextStep).toMatchObject({ state: "open", text: "Correct the ABN" });
  });

  it("tells a job that has never asked nothing, in the new fields too", async () => {
    expect(json(await get(13, "fay"))).toEqual({ chase: null, decision: null, previousDecision: null, request: null });
  });
});

// ── The whole loop ───────────────────────────────────────────────────────────

describe("ask -> respond -> next step -> done", () => {
  it("goes round once and leaves every step with an owner and in the ledger", async () => {
    // 1. Alana asks Cam and Dee.
    expect((await ask()).status).toBe(201);
    expect(mockWorld.mail.map((m) => m.to)).toEqual([["cam@example.com", "dee@example.com"]]);

    // 2. Dee approves, with a rationale, handing the step to Alana (the creator).
    const answered = await respond({ rationale: "Duplicate lighting order: pay the first, void the second." }, "dee");
    expect(answered.status).toBe(200);
    expect(mockWorld.mail.map((m) => m.to)).toEqual([["cam@example.com", "dee@example.com"], ["alana@example.com"]]);
    expect(theJob()).toMatchObject({ assignedTo: "Alana", status: "New" });
    expect(rows().filter((r) => r.status === "open").map((r) => r.policyKey)).toEqual(["job.next_step"]);

    // 3. Alana does it and marks it done: the job is finished.
    const done = await complete({ decisionId: 4, note: "Paid" }, "alana");
    expect(done.status).toBe(200);
    expect(theJob().status).toBe("Done");
    expect(rows().filter((r) => r.status === "open" || r.status === "acknowledged")).toEqual([]);
    expect(mockWorld.mail).toHaveLength(2);

    // Every step is in the ledger.
    expect(actions()).toEqual([
      "escalation.raise",
      "decision.requested",
      "decision.approve",
      "escalation.resolve",
      "escalation.raise",
      "escalation.resolve",
      "decision.next_step_done",
    ]);
    // and the whole of it can be read from the job
    const body = json(await get());
    expect(body.request.state).toBe("answered");
    expect(body.decision.nextStep.state).toBe("done");
  });
});
