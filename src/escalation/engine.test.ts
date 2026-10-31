/// <reference types="jest" />
// The engine against an in-memory stand-in for the database: the real engine,
// ladder and policies logic, with the store, the ledger, the notifier and the
// transaction calls replaced. The stand-in enforces the same unique index on live
// escalations and rolls back on rollbackTransaction, so these tests prove "no
// ledger row, no decision" and the order of writes, not just the calls made.
import type { Connection } from "tedious";
import { record, type LedgerActor } from "../ledger";
import { registerAdapter, unregisterAdapter, type EscalationAdapter } from "./adapters/registry";
import {
  acknowledge,
  autoResolve,
  concludeForSubject,
  escalateFurther,
  hasNextLevel,
  previewNextLevel,
  previewTarget,
  raise,
  raiseWithin,
  resolve,
  resolveWithin,
  SWEEP_ACTOR,
  withdraw,
  withdrawWithin,
} from "./engine";
import { jobConditionActive, type JobFacts } from "./adapters/jobRules";
import { NO_HOLIDAYS } from "./businessTime";
import { EscalationError } from "./errors";
import { notifyPreviousLevel, notifyRaiserResolved, notifyTargets } from "./notifier";
import { getPolicy } from "./policies";
import { defaultSweepDeps, runSweep } from "./sweep";
import type { DirectoryUser, EscalationPolicy, EscalationRow } from "./types";

jest.mock("../db", () => ({
  beginTransaction: jest.fn(),
  commitTransaction: jest.fn(),
  executeQuery: jest.fn(),
  rollbackTransaction: jest.fn(),
}));
jest.mock("../ledger");
jest.mock("./notifier");
jest.mock("./policies");

// ── The in-memory database ───────────────────────────────────────────────────

const mockWorld = {
  clock: 1,
  hideLiveOnce: false,
  insertError: null as Error | null,
  nextId: 100,
  rows: new Map<number, EscalationRow>(),
  snapshot: null as Map<number, EscalationRow> | null,
  users: [] as DirectoryUser[],
};

jest.mock("./store", () => {
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
  const live = (row: EscalationRow) => row.status === "open" || row.status === "acknowledged";
  const version = () => Buffer.from(String(mockWorld.clock++).padStart(8, "0")).toString("base64");
  return {
    findLiveEscalation: jest.fn(async (_c: unknown, type: string, id: string, policy: string) => {
      if (mockWorld.hideLiveOnce) {
        mockWorld.hideLiveOnce = false;
        return null;
      }
      const found = [...mockWorld.rows.values()].find((r) => r.subjectType === type && r.subjectId === id && r.policyKey === policy && live(r));
      return found ? { ...found } : null;
    }),
    getEscalationRow: jest.fn(async (_c: unknown, id: number) => {
      const row = mockWorld.rows.get(id);
      return row ? { ...row } : null;
    }),
    insertEscalation: jest.fn(async (_c: unknown, values: Record<string, unknown>) => {
      if (mockWorld.insertError) throw mockWorld.insertError;
      const duplicate = [...mockWorld.rows.values()].some(
        (r) => r.subjectType === values.subjectType && r.subjectId === values.subjectId && r.policyKey === values.policyKey && live(r),
      );
      if (duplicate) throw Object.assign(new Error("Cannot insert duplicate key row (unique index UX_Escalations_Live)"), { number: 2601 });
      const id = mockWorld.nextId++;
      const now = new Date("2026-10-12T00:00:00Z");
      mockWorld.rows.set(id, {
        acknowledgedAt: null,
        acknowledgedByName: null,
        acknowledgedByUserId: null,
        buildingId: null,
        context: null,
        createdAt: now,
        dueAt: null,
        escalationId: id,
        kind: "attention",
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
    latestKey: (subjectId: string, policyKey: string) => `${subjectId}\u0000${policyKey}`,
    latestTimesBySubject: jest.fn(async (_c: unknown, type: string) => {
      const map = new Map<string, { lastCreatedAt: Date; lastEndedAt: Date | null }>();
      for (const r of mockWorld.rows.values()) {
        if (r.subjectType !== type) continue;
        const key = `${r.subjectId}\u0000${r.policyKey}`;
        const prev = map.get(key);
        map.set(key, {
          lastCreatedAt: !prev || r.createdAt > prev.lastCreatedAt ? r.createdAt : prev.lastCreatedAt,
          lastEndedAt: r.resolvedAt && (!prev?.lastEndedAt || r.resolvedAt > prev.lastEndedAt) ? r.resolvedAt : (prev?.lastEndedAt ?? null),
        });
      }
      return map;
    }),
    listActiveUsers: jest.fn(async () => mockWorld.users.map((u) => ({ ...u }))),
    listLiveEscalations: jest.fn(async () => [...mockWorld.rows.values()].filter(live).map((r) => ({ ...r }))),
    listLiveForSubject: jest.fn(async (_c: unknown, type: string, id: string) =>
      [...mockWorld.rows.values()].filter((r) => r.subjectType === type && r.subjectId === id && live(r)).map((r) => ({ ...r })),
    ),
    updateEscalation: jest.fn(async (_c: unknown, id: number, expected: string, changes: Record<string, unknown>) => {
      const row = mockWorld.rows.get(id);
      if (!row || row.rowVersion !== expected) return false;
      const next: Record<string, unknown> = { ...row };
      for (const [column, value] of Object.entries(changes)) next[COLUMN_TO_FIELD[column]] = value;
      next.rowVersion = version();
      mockWorld.rows.set(id, next as unknown as EscalationRow);
      return true;
    }),
  };
});

const db = require("../db") as { beginTransaction: jest.Mock; commitTransaction: jest.Mock; rollbackTransaction: jest.Mock };
const ledger = jest.mocked(record);
const getPolicyMock = jest.mocked(getPolicy);

// ── Fixtures ─────────────────────────────────────────────────────────────────

const conn = {} as Connection;
// Monday 2026-10-12, 09:00 Darwin
const NOW = new Date(Date.UTC(2026, 9, 12, 9, 0) - 9.5 * 3_600_000);

const user = (userId: number, name: string, role: string): DirectoryUser => ({ email: `${name.toLowerCase()}@example.com`, name, role, userId });
const ADAM = user(1, "Adam", "facilities_manager");
const BEA = user(2, "Bea", "facilities_manager");
const CAM = user(3, "Cam", "accounts_manager");
const DEE = user(5, "Dee", "director");
const FAY = user(8, "Fay", "facilities");

const actorOf = (u: DirectoryUser): LedgerActor => ({ kind: "user", name: u.name, role: u.role, userId: u.userId });

const policy = (over: Partial<EscalationPolicy> & Pick<EscalationPolicy, "policyKey" | "ladder">): EscalationPolicy => ({
  active: true,
  autoReescalate: "yes",
  clock: "business",
  kind: "attention",
  updatedAt: null,
  updatedBy: null,
  urgent: false,
  ...over,
});

const POLICIES: Record<string, EscalationPolicy> = {
  "job.critical": policy({
    clock: "wall",
    ladder: [{ role: "facilities_manager", slaHours: 2 }, { role: "director", slaHours: 4 }],
    policyKey: "job.critical",
    urgent: true,
  }),
  "job.decision_pending": policy({
    kind: "authority",
    ladder: [{ userTarget: true }, { token: "raiser_manager", slaHours: 16 }, { role: "director" }],
    policyKey: "job.decision_pending",
  }),
  "job.manual": policy({ ladder: [{ token: "raiser_manager", slaHours: 8 }, { role: "director", slaHours: 16 }], policyKey: "job.manual" }),
  "job.next_step": policy({
    ladder: [{ userTarget: true }, { token: "raiser_manager", slaHours: 16 }, { role: "director" }],
    policyKey: "job.next_step",
  }),
  "job.stalled_unacknowledged": policy({
    ladder: [{ role: "facilities_manager", slaHours: 16 }, { role: "director", slaHours: 16 }],
    policyKey: "job.stalled_unacknowledged",
  }),
  "off.policy": policy({ active: false, ladder: [{ role: "director" }], policyKey: "off.policy" }),
  "quote.over_limit": policy({
    kind: "authority",
    ladder: [{ role: "accounts_manager", slaHours: 16 }, { role: "director", slaHours: 16 }],
    policyKey: "quote.over_limit",
  }),
};

const defaultSummary = async (_c: unknown, id: string) => (id === "404" ? null : { buildingId: 5, context: { title: "Leaking roof" }, summary: "Job #12 · Leaking roof" });

const jobAdapter = {
  deepLink: jest.fn((id: string) => `/jobs?jobId=${id}`),
  isConditionActive: jest.fn(async () => true),
  ledgerScope: jest.fn((e: { subjectId: string }) => ({ jobId: Number(e.subjectId) })),
  loadSummary: jest.fn(defaultSummary),
  onChange: jest.fn(async () => undefined),
  subjectType: "job",
  visibleTo: jest.fn(() => true),
};
const quoteAdapter = { ...jobAdapter, deepLink: jest.fn((id: string) => `/quotes/${id}`), ledgerScope: undefined, onChange: undefined, subjectType: "quote" };

const events: string[] = [];

beforeEach(() => {
  jest.clearAllMocks();
  events.length = 0;
  mockWorld.rows.clear();
  mockWorld.users = [ADAM, BEA, CAM, DEE, FAY];
  mockWorld.nextId = 100;
  mockWorld.clock = 1;
  mockWorld.hideLiveOnce = false;
  mockWorld.insertError = null;
  mockWorld.snapshot = null;
  jobAdapter.isConditionActive.mockResolvedValue(true);
  // clearAllMocks keeps implementations; a describe that swaps this one (the sweep's, startAtRole's)
  // must not leak it into the tests after it.
  jobAdapter.loadSummary.mockImplementation(defaultSummary);
  jobAdapter.onChange.mockImplementation(async () => {
    events.push("onChange");
  });
  registerAdapter(jobAdapter as unknown as EscalationAdapter);
  registerAdapter(quoteAdapter as unknown as EscalationAdapter);
  getPolicyMock.mockImplementation(async (_c, key) => POLICIES[key] ?? null);
  db.beginTransaction.mockImplementation(async () => {
    events.push("begin");
    mockWorld.snapshot = new Map([...mockWorld.rows].map(([id, r]) => [id, { ...r }]));
  });
  db.commitTransaction.mockImplementation(async () => {
    events.push("commit");
    mockWorld.snapshot = null;
  });
  db.rollbackTransaction.mockImplementation(async () => {
    events.push("rollback");
    if (mockWorld.snapshot) mockWorld.rows = new Map(mockWorld.snapshot);
    mockWorld.snapshot = null;
  });
  ledger.mockImplementation(async () => {
    events.push("ledger");
  });
  jest.mocked(notifyTargets).mockImplementation((async () => {
    events.push("notify");
  }) as never);
  jest.mocked(notifyPreviousLevel).mockImplementation((async () => {
    events.push("notifyPrevious");
  }) as never);
  jest.mocked(notifyRaiserResolved).mockImplementation((async () => {
    events.push("notifyRaiser");
  }) as never);
});

afterAll(() => {
  unregisterAdapter("job");
  unregisterAdapter("quote");
});

const raiseManual = (over: Partial<Parameters<typeof raise>[1]> = {}) =>
  raise(conn, { actor: actorOf(FAY), note: "Tenant is chasing", now: NOW, policyKey: "job.manual", reason: "stalled", subjectId: "12", subjectType: "job", ...over });

const rowOf = (id: number): EscalationRow => mockWorld.rows.get(id) as EscalationRow;
const ledgerCalls = () => ledger.mock.calls.map(([, entry]) => entry);

// ── raise ────────────────────────────────────────────────────────────────────

describe("raise", () => {
  it("writes the escalation, lets the subject keep its flags in step and writes the ledger row in one transaction, then notifies", async () => {
    const result = await raiseManual();

    expect(result.created).toBe(true);
    expect(events).toEqual(["begin", "onChange", "ledger", "commit", "notify"]);
    expect(events.indexOf("ledger")).toBeLessThan(events.indexOf("commit"));
    expect(events.indexOf("notify")).toBeGreaterThan(events.indexOf("commit"));
  });

  it("targets the raiser's manager role, starts the SLA clock and links the subject", async () => {
    const { escalation } = await raiseManual();

    expect(escalation).toMatchObject({
      buildingId: 5,
      kind: "attention",
      level: 1,
      noIndependentTarget: false,
      note: "Tenant is chasing",
      notificationState: "pending",
      parentEscalationId: null,
      policyKey: "job.manual",
      raisedByKind: "user",
      raisedByName: "Fay",
      raisedByUserId: 8,
      reason: "stalled",
      status: "open",
      subjectId: "12",
      subjectType: "job",
      summary: "Job #12 · Leaking roof",
      targetRole: "facilities_manager",
      targetUserId: null,
      urgent: false,
    });
    // 8 business hours from Monday 09:00 Darwin is Tuesday 09:00 Darwin = 23:30Z (30 minutes are left on Monday)
    expect(escalation.dueAt?.toISOString()).toBe("2026-10-12T23:30:00.000Z");
    expect(escalation.context).toEqual({ title: "Leaking roof" });
  });

  it("writes a ledger row in the same transaction, scoped to the job", async () => {
    const { escalation } = await raiseManual();

    expect(ledger).toHaveBeenCalledTimes(1);
    const entry = ledgerCalls()[0];
    expect(entry).toMatchObject({
      action: "escalation.raise",
      actor: { kind: "user", name: "Fay", role: "facilities", userId: 8 },
      buildingId: 5,
      jobId: 12,
      reason: "Tenant is chasing",
      ruleApplied: "job.manual",
      subject: { id: escalation.escalationId, type: "escalation" },
    });
    expect(entry?.after).toMatchObject({ level: 1, policyKey: "job.manual", status: "open", targetRole: "facilities_manager" });
    expect(ledger.mock.calls[0][0]).toBe(conn);
  });

  it("never targets the raiser: a lone facilities manager's escalation goes up to the directors", async () => {
    mockWorld.users = [ADAM, DEE];
    const { escalation } = await raiseManual({ actor: actorOf(ADAM) });

    // raiser_manager of a facilities manager is the CFO; none exists, so the director level
    expect(escalation).toMatchObject({ level: 2, targetRole: "director" });
    expect(ledgerCalls()[0]?.computed).toMatchObject({ skippedLevels: [1] });
  });

  it("flags an escalation raised by the only director: directors and admin can see that nobody independent has it", async () => {
    mockWorld.users = [DEE, FAY];
    const { escalation } = await raiseManual({ actor: actorOf(DEE) });

    expect(escalation).toMatchObject({ noIndependentTarget: true, targetRole: "director" });
    const entry = ledgerCalls()[0];
    expect(entry?.computed).toMatchObject({ noIndependentTarget: true, targetRole: "director" });
    expect(entry?.ruleApplied).toBe("no_independent_target");
  });

  it("sets the target user when the raiser picks a person at that level (rule 4)", async () => {
    const { escalation } = await raiseManual({ preferredUserId: BEA.userId });
    expect(escalation.targetUserId).toBe(BEA.userId);
  });

  it("refuses a person who isn't at that level", async () => {
    await expect(raiseManual({ preferredUserId: DEE.userId })).rejects.toMatchObject({ code: "target_not_eligible", status: 422 });
    expect(mockWorld.rows.size).toBe(0);
    expect(ledger).not.toHaveBeenCalled();
  });

  it("runs the urgent wall-clock policy: job.critical is urgent, due in 2 wall hours", async () => {
    const { escalation } = await raise(conn, {
      actor: actorOf(FAY),
      headline: "Marked Critical by Fay",
      now: NOW,
      policyKey: "job.critical",
      subjectId: "12",
      subjectType: "job",
    });

    expect(escalation).toMatchObject({ targetRole: "facilities_manager", urgent: true });
    expect(escalation.dueAt?.toISOString()).toBe(new Date(NOW.getTime() + 2 * 3_600_000).toISOString());
    expect(escalation.summary).toBe("Job #12 · Leaking roof — Marked Critical by Fay");
  });

  it("returns the live escalation instead of raising the same thing twice", async () => {
    const first = await raiseManual();
    events.length = 0;
    ledger.mockClear();

    const second = await raiseManual({ actor: actorOf(user(9, "Gus", "accounts")) });

    expect(second.created).toBe(false);
    expect(second.escalation.escalationId).toBe(first.escalation.escalationId);
    expect(mockWorld.rows.size).toBe(1);
    expect(ledger).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it("copes with another request winning the race for the same subject and policy", async () => {
    const existing = await raiseManual();
    mockWorld.hideLiveOnce = true; // our pre-check misses it; the unique index doesn't

    const raced = await raiseManual();

    expect(raced).toMatchObject({ created: false });
    expect(raced.escalation.escalationId).toBe(existing.escalation.escalationId);
    expect(events.slice(-2)).not.toContain("ledger");
  });

  it("rolls the escalation back, notifies no one and rethrows when the ledger write fails", async () => {
    ledger.mockRejectedValueOnce(new Error("ledger unavailable"));

    await expect(raiseManual()).rejects.toThrow("ledger unavailable");

    expect(events).toEqual(["begin", "onChange", "rollback"]);
    expect(db.commitTransaction).not.toHaveBeenCalled();
    expect(mockWorld.rows.size).toBe(0); // no ledger row, no escalation
    expect(notifyTargets).not.toHaveBeenCalled();
  });

  it("rolls back and rethrows an unrelated insert failure", async () => {
    mockWorld.insertError = new Error("deadlock victim");
    await expect(raiseManual()).rejects.toThrow("deadlock victim");
    expect(events).toEqual(["begin", "rollback"]);
  });

  it("refuses an unknown or switched-off policy, an unknown subject type and a missing subject", async () => {
    await expect(raiseManual({ policyKey: "nope" })).rejects.toMatchObject({ code: "unknown_policy" });
    await expect(raiseManual({ policyKey: "off.policy" })).rejects.toMatchObject({ code: "policy_inactive" });
    await expect(raiseManual({ subjectType: "mystery" })).rejects.toMatchObject({ code: "unknown_subject_type" });
    await expect(raiseManual({ subjectId: "404" })).rejects.toMatchObject({ code: "subject_not_found", status: 404 });
    expect(db.beginTransaction).not.toHaveBeenCalled();
  });

  it("won't escalate something whose condition has already cleared, unless the caller just checked", async () => {
    jobAdapter.isConditionActive.mockResolvedValue(false);

    await expect(raiseManual()).rejects.toMatchObject({ code: "condition_not_met", status: 422 });
    expect(mockWorld.rows.size).toBe(0);

    const forced = await raiseManual({ skipConditionCheck: true });
    expect(forced.created).toBe(true);
  });

  it("doesn't ask an authority escalation whether its condition holds", async () => {
    jobAdapter.isConditionActive.mockResolvedValue(false);
    quoteAdapter.isConditionActive.mockResolvedValue(false);
    const { escalation } = await raise(conn, {
      actor: SWEEP_ACTOR,
      now: NOW,
      policyKey: "quote.over_limit",
      subjectId: "7",
      subjectType: "quote",
    });
    expect(escalation).toMatchObject({ kind: "authority", targetRole: "accounts_manager" });
  });

  it("leaves out the subject's preparer from an authority escalation, and remembers who", async () => {
    const { escalation } = await raise(conn, {
      actor: SWEEP_ACTOR,
      excludeUserIds: [CAM.userId],
      now: NOW,
      policyKey: "quote.over_limit",
      subjectId: "7",
      subjectType: "quote",
    });

    expect(escalation).toMatchObject({ level: 2, targetRole: "director" });
    expect(escalation.context).toMatchObject({ excludeUserIds: [3] });
  });

  it("records a system raise as Floorplan", async () => {
    const { escalation } = await raise(conn, {
      actor: SWEEP_ACTOR,
      headline: "Needs an owner: no one is assigned",
      now: NOW,
      policyKey: "job.stalled_unacknowledged",
      skipConditionCheck: true,
      subjectId: "12",
      subjectType: "job",
    });

    expect(escalation).toMatchObject({ raisedByKind: "system", raisedByName: "Floorplan", raisedByUserId: null });
    expect(ledgerCalls()[0]?.actor).toEqual({ kind: "system", name: "escalationSweepTimer" });
  });

  it("clips the summary and refuses a note that is too long", async () => {
    const long = await raiseManual({ summary: "s".repeat(900) });
    expect(long.escalation.summary).toHaveLength(400);
    mockWorld.rows.clear();
    await expect(raiseManual({ note: "n".repeat(2001) })).rejects.toMatchObject({ code: "bad_request" });
  });

  it("passes the loaded directory on to the notifier so it isn't read twice", async () => {
    await raiseManual({ notify: { attempts: 2 } });
    const [, row, event, options] = jest.mocked(notifyTargets).mock.calls[0];
    expect(row.escalationId).toBeGreaterThanOrEqual(100);
    expect(event).toBe("raise");
    expect(options).toMatchObject({ attempts: 2 });
    expect(options?.users?.length).toBe(5);
  });
});

describe("previewTarget", () => {
  it("says where a manual escalation would go without writing anything", async () => {
    const { policy: p, target } = await previewTarget(conn, { actor: actorOf(FAY), policyKey: "job.manual" });

    expect(p.policyKey).toBe("job.manual");
    expect(target).toMatchObject({ level: 1, role: "facilities_manager", slaHours: 8 });
    expect(target.users.map((u) => u.name)).toEqual(["Adam", "Bea"]);
    expect(db.beginTransaction).not.toHaveBeenCalled();
    expect(mockWorld.rows.size).toBe(0);
  });

  it("flags a lone director and refuses an unknown policy or a person not at the level", async () => {
    mockWorld.users = [DEE];
    expect((await previewTarget(conn, { actor: actorOf(DEE), policyKey: "job.manual" })).target.noIndependentTarget).toBe(true);
    await expect(previewTarget(conn, { actor: actorOf(FAY), policyKey: "nope" })).rejects.toMatchObject({ code: "unknown_policy" });
    mockWorld.users = [ADAM, DEE, FAY];
    await expect(previewTarget(conn, { actor: actorOf(FAY), policyKey: "job.manual", preferredUserId: DEE.userId })).rejects.toMatchObject({ code: "target_not_eligible" });
  });
});

// ── acknowledge ──────────────────────────────────────────────────────────────

async function openEscalation(over: Partial<Parameters<typeof raise>[1]> = {}): Promise<EscalationRow> {
  const { escalation } = await raiseManual(over);
  events.length = 0;
  ledger.mockClear();
  jest.mocked(notifyTargets).mockClear();
  db.beginTransaction.mockClear();
  db.commitTransaction.mockClear();
  db.rollbackTransaction.mockClear();
  return escalation;
}

describe("acknowledge", () => {
  it("claims the escalation for the target and clears the subject's flag in the same transaction", async () => {
    const esc = await openEscalation();

    const done = await acknowledge(conn, { actor: actorOf(ADAM), escalationId: esc.escalationId, expectedRowVersion: esc.rowVersion, now: NOW });

    expect(done).toMatchObject({ acknowledgedByName: "Adam", acknowledgedByUserId: 1, status: "acknowledged", targetUserId: 1 });
    expect(done.acknowledgedAt).toEqual(NOW);
    expect(events).toEqual(["begin", "onChange", "ledger", "commit"]);
    const entry = ledgerCalls()[0];
    expect(entry).toMatchObject({ action: "escalation.acknowledge", actor: { name: "Adam", role: "facilities_manager" }, jobId: 12 });
    expect(entry?.before).toMatchObject({ status: "open" });
    expect(entry?.after).toMatchObject({ status: "acknowledged", targetUserId: 1 });
  });

  it("is refused with a 409 when someone else changed the row since it was read", async () => {
    const esc = await openEscalation();

    const error = await acknowledge(conn, { actor: actorOf(ADAM), escalationId: esc.escalationId, expectedRowVersion: "AAAAAAAAAAA=" }).catch((e) => e);

    expect(error).toBeInstanceOf(EscalationError);
    expect(error).toMatchObject({ code: "stale", status: 409 });
    expect(error.details.current.escalationId).toBe(esc.escalationId);
    expect(events).toEqual(["begin", "rollback"]);
    expect(rowOf(esc.escalationId).status).toBe("open");
    expect(ledger).not.toHaveBeenCalled();
  });

  it("is a conflict when a colleague already acknowledged it, and a no-op for the same person", async () => {
    const esc = await openEscalation();
    await acknowledge(conn, { actor: actorOf(ADAM), escalationId: esc.escalationId });
    events.length = 0;
    ledger.mockClear();

    await expect(acknowledge(conn, { actor: actorOf(BEA), escalationId: esc.escalationId })).rejects.toMatchObject({
      code: "already_acknowledged",
      message: "Adam has already acknowledged this.",
      status: 409,
    });
    expect(ledger).not.toHaveBeenCalled();

    const again = await acknowledge(conn, { actor: actorOf(ADAM), escalationId: esc.escalationId });
    expect(again.status).toBe("acknowledged");
    expect(ledger).not.toHaveBeenCalled();
  });

  it("refuses an escalation that is no longer open, and one that doesn't exist", async () => {
    const esc = await openEscalation();
    await withdraw(conn, { actor: actorOf(FAY), escalationId: esc.escalationId, reason: "no longer needed" });

    await expect(acknowledge(conn, { actor: actorOf(ADAM), escalationId: esc.escalationId })).rejects.toMatchObject({ code: "not_live" });
    await expect(acknowledge(conn, { actor: actorOf(ADAM), escalationId: 99999 })).rejects.toMatchObject({ code: "not_found", status: 404 });
  });

  it("rolls the acknowledgement back when the ledger write fails", async () => {
    const esc = await openEscalation();
    ledger.mockRejectedValueOnce(new Error("ledger unavailable"));

    await expect(acknowledge(conn, { actor: actorOf(ADAM), escalationId: esc.escalationId })).rejects.toThrow("ledger unavailable");

    expect(rowOf(esc.escalationId)).toMatchObject({ acknowledgedAt: null, status: "open", targetUserId: null });
    expect(db.commitTransaction).not.toHaveBeenCalled();
  });
});

// ── resolve ──────────────────────────────────────────────────────────────────

describe("resolve", () => {
  it("ends an attention escalation with a code and a note, claims it if unclaimed, and tells the raiser after commit", async () => {
    const esc = await openEscalation();

    const done = await resolve(conn, {
      actor: actorOf(ADAM),
      escalationId: esc.escalationId,
      expectedRowVersion: esc.rowVersion,
      note: "Rang the contractor",
      now: NOW,
      resolutionCode: "action_taken",
    });

    expect(done).toMatchObject({
      acknowledgedByUserId: 1,
      resolutionCode: "action_taken",
      resolutionNote: "Rang the contractor",
      resolvedByName: "Adam",
      resolvedByUserId: 1,
      status: "resolved",
      targetUserId: 1,
    });
    expect(done.resolvedAt).toEqual(NOW);
    expect(events).toEqual(["begin", "onChange", "ledger", "commit", "notifyRaiser"]);
    expect(ledgerCalls()[0]).toMatchObject({ action: "escalation.resolve", reason: "Rang the contractor" });
    expect(ledgerCalls()[0]?.after).toMatchObject({ resolutionCode: "action_taken", status: "resolved" });
  });

  it("keeps the earlier acknowledgement when it was already claimed", async () => {
    const esc = await openEscalation();
    await acknowledge(conn, { actor: actorOf(ADAM), escalationId: esc.escalationId, now: new Date(NOW.getTime() - 60_000) });

    const done = await resolve(conn, { actor: actorOf(BEA), escalationId: esc.escalationId, now: NOW });

    expect(done).toMatchObject({ acknowledgedByName: "Adam", resolvedByName: "Bea", resolutionCode: "action_taken" });
  });

  it("refuses an authority escalation with a 422 that points at the subject, and changes nothing", async () => {
    const { escalation } = await raise(conn, { actor: SWEEP_ACTOR, now: NOW, policyKey: "quote.over_limit", subjectId: "7", subjectType: "quote" });
    events.length = 0;
    ledger.mockClear();

    const error = await resolve(conn, { actor: actorOf(CAM), escalationId: escalation.escalationId }).catch((e) => e);

    expect(error).toBeInstanceOf(EscalationError);
    expect(error).toMatchObject({ code: "authority_resolve", status: 422 });
    expect(error.message).toMatch(/waiting on a decision/);
    expect(error.details).toEqual({ deepLink: "/quotes/7", subjectId: "7", subjectType: "quote" });
    expect(rowOf(escalation.escalationId).status).toBe("open");
    expect(ledger).not.toHaveBeenCalled();
    expect(notifyRaiserResolved).not.toHaveBeenCalled();
  });

  it("refuses an unknown resolution code, and a closed escalation", async () => {
    const esc = await openEscalation();
    await expect(resolve(conn, { actor: actorOf(ADAM), escalationId: esc.escalationId, resolutionCode: "done_dusted" })).rejects.toMatchObject({ code: "bad_request" });
    expect(db.beginTransaction).not.toHaveBeenCalled();

    await resolve(conn, { actor: actorOf(ADAM), escalationId: esc.escalationId });
    await expect(resolve(conn, { actor: actorOf(ADAM), escalationId: esc.escalationId })).rejects.toMatchObject({ code: "not_live" });
  });

  it("is a 409 on a stale version, and rolls back when the ledger fails", async () => {
    const esc = await openEscalation();
    await expect(resolve(conn, { actor: actorOf(ADAM), escalationId: esc.escalationId, expectedRowVersion: "AAAAAAAAAAA=" })).rejects.toMatchObject({ code: "stale" });

    ledger.mockRejectedValueOnce(new Error("ledger unavailable"));
    await expect(resolve(conn, { actor: actorOf(ADAM), escalationId: esc.escalationId })).rejects.toThrow("ledger unavailable");
    expect(rowOf(esc.escalationId).status).toBe("open");
    expect(notifyRaiserResolved).not.toHaveBeenCalled();
  });
});

// ── withdraw ─────────────────────────────────────────────────────────────────

describe("withdraw", () => {
  it("needs a reason and does nothing without one", async () => {
    const esc = await openEscalation();

    for (const reason of [undefined, null, "", "   "]) {
      await expect(withdraw(conn, { actor: actorOf(FAY), escalationId: esc.escalationId, reason })).rejects.toMatchObject({ code: "reason_required", status: 400 });
    }
    expect(db.beginTransaction).not.toHaveBeenCalled();
    expect(rowOf(esc.escalationId).status).toBe("open");
  });

  it("takes an open escalation back and writes the reason to the ledger as an exception", async () => {
    const esc = await openEscalation();

    const done = await withdraw(conn, { actor: actorOf(FAY), escalationId: esc.escalationId, expectedRowVersion: esc.rowVersion, now: NOW, reason: "Sorted it with the tenant" });

    expect(done).toMatchObject({ resolutionCode: "withdrawn", resolutionNote: "Sorted it with the tenant", resolvedByName: "Fay", status: "withdrawn" });
    expect(events).toEqual(["begin", "onChange", "ledger", "commit"]);
    expect(ledgerCalls()[0]).toMatchObject({ action: "escalation.withdraw", reason: "Sorted it with the tenant" });
  });

  it("can't withdraw one somebody has acknowledged", async () => {
    const esc = await openEscalation();
    await acknowledge(conn, { actor: actorOf(ADAM), escalationId: esc.escalationId });

    await expect(withdraw(conn, { actor: actorOf(FAY), escalationId: esc.escalationId, reason: "oops" })).rejects.toMatchObject({
      code: "not_live",
      message: expect.stringContaining("Adam has already acknowledged"),
    });
  });

  it("is a 409 on a stale version", async () => {
    const esc = await openEscalation();
    await expect(withdraw(conn, { actor: actorOf(FAY), escalationId: esc.escalationId, expectedRowVersion: "AAAAAAAAAAA=", reason: "x" })).rejects.toMatchObject({ code: "stale" });
  });
});

// ── auto-resolve ─────────────────────────────────────────────────────────────

describe("autoResolve (condition_cleared)", () => {
  it("withdraws an escalation nobody had picked up", async () => {
    const esc = await openEscalation();

    const done = await autoResolve(conn, { escalationId: esc.escalationId, expectedRowVersion: esc.rowVersion, now: NOW });

    expect(done).toMatchObject({ resolutionCode: "condition_cleared", resolvedByName: "Floorplan", resolvedByUserId: null, status: "withdrawn" });
    expect(events).toEqual(["begin", "onChange", "ledger", "commit"]);
    expect(ledgerCalls()[0]).toMatchObject({ action: "escalation.auto_resolve", actor: { kind: "system" }, ruleApplied: "condition_cleared" });
  });

  it("resolves one a person had acknowledged", async () => {
    const esc = await openEscalation();
    await acknowledge(conn, { actor: actorOf(ADAM), escalationId: esc.escalationId });

    const done = await autoResolve(conn, { escalationId: esc.escalationId, now: NOW });

    expect(done).toMatchObject({ acknowledgedByName: "Adam", resolutionCode: "condition_cleared", status: "resolved" });
  });

  it("leaves authority escalations to the decision", async () => {
    const { escalation } = await raise(conn, { actor: SWEEP_ACTOR, now: NOW, policyKey: "quote.over_limit", subjectId: "7", subjectType: "quote" });
    await expect(autoResolve(conn, { escalationId: escalation.escalationId })).rejects.toMatchObject({ code: "authority_resolve" });
    expect(rowOf(escalation.escalationId).status).toBe("open");
  });

  it("is skipped quietly if the row has already moved on", async () => {
    const esc = await openEscalation();
    await withdraw(conn, { actor: actorOf(FAY), escalationId: esc.escalationId, reason: "x" });
    await expect(autoResolve(conn, { escalationId: esc.escalationId })).rejects.toMatchObject({ code: "not_live" });
  });
});

// ── escalate further ─────────────────────────────────────────────────────────

describe("concludeForSubject (the subject's own decision)", () => {
  const raiseQuote = (over: Partial<Parameters<typeof raise>[1]> = {}) =>
    raise(conn, { actor: actorOf(FAY), now: NOW, policyKey: "quote.over_limit", subjectId: "77", subjectType: "quote", ...over });

  it("ends an authority escalation, which resolve refuses, with the decision as its code, and tells the raiser after commit", async () => {
    const { escalation } = await raiseQuote();
    events.length = 0;
    ledger.mockClear();

    const ended = await concludeForSubject(conn, { actor: actorOf(CAM), code: "approved", now: NOW, subjectId: "77", subjectType: "quote" });

    expect(ended.map((r) => r.escalationId)).toEqual([escalation.escalationId]);
    expect(rowOf(escalation.escalationId)).toMatchObject({ resolutionCode: "approved", resolvedByName: "Cam", resolvedByUserId: 3, status: "resolved" });
    expect(events).toEqual(["begin", "ledger", "commit", "notifyRaiser"]);
    expect(ledgerCalls()[0]).toMatchObject({
      action: "escalation.resolve",
      after: { resolutionCode: "approved", status: "resolved" },
      before: { status: "open" },
      ruleApplied: "approved",
      subject: { id: escalation.escalationId, type: "escalation" },
    });
  });

  it("withdraws one nobody picked up when the subject was cancelled, with the reason, and resolves one somebody had", async () => {
    const quote = await raiseQuote();
    const job = await raiseManual();
    await acknowledge(conn, { actor: actorOf(ADAM), escalationId: job.escalation.escalationId, now: NOW });
    ledger.mockClear();

    await concludeForSubject(conn, { actor: actorOf(DEE), code: "cancelled", note: "Tenant vacated", subjectId: "77", subjectType: "quote", withdrawOpen: true });
    await concludeForSubject(conn, { actor: actorOf(DEE), code: "cancelled", note: "Tenant vacated", subjectId: "12", subjectType: "job", withdrawOpen: true });

    expect(rowOf(quote.escalation.escalationId)).toMatchObject({ resolutionCode: "cancelled", resolutionNote: "Tenant vacated", status: "withdrawn" });
    expect(rowOf(job.escalation.escalationId)).toMatchObject({ resolutionCode: "cancelled", status: "resolved" });
    expect(ledgerCalls().map((e) => [e.action, e.reason])).toEqual([
      ["escalation.withdraw", "Tenant vacated"],
      ["escalation.resolve", "Tenant vacated"],
    ]);
  });

  it("needs a reason to withdraw, and changes nothing without one", async () => {
    const { escalation } = await raiseQuote();
    await expect(concludeForSubject(conn, { actor: actorOf(DEE), code: "cancelled", subjectId: "77", subjectType: "quote", withdrawOpen: true })).rejects.toMatchObject({
      code: "reason_required",
    });
    expect(rowOf(escalation.escalationId).status).toBe("open");
  });

  it("ends only the policies it is given", async () => {
    const manual = await raiseManual();
    await raiseManual({ policyKey: "job.stalled_unacknowledged" });
    const ended = await concludeForSubject(conn, { actor: SWEEP_ACTOR, code: "approved", policyKeys: ["job.manual"], subjectId: "12", subjectType: "job" });
    expect(ended.map((r) => r.escalationId)).toEqual([manual.escalation.escalationId]);
    expect([...mockWorld.rows.values()].filter((r) => r.status === "open").map((r) => r.policyKey)).toEqual(["job.stalled_unacknowledged"]);
  });

  it("refuses a code that isn't one, before touching anything", async () => {
    const { escalation } = await raiseQuote();
    await expect(concludeForSubject(conn, { actor: actorOf(CAM), code: "Approved!", subjectId: "77", subjectType: "quote" })).rejects.toBeInstanceOf(EscalationError);
    await expect(concludeForSubject(conn, { actor: actorOf(CAM), code: "a".repeat(33), subjectId: "77", subjectType: "quote" })).rejects.toBeInstanceOf(EscalationError);
    expect(rowOf(escalation.escalationId).status).toBe("open");
  });

  it("rolls the ending back when the ledger write fails", async () => {
    const { escalation } = await raiseQuote();
    ledger.mockRejectedValueOnce(new Error("ledger down"));
    await expect(concludeForSubject(conn, { actor: actorOf(CAM), code: "approved", subjectId: "77", subjectType: "quote" })).rejects.toThrow("ledger down");
    expect(rowOf(escalation.escalationId).status).toBe("open");
    expect(notifyRaiserResolved).not.toHaveBeenCalled();
  });

  it("does nothing when the subject has no live escalation", async () => {
    await expect(concludeForSubject(conn, { actor: actorOf(CAM), code: "approved", subjectId: "nothing", subjectType: "quote" })).resolves.toEqual([]);
    expect(db.beginTransaction).not.toHaveBeenCalled();
  });
});

describe("escalateFurther", () => {
  it("supersedes with a new row at the next level, linked by ParentEscalationId, with both rows in the ledger under one correlation id", async () => {
    const esc = await openEscalation();

    const { next, previous } = await escalateFurther(conn, {
      actor: actorOf(ADAM),
      escalationId: esc.escalationId,
      expectedRowVersion: esc.rowVersion,
      mode: "next_level",
      note: "Needs the director",
      now: NOW,
    });

    expect(previous).toMatchObject({ resolutionCode: "escalated", resolvedByName: "Adam", status: "superseded" });
    expect(next).toMatchObject({
      level: 2,
      noIndependentTarget: false,
      note: esc.note,
      notificationState: "pending",
      parentEscalationId: esc.escalationId,
      policyKey: "job.manual",
      raisedByName: "Fay",
      raisedByUserId: 8,
      status: "open",
      subjectId: "12",
      summary: esc.summary,
      targetRole: "director",
    });
    // director@16: 16 business hours from Monday 09:00 Darwin end Wednesday 09:00 Darwin
    expect(next.dueAt?.toISOString()).toBe("2026-10-13T23:30:00.000Z");

    expect(events).toEqual(["begin", "onChange", "ledger", "ledger", "commit", "notify", "notifyPrevious"]);
    const [superseded, raised] = ledgerCalls();
    expect(superseded).toMatchObject({
      action: "escalation.supersede",
      subject: { id: esc.escalationId, type: "escalation" },
      jobId: 12,
      ruleApplied: "escalated",
    });
    expect(superseded?.after).toMatchObject({ status: "superseded", supersededBy: next.escalationId });
    expect(raised).toMatchObject({ action: "escalation.raise", subject: { id: next.escalationId, type: "escalation" } });
    expect(raised?.before).toEqual({ parentEscalationId: esc.escalationId });
    expect(superseded?.correlationId).toBeDefined();
    expect(superseded?.correlationId).toBe(raised?.correlationId);
  });

  it("frees the old row's place in the unique live index before the new row takes it", async () => {
    const esc = await openEscalation();
    // The in-memory index refuses a second live row for the subject and policy,
    // so this passes only if the old row is superseded first.
    await expect(escalateFurther(conn, { actor: actorOf(ADAM), escalationId: esc.escalationId, mode: "next_level", now: NOW })).resolves.toBeDefined();
    const live = [...mockWorld.rows.values()].filter((r) => r.status === "open" || r.status === "acknowledged");
    expect(live).toHaveLength(1);
  });

  it("emails the new level and tells the previous one after the commit", async () => {
    const esc = await openEscalation();
    const { next, previous } = await escalateFurther(conn, { actor: actorOf(ADAM), escalationId: esc.escalationId, mode: "next_level", now: NOW });

    expect(notifyTargets).toHaveBeenCalledWith(conn, expect.objectContaining({ escalationId: next.escalationId }), "supersede", expect.anything());
    expect(notifyPreviousLevel).toHaveBeenCalledWith(conn, expect.objectContaining({ escalationId: previous.escalationId }), expect.objectContaining({ escalationId: next.escalationId }), expect.anything());
  });

  it("is what the sweep does at an SLA breach: sla_breach, and only for an escalation nobody acknowledged", async () => {
    const esc = await openEscalation();

    const { previous } = await escalateFurther(conn, {
      actor: SWEEP_ACTOR,
      code: "sla_breach",
      escalationId: esc.escalationId,
      mode: "next_level",
      now: NOW,
      onlyIfOpen: true,
    });

    expect(previous).toMatchObject({ resolutionCode: "sla_breach", resolvedByName: "Floorplan", status: "superseded" });
    expect(ledgerCalls()[0]?.reason).toBe("No one acknowledged it in time, so it moved up to Director");
    expect(ledgerCalls()[0]?.actor).toEqual({ kind: "system", name: "escalationSweepTimer" });

    const other = await openEscalation({ subjectId: "13" });
    await acknowledge(conn, { actor: actorOf(ADAM), escalationId: other.escalationId });
    await expect(
      escalateFurther(conn, { actor: SWEEP_ACTOR, code: "sla_breach", escalationId: other.escalationId, mode: "next_level", onlyIfOpen: true }),
    ).rejects.toMatchObject({ code: "not_live", status: 409 });
    expect(rowOf(other.escalationId).status).toBe("acknowledged");
  });

  it("lets a person push an acknowledged escalation further up", async () => {
    const esc = await openEscalation();
    await acknowledge(conn, { actor: actorOf(ADAM), escalationId: esc.escalationId });

    const { next } = await escalateFurther(conn, { actor: actorOf(ADAM), escalationId: esc.escalationId, mode: "next_level", now: NOW });

    expect(next.level).toBe(2);
  });

  it("says there is nowhere further to go from the top of the ladder", async () => {
    const esc = await openEscalation();
    const { next } = await escalateFurther(conn, { actor: actorOf(ADAM), escalationId: esc.escalationId, mode: "next_level", now: NOW });

    const error = await escalateFurther(conn, { actor: actorOf(DEE), escalationId: next.escalationId, mode: "next_level" }).catch((e) => e);

    expect(error).toMatchObject({ code: "no_further_level", status: 422 });
    expect(rowOf(next.escalationId).status).toBe("open");
  });

  it("repeats a level with a fresh clock as a reminder, without telling the previous level", async () => {
    const esc = await openEscalation();

    const { next, previous } = await escalateFurther(conn, { actor: SWEEP_ACTOR, code: "reminder", escalationId: esc.escalationId, mode: "same_level", now: NOW });

    expect(previous.status).toBe("superseded");
    expect(next).toMatchObject({ level: 1, lastFollowUpAt: null, parentEscalationId: esc.escalationId, targetRole: "facilities_manager" });
    expect(notifyTargets).toHaveBeenCalledWith(conn, expect.anything(), "reminder", expect.anything());
    expect(notifyPreviousLevel).not.toHaveBeenCalled();
  });

  it("restarts the clock on a follow-up email at the same level and says so", async () => {
    const esc = await openEscalation();

    const { next } = await escalateFurther(conn, { actor: SWEEP_ACTOR, code: "follow_up", escalationId: esc.escalationId, mode: "same_level", now: NOW });

    expect(next).toMatchObject({ level: 1, targetRole: "facilities_manager" });
    expect(next.lastFollowUpAt).toEqual(NOW);
    expect(next.dueAt?.toISOString()).toBe("2026-10-12T23:30:00.000Z");
    expect(notifyTargets).toHaveBeenCalledWith(conn, expect.anything(), "follow_up", expect.anything());
    expect(ledgerCalls()[0]?.reason).toBe("A new email about this arrived, so the clock restarted");
  });

  it("keeps a flagged escalation flagged when it is repeated", async () => {
    mockWorld.users = [DEE, FAY];
    const esc = await openEscalation({ actor: actorOf(DEE) });
    expect(esc.noIndependentTarget).toBe(true);

    const { next } = await escalateFurther(conn, { actor: SWEEP_ACTOR, code: "reminder", escalationId: esc.escalationId, mode: "same_level", now: NOW });

    expect(next).toMatchObject({ noIndependentTarget: true, targetRole: "director" });
  });

  it("lets the person pushing it pick someone at the next level, and refuses someone who isn't", async () => {
    mockWorld.users = [ADAM, DEE, user(6, "Eli", "director"), FAY];
    const esc = await openEscalation();

    await expect(escalateFurther(conn, { actor: actorOf(ADAM), escalationId: esc.escalationId, mode: "next_level", preferredUserId: ADAM.userId })).rejects.toMatchObject({ code: "target_not_eligible" });
    expect(rowOf(esc.escalationId).status).toBe("open");

    const { next } = await escalateFurther(conn, { actor: actorOf(ADAM), escalationId: esc.escalationId, mode: "next_level", preferredUserId: 6, now: NOW });
    expect(next.targetUserId).toBe(6);
  });

  it("is a 409 on a stale version, and a 404 for an escalation that isn't there", async () => {
    const esc = await openEscalation();
    await expect(escalateFurther(conn, { actor: actorOf(ADAM), escalationId: esc.escalationId, expectedRowVersion: "AAAAAAAAAAA=", mode: "next_level" })).rejects.toMatchObject({ code: "stale" });
    await expect(escalateFurther(conn, { actor: actorOf(ADAM), escalationId: 99999, mode: "next_level" })).rejects.toMatchObject({ code: "not_found" });
  });

  it("is a 409 if the row changed between planning the move and writing it", async () => {
    const esc = await openEscalation();
    const store = require("./store") as { getEscalationRow: jest.Mock };
    // The plan is made from the first read; by the time the row is locked someone has acknowledged it.
    store.getEscalationRow.mockImplementationOnce(async () => ({ ...rowOf(esc.escalationId) }));
    await acknowledge(conn, { actor: actorOf(BEA), escalationId: esc.escalationId });
    store.getEscalationRow.mockImplementationOnce(async () => ({ ...rowOf(esc.escalationId), status: "open" }));

    await expect(escalateFurther(conn, { actor: actorOf(ADAM), escalationId: esc.escalationId, mode: "next_level" })).rejects.toMatchObject({ code: "stale" });
    expect(rowOf(esc.escalationId).status).toBe("acknowledged");
  });

  it("rolls everything back when the second ledger row fails: the old row stays live, there is no new row", async () => {
    const esc = await openEscalation();
    ledger.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("ledger unavailable"));

    await expect(escalateFurther(conn, { actor: actorOf(ADAM), escalationId: esc.escalationId, mode: "next_level", now: NOW })).rejects.toThrow("ledger unavailable");

    expect(mockWorld.rows.size).toBe(1);
    expect(rowOf(esc.escalationId).status).toBe("open");
    expect(db.commitTransaction).not.toHaveBeenCalled();
    expect(notifyTargets).not.toHaveBeenCalled();
    expect(notifyPreviousLevel).not.toHaveBeenCalled();
  });
});

describe("hasNextLevel", () => {
  it("is true while the ladder has an eligible level above, false at the top", async () => {
    const esc = await openEscalation();
    expect(await hasNextLevel(conn, esc, NOW)).toBe(true);

    const { next } = await escalateFurther(conn, { actor: actorOf(ADAM), escalationId: esc.escalationId, mode: "next_level", now: NOW });
    expect(await hasNextLevel(conn, next, NOW)).toBe(false);
  });

  it("is false for an unknown policy", async () => {
    const esc = await openEscalation();
    getPolicyMock.mockResolvedValueOnce(null);
    expect(await hasNextLevel(conn, esc, NOW)).toBe(false);
  });
});

describe("previewNextLevel", () => {
  it("names the level and the people Escalate further would send it to", async () => {
    const esc = await openEscalation();
    expect(await previewNextLevel(conn, esc, NOW)).toEqual({ names: ["Dee"], roleLabel: "Director" });
  });

  it("lists every eligible person at that level, by name", async () => {
    mockWorld.users = [ADAM, DEE, user(6, "Eli", "director"), FAY];
    const esc = await openEscalation();
    expect(await previewNextLevel(conn, esc, NOW)).toEqual({ names: ["Dee", "Eli"], roleLabel: "Director" });
  });

  it("is null at the top of the ladder, like hasNextLevel", async () => {
    const esc = await openEscalation();
    const { next } = await escalateFurther(conn, { actor: actorOf(ADAM), escalationId: esc.escalationId, mode: "next_level", now: NOW });
    expect(await previewNextLevel(conn, next, NOW)).toBeNull();
    expect(await hasNextLevel(conn, next, NOW)).toBe(false);
  });

  it("is null for an unknown policy", async () => {
    const esc = await openEscalation();
    getPolicyMock.mockResolvedValueOnce(null);
    expect(await previewNextLevel(conn, esc, NOW)).toBeNull();
  });

  it("agrees with hasNextLevel and writes nothing", async () => {
    const esc = await openEscalation();
    const next = await previewNextLevel(conn, esc, NOW);
    expect(next !== null).toBe(await hasNextLevel(conn, esc, NOW));
    expect(ledger).not.toHaveBeenCalled();
    expect(db.beginTransaction).not.toHaveBeenCalled();
    expect(jest.mocked(notifyTargets)).not.toHaveBeenCalled();
  });

  it("uses the directory it is given instead of loading one", async () => {
    const esc = await openEscalation();
    mockWorld.users = [];
    expect(await previewNextLevel(conn, esc, NOW, [ADAM, DEE, FAY])).toEqual({ names: ["Dee"], roleLabel: "Director" });
  });
});

// ── The sweep and the engine together ────────────────────────────────────────
// The real sweep driving the real engine over the in-memory database: the
// scenarios of LAUNCH-READINESS §4.2 end to end, with the ledger and the
// transaction calls observed.

describe("the sweep drives the engine", () => {
  const ENV = {
    APP_BASE_URL: "https://floorplan.example",
    GRAPH_CLIENT_ID: "id",
    GRAPH_CLIENT_SECRET: "secret",
    GRAPH_SENDER_EMAIL: "floorplan@example.com",
    GRAPH_TENANT_ID: "tenant",
  } as NodeJS.ProcessEnv;
  const MONDAY_9AM = NOW; // 2026-10-12 09:00 Darwin
  const at = (hoursAfter: number) => new Date(MONDAY_9AM.getTime() + hoursAfter * 3_600_000);

  let jobs: JobFacts[];

  const unassignedJob = (over: Partial<JobFacts> = {}): JobFacts => ({
    acknowledgedAt: null,
    assigned: false,
    assignedTo: null,
    buildingId: 5,
    buildingName: "Tower A",
    createdAt: new Date(MONDAY_9AM.getTime() - 3 * 24 * 3_600_000),
    expectedProgressUpdate: null,
    firstQuoteRequestAt: null,
    isArchived: false,
    jobId: 12,
    kind: "facilities",
    oldestPendingInvoiceAt: null,
    pendingInvoices: 0,
    priority: "Normal",
    quoteCount: 0,
    requestedContractors: 0,
    status: "New",
    statusSince: new Date(MONDAY_9AM.getTime() - 3 * 24 * 3_600_000),
    title: "Leaking roof",
    ...over,
  });

  const sweepAt = (now: Date) =>
    runSweep(
      conn,
      { dryRun: false, env: ENV, log: () => undefined, now, warn: () => undefined },
      {
        ...defaultSweepDeps,
        countExhaustedNotifications: async () => 0,
        latestEmailArrivals: async () => new Map(),
        listDueDeferrals: async () => [],
        loadLiveJobFacts: async () => jobs.filter((j) => !j.isArchived && j.status !== "Done"),
      },
    );

  beforeEach(() => {
    jobs = [];
    POLICIES["job.unassigned"] = policy({
      ladder: [{ role: "facilities_manager", slaHours: 8 }, { role: "director", slaHours: 16 }],
      policyKey: "job.unassigned",
    });
    jobAdapter.isConditionActive.mockImplementation((async (_c: unknown, ref: { policyKey: string; subjectId: string }, now: Date) => {
      const found = jobs.find((j) => String(j.jobId) === ref.subjectId);
      return found ? jobConditionActive(ref.policyKey, found, { env: ENV, holidays: NO_HOLIDAYS, now }) : false;
    }) as never);
    jobAdapter.loadSummary.mockImplementation((async (_c: unknown, id: string) => {
      const found = jobs.find((j) => String(j.jobId) === id);
      return found ? { buildingId: 5, context: { title: found.title }, summary: `Job #${id} · ${found.title}` } : null;
    }) as never);
  });

  afterEach(() => {
    delete POLICIES["job.unassigned"];
  });

  it("raises a live unassigned job, then moves it to the directors when nobody acknowledges it in time, with both rows linked in the ledger", async () => {
    jobs = [unassignedJob()];

    const first = await sweepAt(MONDAY_9AM);
    expect(first).toMatchObject({ errors: [], raised: 1, superseded: 0 });
    const [level1] = [...mockWorld.rows.values()];
    expect(level1).toMatchObject({ level: 1, policyKey: "job.unassigned", raisedByKind: "system", status: "open", targetRole: "facilities_manager" });
    expect(level1.summary).toBe("Job #12 · Leaking roof — Needs an owner: no one is assigned");
    // 8 business hours from Monday 09:00 Darwin is Tuesday 09:00 Darwin = 23:30Z
    expect(level1.dueAt?.toISOString()).toBe("2026-10-12T23:30:00.000Z");

    // Before the SLA: nothing happens.
    const early = await sweepAt(at(7));
    expect(early).toMatchObject({ raised: 0, reminded: 0, superseded: 0 });

    // Past the SLA with nobody having acknowledged it.
    ledger.mockClear();
    const late = await sweepAt(at(24));
    expect(late).toMatchObject({ errors: [], raised: 0, superseded: 1 });

    const all = [...mockWorld.rows.values()];
    expect(all).toHaveLength(2);
    expect(all[0]).toMatchObject({ resolutionCode: "sla_breach", status: "superseded" });
    expect(all[1]).toMatchObject({ level: 2, parentEscalationId: all[0].escalationId, status: "open", targetRole: "director" });
    const [superseded, raised] = ledgerCalls();
    expect(superseded).toMatchObject({ action: "escalation.supersede", actor: { kind: "system" }, subject: { id: all[0].escalationId, type: "escalation" } });
    expect(raised).toMatchObject({ action: "escalation.raise", subject: { id: all[1].escalationId, type: "escalation" } });
    expect(superseded?.correlationId).toBe(raised?.correlationId);
  });

  it("is settled after a run: the same sweep again changes nothing", async () => {
    jobs = [unassignedJob()];
    await sweepAt(MONDAY_9AM);
    await sweepAt(at(24));
    const rows = JSON.stringify([...mockWorld.rows.values()]);
    ledger.mockClear();

    const again = await sweepAt(at(24));

    expect(again).toMatchObject({ autoResolved: 0, raised: 0, reminded: 0, superseded: 0 });
    expect(JSON.stringify([...mockWorld.rows.values()])).toBe(rows);
    expect(ledger).not.toHaveBeenCalled();
  });

  it("stops SLA re-escalation once the target acknowledges", async () => {
    jobs = [unassignedJob()];
    await sweepAt(MONDAY_9AM);
    const [level1] = [...mockWorld.rows.values()];
    await acknowledge(conn, { actor: actorOf(ADAM), escalationId: level1.escalationId, now: at(2) });

    const late = await sweepAt(at(30));

    expect(late).toMatchObject({ reminded: 0, superseded: 0 });
    expect(mockWorld.rows.size).toBe(1);
    expect(rowOf(level1.escalationId).status).toBe("acknowledged");
  });

  it("ends an escalation by itself when its condition clears (condition_cleared)", async () => {
    jobs = [unassignedJob()];
    await sweepAt(MONDAY_9AM);
    const [level1] = [...mockWorld.rows.values()];

    jobs = [unassignedJob({ assigned: true, assignedTo: "Fay" })]; // someone took the job
    const report = await sweepAt(at(1));

    expect(report).toMatchObject({ autoResolved: 1, errors: [] });
    expect(rowOf(level1.escalationId)).toMatchObject({ resolutionCode: "condition_cleared", status: "withdrawn" });
    expect(ledgerCalls().some((e) => e?.action === "escalation.auto_resolve")).toBe(true);
    expect(jobAdapter.onChange).toHaveBeenCalled();
  });

  it("restarts the clock on a follow-up email and tells the target again", async () => {
    jobs = [unassignedJob()];
    await sweepAt(MONDAY_9AM);
    const [level1] = [...mockWorld.rows.values()];
    jest.mocked(notifyTargets).mockClear();

    const report = await runSweep(
      conn,
      { dryRun: false, env: ENV, log: () => undefined, now: at(3), warn: () => undefined },
      {
        ...defaultSweepDeps,
        countExhaustedNotifications: async () => 0,
        latestEmailArrivals: async () => new Map([[12, new Date(at(2).getTime() + 3_600_000 * 24)]]),
        loadLiveJobFacts: async () => jobs,
      },
    );

    expect(report.followUps).toBe(1);
    const rows = [...mockWorld.rows.values()];
    expect(rows).toHaveLength(2);
    expect(rowOf(level1.escalationId).resolutionCode).toBe("follow_up");
    expect(rows[1]).toMatchObject({ level: 1, parentEscalationId: level1.escalationId, targetRole: "facilities_manager" });
    expect(jest.mocked(notifyTargets).mock.calls.map((c) => c[2])).toContain("follow_up");
  });
});

describe("raise: startAtRole", () => {
  beforeEach(() => {
    jobAdapter.loadSummary.mockImplementation(async () => ({ buildingId: 5, context: { title: "Over limit" }, summary: "Quote #7" }));
  });

  it("starts the ladder at the first level holding the role, skipping the eligible levels below it", async () => {
    const { escalation } = await raise(conn, {
      actor: SWEEP_ACTOR,
      now: NOW,
      policyKey: "quote.over_limit",
      startAtRole: "director",
      subjectId: "7",
      subjectType: "quote",
    });
    expect(escalation).toMatchObject({ level: 2, noIndependentTarget: false, targetRole: "director" });
  });

  it("aims at the directors, flagged, when the only director is left out", async () => {
    const { escalation } = await raise(conn, {
      actor: SWEEP_ACTOR,
      excludeUserIds: [DEE.userId],
      now: NOW,
      policyKey: "quote.over_limit",
      startAtRole: "director",
      subjectId: "7",
      subjectType: "quote",
    });
    expect(escalation).toMatchObject({ noIndependentTarget: true, targetRole: "director" });
  });
});

// ── a decision request's escalation (jobs plan A1) ───────────────────────────

const GUID = "6f1c2a52-3b57-4d5e-9d0a-2f6a1c0b7e11";

const askForDecision = (over: Partial<Parameters<typeof raise>[1]> = {}) =>
  raise(conn, {
    actor: actorOf(FAY),
    now: NOW,
    policyKey: "job.decision_pending",
    subjectId: "12",
    subjectType: "job",
    userTargets: [CAM.userId, DEE.userId],
    ...over,
  });

describe("raise, for a caller with a deadline and an urgency of its own", () => {
  it("takes the first level's due moment from the caller, not from the ladder", async () => {
    const due = new Date("2026-10-20T07:00:00Z");
    const { escalation } = await askForDecision({ dueAt: due });
    expect(escalation.dueAt?.toISOString()).toBe(due.toISOString());
  });

  it("takes no due moment at all when the caller says never: an emergency is recorded, not chased", async () => {
    const { escalation } = await askForDecision({ dueAt: null });
    expect(escalation.dueAt).toBeNull();
  });

  it("falls back to the ladder when the caller says nothing (and this ladder's first level has no hours)", async () => {
    const { escalation } = await askForDecision();
    expect(escalation.dueAt).toBeNull();
    const manual = await raiseManual();
    expect(manual.escalation.dueAt?.toISOString()).toBe("2026-10-12T23:30:00.000Z");
  });

  it("takes the urgency from the caller, over the policy's", async () => {
    expect((await askForDecision({ urgent: true })).escalation.urgent).toBe(true);
    mockWorld.rows.clear();
    expect((await askForDecision({ urgent: false })).escalation.urgent).toBe(false);
    mockWorld.rows.clear();
    expect((await askForDecision()).escalation.urgent).toBe(false);
    // and the policy's own urgency stands when the caller says nothing
    expect((await raise(conn, { actor: actorOf(FAY), now: NOW, policyKey: "job.critical", subjectId: "12", subjectType: "job" })).escalation.urgent).toBe(true);
  });

  it("puts the caller's correlation id on its ledger row, to read with the caller's own", async () => {
    await askForDecision({ correlationId: GUID });
    expect(ledgerCalls()[0]).toMatchObject({ action: "escalation.raise", correlationId: GUID });
  });

  it("goes to a group of named people: neither a role nor one person is on the row, the list is in its context", async () => {
    const { escalation } = await askForDecision();

    expect(escalation).toMatchObject({ kind: "authority", level: 1, noIndependentTarget: false, targetRole: null, targetUserId: null });
    expect(escalation.context).toMatchObject({ title: "Leaking roof", userTargets: [3, 5] });
  });

  it("goes to one named person as that person, with their role", async () => {
    const { escalation } = await askForDecision({ userTargets: [CAM.userId] });
    expect(escalation).toMatchObject({ level: 1, targetRole: "accounts_manager", targetUserId: CAM.userId });
  });

  it("never asks the person who is asking: they are left out of the people named", async () => {
    const { escalation } = await askForDecision({ userTargets: [FAY.userId, CAM.userId] });
    expect(escalation).toMatchObject({ targetRole: "accounts_manager", targetUserId: CAM.userId });
  });

  it("carries the schedule and the decision it was given in its context", async () => {
    const { escalation } = await askForDecision({
      context: { decision: { question: "Pay it?", requestId: 7 }, schedule: { escalateAt: null, remindAt: ["2026-10-15T23:00:00.000Z"] } },
    });
    expect(escalation.context).toMatchObject({
      decision: { question: "Pay it?", requestId: 7 },
      schedule: { remindAt: ["2026-10-15T23:00:00.000Z"] },
      userTargets: [3, 5],
    });
  });

  it("moves up from the people asked to the raiser's manager, then to a director, whatever it was due at", async () => {
    mockWorld.users = [ADAM, BEA, CAM, DEE, FAY, user(9, "Gus", "accounts")];
    const first = await askForDecision({ actor: actorOf(user(9, "Gus", "accounts")), dueAt: new Date(NOW.getTime() + 3_600_000) });
    const { next } = await escalateFurther(conn, { actor: SWEEP_ACTOR, escalationId: first.escalation.escalationId, mode: "next_level", now: NOW, onlyIfOpen: true });

    expect(next).toMatchObject({ level: 2, parentEscalationId: first.escalation.escalationId, targetRole: "accounts_manager" });
    // the manager has 16 business hours; the people asked are still in the context
    expect(next.dueAt?.toISOString()).toBe("2026-10-13T23:30:00.000Z"); // Wed 09:00 Darwin: 7.5h left on Monday, 8h on Tuesday, 0.5h on Wednesday
    expect(next.context).toMatchObject({ userTargets: [3, 5] });
  });
});

describe("raiseWithin, on a transaction the caller owns", () => {
  /** The caller begins, as a decision request's service does. */
  const callerBegins = async () => {
    await db.beginTransaction({} as never);
  };

  it("writes the row, the subject's flags and the ledger row without beginning or committing anything, and notifies no one", async () => {
    await callerBegins();
    events.length = 0;

    const result = await raiseWithin(conn, {
      actor: actorOf(FAY),
      now: NOW,
      policyKey: "job.decision_pending",
      subjectId: "12",
      subjectType: "job",
      userTargets: [CAM.userId, DEE.userId],
    });

    expect(result.created).toBe(true);
    expect(events).toEqual(["onChange", "ledger"]);
    expect(notifyTargets).not.toHaveBeenCalled();
    expect(result.escalation).toMatchObject({ policyKey: "job.decision_pending", status: "open" });
  });

  it("emails the targets only when the caller says so, after its commit, and returns the row as it stands", async () => {
    await callerBegins();
    const result = await raiseWithin(conn, {
      actor: actorOf(FAY),
      notify: { attempts: 1 },
      now: NOW,
      policyKey: "job.decision_pending",
      subjectId: "12",
      subjectType: "job",
      userTargets: [CAM.userId, DEE.userId],
    });
    await db.commitTransaction({} as never);
    events.length = 0;

    const announced = await result.announce();

    expect(events).toEqual(["notify"]);
    const [, row, event, options] = jest.mocked(notifyTargets).mock.calls[0];
    expect(row.escalationId).toBe(result.escalation.escalationId);
    expect(event).toBe("raise");
    expect(options?.users?.map((u) => u.name)).toEqual(["Adam", "Bea", "Cam", "Dee", "Fay"]);
    expect(announced.escalationId).toBe(result.escalation.escalationId);
  });

  it("is rolled back with the caller's own writes when the ledger write fails, leaving no escalation", async () => {
    await callerBegins();
    ledger.mockRejectedValueOnce(new Error("ledger unavailable"));

    await expect(
      raiseWithin(conn, { actor: actorOf(FAY), now: NOW, policyKey: "job.decision_pending", subjectId: "12", subjectType: "job", userTargets: [CAM.userId] }),
    ).rejects.toThrow("ledger unavailable");
    await db.rollbackTransaction({} as never);

    expect(mockWorld.rows.size).toBe(0);
    expect(db.commitTransaction).not.toHaveBeenCalled();
    expect(notifyTargets).not.toHaveBeenCalled();
  });

  it("leaves a unique-index race to the caller, whose transaction it is", async () => {
    await askForDecision(); // the live one our pre-check will miss
    await callerBegins();
    mockWorld.hideLiveOnce = true;
    await expect(
      raiseWithin(conn, { actor: actorOf(FAY), now: NOW, policyKey: "job.decision_pending", subjectId: "12", subjectType: "job", userTargets: [CAM.userId] }),
    ).rejects.toMatchObject({ number: 2601 });
  });

  it("hands back the live escalation, unchanged and not announced, when the subject already has one", async () => {
    const first = await askForDecision();
    jest.mocked(notifyTargets).mockClear();
    ledger.mockClear();
    events.length = 0;

    const second = await raiseWithin(conn, { actor: actorOf(FAY), now: NOW, policyKey: "job.decision_pending", subjectId: "12", subjectType: "job", userTargets: [DEE.userId] });
    const announced = await second.announce();

    expect(second.created).toBe(false);
    expect(second.escalation.escalationId).toBe(first.escalation.escalationId);
    expect(announced.escalationId).toBe(first.escalation.escalationId);
    expect(ledger).not.toHaveBeenCalled();
    expect(notifyTargets).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it("refuses what raise refuses: an unknown or switched-off policy, a missing subject", async () => {
    await expect(raiseWithin(conn, { actor: actorOf(FAY), policyKey: "nope", subjectId: "12", subjectType: "job" })).rejects.toMatchObject({ code: "unknown_policy" });
    await expect(raiseWithin(conn, { actor: actorOf(FAY), policyKey: "off.policy", subjectId: "12", subjectType: "job" })).rejects.toMatchObject({ code: "policy_inactive" });
    await expect(raiseWithin(conn, { actor: actorOf(FAY), policyKey: "job.decision_pending", subjectId: "404", subjectType: "job", userTargets: [CAM.userId] })).rejects.toMatchObject({
      code: "subject_not_found",
    });
  });
});

describe("a decision request's escalation is answered, not acknowledged or withdrawn from the inbox", () => {
  it("refuses to acknowledge it, changing nothing and writing no ledger row", async () => {
    const { escalation } = await askForDecision();
    ledger.mockClear();

    await expect(acknowledge(conn, { actor: actorOf(CAM), escalationId: escalation.escalationId })).rejects.toMatchObject({ code: "bad_request", status: 400 });

    expect(rowOf(escalation.escalationId)).toMatchObject({ acknowledgedAt: null, status: "open" });
    expect(ledger).not.toHaveBeenCalled();
  });

  it("refuses the generic withdraw, which would leave the request pending with nothing chasing it", async () => {
    const { escalation } = await askForDecision();
    ledger.mockClear();

    await expect(withdraw(conn, { actor: actorOf(FAY), escalationId: escalation.escalationId, reason: "not needed" })).rejects.toMatchObject({
      code: "bad_request",
      message: expect.stringContaining("withdrawn from the request itself"),
    });

    expect(rowOf(escalation.escalationId).status).toBe("open");
    expect(ledger).not.toHaveBeenCalled();
  });

  it("still lets the raiser withdraw an ordinary escalation", async () => {
    const { escalation } = await raiseManual();
    const done = await withdraw(conn, { actor: actorOf(FAY), escalationId: escalation.escalationId, reason: "sorted" });
    expect(done.status).toBe("withdrawn");
  });

  it("can't be resolved from the inbox either: it is an authority escalation", async () => {
    const { escalation } = await askForDecision();
    await expect(resolve(conn, { actor: actorOf(CAM), escalationId: escalation.escalationId })).rejects.toMatchObject({ code: "authority_resolve" });
  });
});

describe("withdrawWithin: the request's own domain ends the escalation", () => {
  it("ends it, at any level and even if somebody had acknowledged it, with the reason and the caller's correlation id", async () => {
    const { escalation } = await askForDecision();
    // an old row somebody acknowledged (acknowledge is refused now, so set it as the data would be)
    const stored = rowOf(escalation.escalationId);
    stored.status = "acknowledged";
    stored.acknowledgedByName = "Cam";
    stored.acknowledgedByUserId = CAM.userId;
    db.commitTransaction.mockClear();
    await db.beginTransaction({} as never);
    events.length = 0;
    ledger.mockClear();

    const done = await withdrawWithin(conn, { actor: actorOf(FAY), correlationId: GUID, escalationId: escalation.escalationId, now: NOW, reason: "Raised on the wrong job" });

    expect(done).toMatchObject({ resolutionCode: "withdrawn", resolutionNote: "Raised on the wrong job", status: "withdrawn" });
    expect(events).toEqual(["onChange", "ledger"]);
    expect(ledgerCalls()[0]).toMatchObject({ action: "escalation.withdraw", correlationId: GUID, jobId: 12, reason: "Raised on the wrong job" });
    expect(db.commitTransaction).not.toHaveBeenCalled();
  });

  it("needs a reason, before it touches anything", async () => {
    const { escalation } = await askForDecision();
    ledger.mockClear();
    await expect(withdrawWithin(conn, { actor: actorOf(FAY), escalationId: escalation.escalationId, reason: "  " })).rejects.toMatchObject({ code: "reason_required" });
    expect(rowOf(escalation.escalationId).status).toBe("open");
    expect(ledger).not.toHaveBeenCalled();
  });

  it("refuses a row that has already ended", async () => {
    const { escalation } = await askForDecision();
    await withdrawWithin(conn, { actor: actorOf(FAY), escalationId: escalation.escalationId, reason: "first" });
    await expect(withdrawWithin(conn, { actor: actorOf(FAY), escalationId: escalation.escalationId, reason: "again" })).rejects.toMatchObject({ code: "not_live", status: 409 });
  });

  it("rolls back with the caller's writes when the ledger fails", async () => {
    const { escalation } = await askForDecision();
    await db.beginTransaction({} as never);
    ledger.mockRejectedValueOnce(new Error("ledger unavailable"));

    await expect(withdrawWithin(conn, { actor: actorOf(FAY), escalationId: escalation.escalationId, reason: "x" })).rejects.toThrow("ledger unavailable");
    await db.rollbackTransaction({} as never);

    expect(rowOf(escalation.escalationId).status).toBe("open");
  });
});

// ── Answering a request, and handing a step on (jobs plan A2) ────────────────

const ALANA = user(9, "Alana", "accounts");
const GUS = user(10, "Gus", "accounts");
const ELI = user(6, "Eli", "director");

describe("resolveWithin: the request's own domain answers the escalation", () => {
  const answer = (escalationId: number, over: Partial<Parameters<typeof resolveWithin>[1]> = {}) =>
    resolveWithin(conn, { actor: actorOf(CAM), correlationId: GUID, escalationId, note: "The invoice is a duplicate.", now: NOW, resolutionCode: "deny", ...over });

  it("ends it as resolved with the domain's code and note, on the caller's transaction, and writes its ledger row under the caller's correlation id", async () => {
    const { escalation } = await askForDecision();
    await db.beginTransaction({} as never);
    events.length = 0;
    db.commitTransaction.mockClear();
    ledger.mockClear();

    const done = await answer(escalation.escalationId);

    expect(done).toMatchObject({
      resolutionCode: "deny",
      resolutionNote: "The invoice is a duplicate.",
      resolvedAt: NOW,
      resolvedByName: "Cam",
      resolvedByUserId: CAM.userId,
      status: "resolved",
    });
    expect(events).toEqual(["onChange", "ledger"]);
    expect(ledgerCalls()[0]).toMatchObject({
      action: "escalation.resolve",
      after: { resolutionCode: "deny", status: "resolved" },
      before: { status: "open" },
      correlationId: GUID,
      jobId: 12,
      reason: "The invoice is a duplicate.",
    });
    expect(db.commitTransaction).not.toHaveBeenCalled();
  });

  it("ends an authority escalation, which resolve refuses: it ends with the decision, and this is the decision", async () => {
    const { escalation } = await askForDecision();
    await expect(resolve(conn, { actor: actorOf(CAM), escalationId: escalation.escalationId })).rejects.toMatchObject({ code: "authority_resolve" });

    expect((await answer(escalation.escalationId)).status).toBe("resolved");
  });

  it("emails no one: the person who asked is told in the app, by the row ending, not by mail", async () => {
    const { escalation } = await askForDecision();
    jest.mocked(notifyRaiserResolved).mockClear();
    jest.mocked(notifyTargets).mockClear();

    await answer(escalation.escalationId);

    expect(notifyRaiserResolved).not.toHaveBeenCalled();
    expect(notifyTargets).not.toHaveBeenCalled();
    expect(notifyPreviousLevel).not.toHaveBeenCalled();
  });

  it("does not claim the row for the person who answered: they were never its target", async () => {
    const { escalation } = await askForDecision();
    await answer(escalation.escalationId);
    expect(rowOf(escalation.escalationId)).toMatchObject({ acknowledgedAt: null, acknowledgedByUserId: null, targetUserId: null });
  });

  it("ends it at any level, and even if somebody had acknowledged it", async () => {
    const { escalation } = await askForDecision();
    Object.assign(rowOf(escalation.escalationId), { acknowledgedByUserId: CAM.userId, status: "acknowledged" });
    expect((await answer(escalation.escalationId)).status).toBe("resolved");

    mockWorld.rows.clear();
    mockWorld.users = [ADAM, BEA, CAM, DEE, FAY, ALANA];
    const first = await askForDecision({ actor: actorOf(ALANA) });
    const { next } = await escalateFurther(conn, { actor: SWEEP_ACTOR, escalationId: first.escalation.escalationId, mode: "next_level", now: NOW, onlyIfOpen: true });
    expect(next.level).toBe(2);
    expect((await answer(next.escalationId)).status).toBe("resolved");
  });

  it("takes a code of 1 to 32 characters, and says so before it touches anything", async () => {
    const { escalation } = await askForDecision();
    ledger.mockClear();
    for (const resolutionCode of ["", "   ", "x".repeat(33)]) {
      await expect(answer(escalation.escalationId, { resolutionCode })).rejects.toMatchObject({ code: "bad_request", message: "resolutionCode must be 1 to 32 characters" });
    }
    expect((await answer(escalation.escalationId, { resolutionCode: "x".repeat(32) })).resolutionCode).toBe("x".repeat(32));
    expect(rowOf(escalation.escalationId).status).toBe("resolved");
  });

  it("takes no note, a trimmed one, and refuses one too long for the column", async () => {
    const { escalation } = await askForDecision();
    await expect(answer(escalation.escalationId, { note: "n".repeat(2001) })).rejects.toMatchObject({ code: "bad_request" });
    expect(rowOf(escalation.escalationId).status).toBe("open");
    const done = await answer(escalation.escalationId, { note: undefined });
    expect(done.resolutionNote).toBeNull();
  });

  it("refuses a row that has already ended (409), and one that is not there (404)", async () => {
    const { escalation } = await askForDecision();
    await answer(escalation.escalationId);
    await expect(answer(escalation.escalationId)).rejects.toMatchObject({ code: "not_live", status: 409 });
    await expect(answer(9999)).rejects.toMatchObject({ code: "not_found", status: 404 });
  });

  it("is a 409 on a stale version, changing nothing", async () => {
    const { escalation } = await askForDecision();
    ledger.mockClear();
    await expect(answer(escalation.escalationId, { expectedRowVersion: "stale" })).rejects.toMatchObject({ code: "stale", status: 409 });
    expect(rowOf(escalation.escalationId).status).toBe("open");
    expect(ledger).not.toHaveBeenCalled();
  });

  it("rolls back with the caller's writes when the ledger fails", async () => {
    const { escalation } = await askForDecision();
    await db.beginTransaction({} as never);
    ledger.mockRejectedValueOnce(new Error("ledger unavailable"));

    await expect(answer(escalation.escalationId)).rejects.toThrow("ledger unavailable");
    await db.rollbackTransaction({} as never);

    expect(rowOf(escalation.escalationId)).toMatchObject({ resolutionCode: null, status: "open" });
  });
});

describe("a next step is chased through its owner's manager", () => {
  beforeEach(() => {
    mockWorld.users = [ADAM, BEA, CAM, DEE, FAY, ALANA, GUS];
  });

  const handOn = (over: Partial<Parameters<typeof raise>[1]> = {}) =>
    raiseWithin(conn, {
      actor: actorOf(DEE),
      ladderRaiser: { role: "accounts", userId: ALANA.userId },
      now: NOW,
      policyKey: "job.next_step",
      subjectId: "12",
      subjectType: "job",
      userTargets: [ALANA.userId],
      ...over,
    });

  it("goes to the owner, raised by whoever handed it on, with whose ladder it is kept in its context", async () => {
    const { created, escalation } = await handOn();

    expect(created).toBe(true);
    expect(escalation).toMatchObject({
      kind: "attention",
      level: 1,
      noIndependentTarget: false,
      raisedByName: "Dee",
      raisedByUserId: DEE.userId,
      targetRole: "accounts",
      targetUserId: ALANA.userId,
    });
    expect(escalation.context).toMatchObject({ ladder: { role: "accounts", userId: ALANA.userId }, userTargets: [ALANA.userId] });
  });

  it("moves up to the OWNER's manager, then to a director: not to the manager of whoever handed it on", async () => {
    const { escalation } = await handOn();

    const second = await escalateFurther(conn, { actor: SWEEP_ACTOR, escalationId: escalation.escalationId, mode: "next_level", now: NOW, onlyIfOpen: true });
    expect(second.next).toMatchObject({ level: 2, parentEscalationId: escalation.escalationId, targetRole: "accounts_manager" });
    expect(second.next.context).toMatchObject({ ladder: { role: "accounts", userId: ALANA.userId } });

    const third = await escalateFurther(conn, { actor: SWEEP_ACTOR, escalationId: second.next.escalationId, mode: "next_level", now: NOW, onlyIfOpen: true });
    expect(third.next).toMatchObject({ level: 3, targetRole: "director" });
  });

  it("would have moved up to the other directors, and never to Alana's accounts manager, without it: the control", async () => {
    mockWorld.users = [ADAM, BEA, CAM, DEE, ELI, FAY, ALANA, GUS];
    const { escalation } = await handOn({ ladderRaiser: undefined });

    const second = await escalateFurther(conn, { actor: SWEEP_ACTOR, escalationId: escalation.escalationId, mode: "next_level", now: NOW, onlyIfOpen: true });
    // Dee is the raiser, so her "manager" is the other directors.
    expect(second.next).toMatchObject({ level: 2, targetRole: "director" });
    expect(second.next.context).not.toHaveProperty("ladder");
  });

  it("has nowhere to move up to for a lone director's step without it: no one independent of the raiser", async () => {
    const { escalation } = await handOn({ ladderRaiser: undefined });
    await expect(escalateFurther(conn, { actor: SWEEP_ACTOR, escalationId: escalation.escalationId, mode: "next_level", now: NOW, onlyIfOpen: true })).rejects.toMatchObject({
      code: "no_further_level",
    });
  });

  it("can be handed to the person handing it on: a decision-maker who will do it themselves", async () => {
    const { escalation } = await handOn({ ladderRaiser: { role: "director", userId: DEE.userId }, userTargets: [DEE.userId] });
    expect(escalation).toMatchObject({ level: 1, targetRole: "director", targetUserId: DEE.userId });
  });

  it("is handed to everyone in a role when the step is a role's: no one person, and the role's own manager above them", async () => {
    const { escalation } = await handOn({ ladderRaiser: { role: "accounts", userId: null }, userTargets: [ALANA.userId, GUS.userId] });
    expect(escalation).toMatchObject({ level: 1, targetRole: null, targetUserId: null });
    expect(escalation.context).toMatchObject({ ladder: { role: "accounts", userId: null }, userTargets: [9, 10] });

    const up = await escalateFurther(conn, { actor: SWEEP_ACTOR, escalationId: escalation.escalationId, mode: "next_level", now: NOW, onlyIfOpen: true });
    expect(up.next.targetRole).toBe("accounts_manager");
  });

  it("is chased by the policy's SLA at the manager's level, and by the caller's moment at the owner's", async () => {
    const due = new Date("2026-10-20T07:00:00Z");
    const { escalation } = await handOn({ dueAt: due });
    expect(escalation.dueAt?.toISOString()).toBe(due.toISOString());

    const { next } = await escalateFurther(conn, { actor: SWEEP_ACTOR, escalationId: escalation.escalationId, mode: "next_level", now: NOW, onlyIfOpen: true });
    expect(next.dueAt?.toISOString()).toBe("2026-10-13T23:30:00.000Z"); // 16 business hours from Monday 09:00 Darwin end Wednesday 09:00
  });

  it("keeps no ladder in the context when none was given, or a blank role", async () => {
    const plain = await handOn({ ladderRaiser: undefined });
    expect(plain.escalation.context).not.toHaveProperty("ladder");
    mockWorld.rows.clear();
    const blank = await handOn({ ladderRaiser: { role: "  ", userId: null } });
    expect(blank.escalation.context).not.toHaveProperty("ladder");
  });
});

describe("a next step is done on the job, not claimed, resolved or withdrawn from the inbox", () => {
  beforeEach(() => {
    mockWorld.users = [ADAM, BEA, CAM, DEE, FAY, ALANA];
  });

  const handedOn = () =>
    raise(conn, {
      actor: actorOf(DEE),
      ladderRaiser: { role: "accounts", userId: ALANA.userId },
      now: NOW,
      policyKey: "job.next_step",
      skipConditionCheck: true,
      subjectId: "12",
      subjectType: "job",
      userTargets: [ALANA.userId],
    });

  it("refuses to acknowledge it: claiming it would stop it moving up while nobody had done anything", async () => {
    const { escalation } = await handedOn();
    ledger.mockClear();

    await expect(acknowledge(conn, { actor: actorOf(ALANA), escalationId: escalation.escalationId })).rejects.toMatchObject({
      code: "bad_request",
      message: "A next step is done, not acknowledged. Open the job and mark it done.",
    });

    expect(rowOf(escalation.escalationId)).toMatchObject({ acknowledgedAt: null, status: "open" });
    expect(ledger).not.toHaveBeenCalled();
  });

  it("refuses to resolve it, pointing at the job, though it is an attention escalation", async () => {
    const { escalation } = await handedOn();
    ledger.mockClear();

    await expect(resolve(conn, { actor: actorOf(ALANA), escalationId: escalation.escalationId, resolutionCode: "action_taken" })).rejects.toMatchObject({
      code: "authority_resolve",
      details: { deepLink: "/jobs?jobId=12", subjectId: "12", subjectType: "job" },
      message: expect.stringContaining("mark the step done"),
      status: 422,
    });

    expect(rowOf(escalation.escalationId).status).toBe("open");
    expect(ledger).not.toHaveBeenCalled();
  });

  it("refuses the generic withdraw, which would end the chase with the step still open", async () => {
    const { escalation } = await handedOn();
    ledger.mockClear();

    await expect(withdraw(conn, { actor: actorOf(DEE), escalationId: escalation.escalationId, reason: "not needed" })).rejects.toMatchObject({
      code: "bad_request",
      message: expect.stringContaining("done from the job"),
    });

    expect(rowOf(escalation.escalationId).status).toBe("open");
    expect(ledger).not.toHaveBeenCalled();
  });

  it("still lets the step's own domain end it, by resolving or withdrawing it within its transaction", async () => {
    const first = await handedOn();
    expect((await resolveWithin(conn, { actor: actorOf(ALANA), escalationId: first.escalation.escalationId, resolutionCode: "next_step_done" })).status).toBe("resolved");

    mockWorld.rows.clear();
    const second = await handedOn();
    expect((await withdrawWithin(conn, { actor: actorOf(DEE), escalationId: second.escalation.escalationId, reason: "Replaced by a later decision" })).status).toBe("withdrawn");
  });

  it("is still tidied up by the sweep when its step is no longer open (condition cleared)", async () => {
    const { escalation } = await handedOn();
    const done = await autoResolve(conn, { escalationId: escalation.escalationId, now: NOW });
    expect(done).toMatchObject({ resolutionCode: "condition_cleared", status: "withdrawn" });
  });

  it("can still be pushed further up by its owner", async () => {
    const { escalation } = await handedOn();
    const { next } = await escalateFurther(conn, { actor: actorOf(ALANA), escalationId: escalation.escalationId, mode: "next_level", now: NOW, note: "I need a decision from Accounts" });
    expect(next).toMatchObject({ level: 2, targetRole: "accounts_manager" });
  });

  it("asks the job adapter whether the step is still open when it is raised, unless the caller just checked", async () => {
    jobAdapter.isConditionActive.mockResolvedValue(false);
    await expect(
      raise(conn, { actor: actorOf(DEE), now: NOW, policyKey: "job.next_step", subjectId: "12", subjectType: "job", userTargets: [ALANA.userId] }),
    ).rejects.toMatchObject({ code: "condition_not_met" });
    expect(jobAdapter.isConditionActive).toHaveBeenCalledWith(conn, { policyKey: "job.next_step", subjectId: "12", subjectType: "job" }, NOW);
  });
});
