/// <reference types="jest" />
import type { AuthorityFacts } from "../approvalAuthority";
import type { EscalationRow } from "../escalation/types";
import "../escalation/adapters";
import { deriveItems, pickLines } from "./items";
import type { DigestFacts, DigestUser, DueJob, OverdueKey, WaitingApproval } from "./types";

// Wednesday 14 Oct 2026, 07:30 Darwin.
const NOW = new Date("2026-10-13T22:00:00Z");
const TODAY_START = new Date("2026-10-13T14:30:00Z"); // 00:00 Darwin on the 14th
const YESTERDAY = new Date("2026-10-12T20:00:00Z");
const TOMORROW = new Date("2026-10-14T20:00:00Z");

const user = (userId: number, role: string, name = `User ${userId}`): DigestUser => ({ email: `${name.toLowerCase().replace(/\s/g, ".")}@x.test`, lastSentOn: null, name, optedOut: false, role, userId });
const USERS = {
  accounts: user(3, "accounts", "Alan Accounts"),
  accountsManager: user(4, "accounts_manager", "Amy Accounts"),
  admin: user(7, "admin", "Ada Admin"),
  cfo: user(5, "cfo", "Cleo Cfo"),
  director: user(6, "director", "Dan Director"),
  facilities: user(1, "facilities", "Fay Field"),
  facilitiesManager: user(2, "facilities_manager", "Mia Manager"),
  plain: user(8, "user", "Uma User"),
};

const authority: AuthorityFacts = {
  directorThreshold: 50_000,
  isResidence: false,
  limits: [
    { limit: 5_000, role: "facilities_manager" },
    { limit: 2_000, role: "accounts" },
    { limit: 10_000, role: "accounts_manager" },
    { limit: 50_000, role: "cfo" },
    { limit: null, role: "director" },
    { limit: 1_000, role: "admin" },
  ],
  residenceApprovers: [],
  residenceDirectorFallback: true,
  today: "2026-10-14",
};
const ctx = { authorityFacts: () => authority, now: NOW };

function escalation(over: Partial<EscalationRow> = {}): EscalationRow {
  return {
    acknowledgedAt: null, acknowledgedByName: null, acknowledgedByUserId: null, buildingId: 1, context: null,
    createdAt: new Date("2026-10-13T01:00:00Z"), dueAt: null, escalationId: 1, kind: "attention",
    lastFollowUpAt: null, lastNotificationAttemptAt: null, lastNotificationError: null, lastNotifiedAt: null,
    level: 1, noIndependentTarget: false, note: null, notificationAttempts: 0, notificationState: "sent",
    parentEscalationId: null, policyKey: "job.stalled_unacknowledged", raisedByKind: "system", raisedByName: "Floorplan",
    raisedByUserId: null, reason: null, resolutionCode: null, resolutionNote: null, resolvedAt: null,
    resolvedByName: null, resolvedByUserId: null, rowVersion: "AAAAAAAAB9A=", status: "open", subjectId: "12",
    subjectType: "job", summary: "Job #12 · Leaking roof · Tower A", targetRole: "facilities_manager", targetUserId: null,
    updatedAt: new Date("2026-10-13T01:00:00Z"), urgent: false,
    ...over,
  };
}

function approval(over: Partial<WaitingApproval> = {}): WaitingApproval {
  return {
    amount: 3_000, buildingId: 1, buildingName: "Tower A", createdAt: new Date("2026-10-12T01:00:00Z"),
    id: 7, jobId: 20, jobKind: "facilities", jobTitle: "Replace pump", status: "pending", subject: "quote", ...over,
  };
}

const dueJob = (over: Partial<DueJob> = {}): DueJob => ({
  assignedToUserId: 1, buildingName: "Tower A", expectedProgressUpdate: TODAY_START, jobId: 30, kind: "facilities", title: "Paint stairwell", ...over,
});

const key = (over: Partial<OverdueKey> = {}): OverdueKey => ({
  batchId: 5, buildingName: "Tower A", expectedReturnAt: new Date("2026-10-11T08:00:00Z"), keyId: 50, keyNumber: "K-014", ...over,
});

function facts(over: Partial<DigestFacts> = {}): DigestFacts {
  return { dueJobs: [], escalations: [], overdueKeys: [], users: Object.values(USERS), waitingApprovals: [], ...over };
}

const lines = (u: DigestUser, f: DigestFacts) => deriveItems(u, f, ctx).map((i) => i.line);
const paths = (u: DigestUser, f: DigestFacts) => deriveItems(u, f, ctx).map((i) => i.path);

describe("nothing needs the person", () => {
  it("gives nobody anything from an empty database", () => {
    for (const u of Object.values(USERS)) expect(deriveItems(u, facts(), ctx)).toEqual([]);
  });
});

describe("escalations targeting them", () => {
  it("reaches everyone at the target role, open ones only", () => {
    const f = facts({ escalations: [escalation(), escalation({ escalationId: 2, status: "acknowledged", subjectId: "13", summary: "taken" })] });
    expect(lines(USERS.facilitiesManager, f)).toEqual(["Job #12 · Leaking roof · Tower A"]);
    expect(paths(USERS.facilitiesManager, f)).toEqual(["/jobs?jobId=12"]);
    expect(deriveItems(USERS.accounts, f, ctx)).toEqual([]);
  });

  it("reaches a named person and nobody else", () => {
    const f = facts({ escalations: [escalation({ targetRole: null, targetUserId: 4 })] });
    expect(deriveItems(USERS.accountsManager, f, ctx)).toHaveLength(1);
    expect(deriveItems(USERS.facilitiesManager, f, ctx)).toHaveLength(0);
  });

  it("does not tell the person who raised it", () => {
    const f = facts({ escalations: [escalation({ raisedByKind: "user", raisedByUserId: 2 })] });
    expect(deriveItems(USERS.facilitiesManager, f, ctx)).toEqual([]);
  });

  it("tells directors and admin when there is no independent target", () => {
    const f = facts({ escalations: [escalation({ noIndependentTarget: true })] });
    expect(deriveItems(USERS.director, f, ctx)).toHaveLength(1);
    expect(deriveItems(USERS.admin, f, ctx)).toHaveLength(1);
    expect(deriveItems(USERS.facilitiesManager, f, ctx)).toHaveLength(0);
  });

  it("marks an urgent one and puts it first", () => {
    const f = facts({
      escalations: [
        escalation({ escalationId: 1, subjectId: "1", summary: "Calm one" }),
        escalation({ escalationId: 2, subjectId: "2", summary: "Flooded basement", urgent: true }),
      ],
    });
    expect(lines(USERS.facilitiesManager, f)).toEqual(["Urgent: Flooded basement", "Calm one"]);
  });

  it("links to the escalations inbox for system health, which has no record of its own", () => {
    const f = facts({ escalations: [escalation({ subjectId: "all", subjectType: "system", summary: "Settings are missing" })] });
    expect(paths(USERS.facilitiesManager, f)).toEqual(["/escalations"]);
  });

  it("links to the record an escalation names, not the inbox (J6)", () => {
    const f = facts({
      escalations: [
        escalation({ escalationId: 1, subjectId: "3", subjectType: "defects_period", summary: "Defects period ends" }),
        escalation({ escalationId: 2, subjectId: "21", subjectType: "service_schedule", summary: "Service overdue" }),
        escalation({ escalationId: 3, subjectId: "req-1", subjectType: "schedule_change", summary: "Rent relief" }),
        escalation({ escalationId: 4, policyKey: "job.invoice_waiting", subjectId: "12", summary: "Invoice waiting" }),
      ],
    });
    expect(paths(USERS.facilitiesManager, f).sort()).toEqual([
      "/jobs?jobId=12&step=invoices",
      "/maintenance?defectsPeriodId=3",
      "/maintenance?scheduleId=21",
      "/tenancy/changes/req-1",
    ]);
  });

  it("opens a decision request on the job's decision, naming it (J6)", () => {
    const context = { decision: { assignmentMode: "role", question: "Repair or replace?", requestId: 77, tier: "routine" } };
    const f = facts({ escalations: [escalation({ context, parentEscalationId: 9, policyKey: "job.decision_pending" })] });
    expect(paths(USERS.facilitiesManager, f)).toEqual(["/jobs?jobId=12&step=decision&decisionRequestId=77#decision"]);
  });

  it("keeps a long summary to one line", () => {
    const f = facts({ escalations: [escalation({ summary: "x".repeat(400) })] });
    expect(lines(USERS.facilitiesManager, f)[0].length).toBeLessThanOrEqual(140);
  });
});

describe("approvals waiting for a role they hold", () => {
  const who = (f: DigestFacts) => Object.entries(USERS).filter(([, u]) => deriveItems(u, f, ctx).length > 0).map(([name]) => name).sort();

  it("a quote within the facilities manager's limit goes to everyone with authority for it, and no one else", () => {
    expect(who(facts({ waitingApprovals: [approval({ amount: 3_000 })] }))).toEqual(["accountsManager", "cfo", "director", "facilitiesManager"]);
  });

  it("a quote over a role's limit does not go to that role", () => {
    // 8,000 is over the facilities manager (5,000) and accounts (2,000), within accounts manager (10,000).
    expect(who(facts({ waitingApprovals: [approval({ amount: 8_000 })] }))).toEqual(["accountsManager", "cfo", "director"]);
  });

  it("a quote above the director threshold goes to the director alone", () => {
    expect(who(facts({ waitingApprovals: [approval({ amount: 60_000 })] }))).toEqual(["director"]);
  });

  it("a quote with no amount goes to the director alone", () => {
    expect(who(facts({ waitingApprovals: [approval({ amount: null })] }))).toEqual(["director"]);
  });

  it("a quote already passed up to the director goes to the director alone, whatever its amount", () => {
    expect(who(facts({ waitingApprovals: [approval({ amount: 100, status: "awaiting_director" })] }))).toEqual(["director"]);
  });

  it("an invoice goes to the roles that approve invoices", () => {
    expect(who(facts({ waitingApprovals: [approval({ amount: 1_500, subject: "invoice" })] }))).toEqual(["accounts", "accountsManager", "cfo", "director"]);
  });

  it("an approved invoice waits for the director only when its amount needs one", () => {
    const needs = approval({ amount: 60_000, status: "approved", subject: "invoice" });
    const small = approval({ amount: 1_500, status: "approved", subject: "invoice" });
    expect(who(facts({ waitingApprovals: [needs] }))).toEqual(["director"]);
    expect(who(facts({ waitingApprovals: [small] }))).toEqual([]);
  });

  it("never asks admin to approve (decision 4), and never asks a plain user", () => {
    const f = facts({ waitingApprovals: [approval({ amount: 100 }), approval({ amount: 100, id: 8, subject: "invoice" })] });
    expect(deriveItems(USERS.admin, f, ctx)).toEqual([]);
    expect(deriveItems(USERS.plain, f, ctx)).toEqual([]);
    expect(deriveItems(USERS.facilities, f, ctx)).toEqual([]);
  });

  it("a junior's quote waiting for a senior reaches those whose limit covers it, and not the junior", () => {
    // 8,000 is over the facilities manager (5,000) and accounts (2,000), within accounts manager (10,000).
    const f = facts({ waitingApprovals: [approval({ amount: 8_000, status: "awaiting_approval" })] });
    expect(who(f)).toEqual(["accountsManager", "cfo", "director"]);
    expect(deriveItems(USERS.facilitiesManager, f, ctx)).toEqual([]);
    expect(deriveItems(USERS.facilities, f, ctx)).toEqual([]);
    expect(lines(USERS.accountsManager, f)).toEqual(["Approve quote: Job #20 · Replace pump · Tower A"]);
  });

  it("a junior's invoice waiting for a senior reaches those whose limit covers it, and not the junior", () => {
    const f = facts({ waitingApprovals: [approval({ amount: 3_000, status: "awaiting_approval", subject: "invoice" })] });
    expect(who(f)).toEqual(["accountsManager", "cfo", "director"]);
    expect(deriveItems(USERS.accounts, f, ctx)).toEqual([]);
    expect(lines(USERS.accountsManager, f)[0]).toMatch(/^Approve invoice: /);
  });

  it("an awaiting_approval submission over the director threshold waits for the director alone", () => {
    for (const subject of ["quote", "invoice"] as const) {
      expect(who(facts({ waitingApprovals: [approval({ amount: 60_000, status: "awaiting_approval", subject })] }))).toEqual(["director"]);
    }
  });

  it("ignores statuses that are not waiting on anyone", () => {
    const f = facts({ waitingApprovals: [approval({ status: "approved" }), approval({ status: "rejected" }), approval({ status: "director_approved", subject: "invoice" })] });
    expect(who(f)).toEqual([]);
  });

  it("says what is waiting without an amount, and links to the job", () => {
    const f = facts({ waitingApprovals: [approval({ amount: 4_840, jobTitle: "Replace pump", jobId: 20 })] });
    const [line] = lines(USERS.facilitiesManager, f);
    expect(line).toBe("Approve quote: Job #20 · Replace pump · Tower A");
    expect(line).not.toMatch(/\d,\d{3}|\$/);
    expect(paths(USERS.facilitiesManager, f)).toEqual(["/jobs?jobId=20&step=quotes&quoteId=7"]);
  });

  it("opens an invoice on the invoices step, naming it (J6)", () => {
    const f = facts({ waitingApprovals: [approval({ amount: 100, id: 8, subject: "invoice" })] });
    expect(paths(USERS.accounts, f)).toEqual(["/jobs?jobId=20&step=invoices&invoiceId=8"]);
  });

  it("says invoice for an invoice", () => {
    const f = facts({ waitingApprovals: [approval({ amount: 100, subject: "invoice" })] });
    expect(lines(USERS.accounts, f)[0]).toMatch(/^Approve invoice: /);
  });

  it("is one line per job even when the job has two quotes waiting", () => {
    const f = facts({ waitingApprovals: [approval({ id: 1 }), approval({ id: 2 })] });
    expect(deriveItems(USERS.facilitiesManager, f, ctx)).toHaveLength(1);
  });
});

describe("items due today or overdue", () => {
  it("goes to the person the job is assigned to", () => {
    const f = facts({ dueJobs: [dueJob()] });
    expect(lines(USERS.facilities, f)).toEqual(["Job #30 · Paint stairwell · Tower A: update due today"]);
    expect(paths(USERS.facilities, f)).toEqual(["/jobs?jobId=30"]);
    expect(deriveItems(USERS.facilitiesManager, f, ctx)).toEqual([]);
  });

  it("says how late an overdue one is, by the Darwin calendar", () => {
    const f = facts({ dueJobs: [dueJob({ expectedProgressUpdate: YESTERDAY })] });
    expect(lines(USERS.facilities, f)[0]).toBe("Job #30 · Paint stairwell · Tower A: update was due 13/10/2026");
  });

  it("treats 23:59 Darwin today as still due today, not overdue", () => {
    const lastMinute = new Date("2026-10-14T14:29:00Z"); // 23:59 Darwin on the 14th
    expect(lines(USERS.facilities, facts({ dueJobs: [dueJob({ expectedProgressUpdate: lastMinute })] }))[0]).toMatch(/due today$/);
  });

  it("leaves out a job whose date is tomorrow or later", () => {
    expect(deriveItems(USERS.facilities, facts({ dueJobs: [dueJob({ expectedProgressUpdate: TOMORROW })] }), ctx)).toEqual([]);
  });

  it("leaves out the building when a job has none", () => {
    expect(lines(USERS.facilities, facts({ dueJobs: [dueJob({ buildingName: null })] }))[0]).toBe("Job #30 · Paint stairwell: update due today");
  });

  it("puts the most overdue first", () => {
    const f = facts({ dueJobs: [dueJob({ jobId: 1, expectedProgressUpdate: TODAY_START }), dueJob({ jobId: 2, expectedProgressUpdate: YESTERDAY })] });
    expect(paths(USERS.facilities, f)).toEqual(["/jobs?jobId=2", "/jobs?jobId=1"]);
  });
});

describe("Admin / Accounts jobs are not on the contractor and money lines (plan D2)", () => {
  const everyone = Object.values(USERS);
  const quote = (jobKind: string) => approval({ amount: 100, jobKind });
  const invoice = (jobKind: string) => approval({ amount: 100, id: 8, jobKind, subject: "invoice" });

  it("leaves their quotes and invoices out of every digest, where the same facts on a facilities job reach people", () => {
    const control = facts({ waitingApprovals: [quote("facilities"), invoice("facilities")] });
    expect(deriveItems(USERS.facilitiesManager, control, ctx)).toHaveLength(1);
    expect(deriveItems(USERS.accounts, control, ctx)).toHaveLength(1);

    const admin = facts({ waitingApprovals: [quote("admin"), invoice("admin")] });
    for (const u of everyone) expect(deriveItems(u, admin, ctx)).toEqual([]);
  });

  it("leaves their update-due lines out, where the same job on the facilities side is listed", () => {
    expect(lines(USERS.facilities, facts({ dueJobs: [dueJob({ kind: "facilities" })] }))).toHaveLength(1);
    expect(deriveItems(USERS.facilities, facts({ dueJobs: [dueJob({ kind: "admin" })] }), ctx)).toEqual([]);
  });

  it("keeps listing the facilities and maintenance work around them", () => {
    const f = facts({
      dueJobs: [dueJob({ jobId: 31, kind: "admin" }), dueJob({ jobId: 32, kind: "maintenance" })],
      waitingApprovals: [approval({ id: 1, jobId: 21, jobKind: "admin" }), approval({ id: 2, jobId: 22, jobKind: "maintenance" })],
    });
    expect(paths(USERS.facilitiesManager, f)).toEqual(["/jobs?jobId=22&step=quotes&quoteId=2"]);
    expect(paths(USERS.facilities, f)).toEqual(["/jobs?jobId=32"]);
  });

  it("selects the kinds by name, so a kind nobody has listed gets no lines either", () => {
    const f = facts({ dueJobs: [dueJob({ kind: "projects" })], waitingApprovals: [approval({ jobKind: "projects" })] });
    for (const u of everyone) expect(deriveItems(u, f, ctx)).toEqual([]);
  });
});

describe("keys overdue, for facilities roles", () => {
  it("goes to facilities and facilities managers, and to no one else", () => {
    const f = facts({ overdueKeys: [key()] });
    expect(deriveItems(USERS.facilities, f, ctx)).toHaveLength(1);
    expect(deriveItems(USERS.facilitiesManager, f, ctx)).toHaveLength(1);
    for (const u of [USERS.accounts, USERS.accountsManager, USERS.cfo, USERS.director, USERS.admin, USERS.plain]) {
      expect(deriveItems(u, f, ctx)).toEqual([]);
    }
  });

  it("is one line for a key and links to it", () => {
    const f = facts({ overdueKeys: [key()] });
    expect(lines(USERS.facilities, f)).toEqual(["Key K-014 at Tower A was due back 11/10/2026"]);
    expect(paths(USERS.facilities, f)).toEqual(["/keys/50"]);
  });

  it("is one line per checkout, however many keys were taken together", () => {
    const f = facts({ overdueKeys: [key({ keyId: 50, keyNumber: "K-014" }), key({ keyId: 51, keyNumber: "K-015" }), key({ keyId: 52, keyNumber: "K-016" })] });
    expect(lines(USERS.facilities, f)).toEqual(["Keys K-014 and 2 more at Tower A were due back 11/10/2026"]);
    expect(paths(USERS.facilities, f)).toEqual(["/keys/50"]);
  });

  it("is a separate line for a separate checkout", () => {
    const f = facts({ overdueKeys: [key(), key({ batchId: 6, keyId: 60, keyNumber: "K-020" })] });
    expect(deriveItems(USERS.facilities, f, ctx)).toHaveLength(2);
  });

  it("leaves out the building when a key has none", () => {
    expect(lines(USERS.facilities, facts({ overdueKeys: [key({ buildingName: null })] }))[0]).toBe("Key K-014 was due back 11/10/2026");
  });
});

describe("order, duplicates and the cap", () => {
  it("lists escalations, then approvals, then keys, then due items", () => {
    const f = facts({
      dueJobs: [dueJob({ assignedToUserId: 2 })],
      escalations: [escalation({ subjectId: "40", summary: "Escalated job" })],
      overdueKeys: [key()],
      waitingApprovals: [approval()],
    });
    expect(deriveItems(USERS.facilitiesManager, f, ctx).map((i) => i.kind)).toEqual(["escalation", "approval", "key", "due"]);
  });

  it("shows a job once when it is escalated, awaiting approval and due all at once, as the escalation", () => {
    const f = facts({
      dueJobs: [dueJob({ assignedToUserId: 2, jobId: 12 })],
      escalations: [escalation({ subjectId: "12" })],
      waitingApprovals: [approval({ jobId: 12 })],
    });
    const items = deriveItems(USERS.facilitiesManager, f, ctx);
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("escalation");
  });

  it("keeps the approval when the job is also due", () => {
    const f = facts({ dueJobs: [dueJob({ assignedToUserId: 2, jobId: 20 })], waitingApprovals: [approval({ jobId: 20 })] });
    expect(deriveItems(USERS.facilitiesManager, f, ctx).map((i) => i.kind)).toEqual(["approval"]);
  });

  it("shows at most five lines and counts the rest", () => {
    const items = deriveItems(USERS.facilities, facts({ dueJobs: Array.from({ length: 8 }, (_, i) => dueJob({ jobId: i + 1 })) }), ctx);
    expect(items).toHaveLength(8);
    const picked = pickLines(items, 5);
    expect(picked.shown).toHaveLength(5);
    expect(picked.more).toBe(3);
    expect(pickLines(items.slice(0, 5), 5).more).toBe(0);
    expect(pickLines([], 5)).toEqual({ more: 0, shown: [] });
  });
});
