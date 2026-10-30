/// <reference types="jest" />
// The sweep against a small in-memory world: jobs, escalations and emails live in
// arrays, and the engine calls the sweep makes (raise, escalateFurther,
// autoResolve) change those arrays the way the real ones change the database.
// That lets these tests run the sweep more than once and check it settles.
import type { Connection } from "tedious";
import { EscalationError } from "./errors";
import { SWEEP_ACTOR } from "./engine";
import { jobConditionActive, type JobFacts } from "./adapters/jobRules";
import type { EscalationAdapter } from "./adapters/registry";
import { NO_HOLIDAYS } from "./businessTime";
import { MAX_NOTIFICATION_ATTEMPTS } from "./config";
import type { DueDeferral } from "../jobDecisions/decisionsStore";
import type { ReaskOptions, ReaskResult } from "../jobDecisions/reask";
import { followUpSince, runSweep, type SweepDeps, type SweepOptions, type SweepReport } from "./sweep";
import { latestKey, type LatestEscalationTimes } from "./store";
import type { EscalationPolicy, EscalationRow } from "./types";

const conn = {} as Connection;

// Tuesday 2026-10-13, 12:00 Darwin
const NOW = new Date(Date.UTC(2026, 9, 13, 12, 0) - 9.5 * 3_600_000);
const ago = (hours: number, from: Date = NOW): Date => new Date(from.getTime() - hours * 3_600_000);
const DAY = 24;

const ENV = {
  APP_BASE_URL: "https://floorplan.example",
  GRAPH_CLIENT_ID: "id",
  GRAPH_CLIENT_SECRET: "secret",
  GRAPH_SENDER_EMAIL: "floorplan@example.com",
  GRAPH_TENANT_ID: "tenant",
} as NodeJS.ProcessEnv;

function job(over: Partial<JobFacts> = {}): JobFacts {
  return {
    acknowledgedAt: null,
    assigned: true,
    assignedTo: "Fay",
    buildingId: 5,
    buildingName: "Tower A",
    createdAt: ago(40 * DAY),
    expectedProgressUpdate: null,
    firstQuoteRequestAt: null,
    isArchived: false,
    jobId: 1,
    kind: "facilities",
    oldestPendingInvoiceAt: null,
    pendingInvoices: 0,
    priority: "Normal",
    quoteCount: 0,
    requestedContractors: 0,
    status: "Work",
    statusSince: ago(1 * DAY),
    title: "Leaking roof",
    ...over,
  };
}

function policy(key: string, over: Partial<EscalationPolicy> = {}): EscalationPolicy {
  return {
    active: true,
    autoReescalate: "yes",
    clock: "business",
    kind: "attention",
    ladder: [{ role: "facilities_manager", slaHours: 16 }, { role: "director", slaHours: 16 }],
    policyKey: key,
    updatedAt: null,
    updatedBy: null,
    urgent: false,
    ...over,
  };
}

let nextId = 1;
function esc(over: Partial<EscalationRow> = {}): EscalationRow {
  const id = nextId++;
  return {
    acknowledgedAt: null,
    acknowledgedByName: null,
    acknowledgedByUserId: null,
    buildingId: 5,
    context: null,
    createdAt: ago(48),
    dueAt: ago(1),
    escalationId: id,
    kind: "attention",
    lastFollowUpAt: null,
    lastNotificationAttemptAt: ago(47),
    lastNotificationError: null,
    lastNotifiedAt: ago(47),
    level: 1,
    noIndependentTarget: false,
    note: null,
    notificationAttempts: 1,
    notificationState: "sent",
    parentEscalationId: null,
    policyKey: "job.stalled_unacknowledged",
    raisedByKind: "system",
    raisedByName: "Floorplan",
    raisedByUserId: null,
    reason: null,
    resolutionCode: null,
    resolutionNote: null,
    resolvedAt: null,
    resolvedByName: null,
    resolvedByUserId: null,
    rowVersion: `v${id}`,
    status: "open",
    subjectId: "1",
    subjectType: "job",
    summary: "Job #1",
    targetRole: "facilities_manager",
    targetUserId: null,
    updatedAt: ago(48),
    urgent: false,
    ...over,
  };
}

interface World {
  arrivals: Map<number, Date>;
  calls: {
    autoResolve: Parameters<SweepDeps["autoResolve"]>[1][];
    escalateFurther: Parameters<SweepDeps["escalateFurther"]>[1][];
    notify: { event: string; id: number }[];
    raise: Parameters<SweepDeps["raise"]>[1][];
    reask: { deferral: DueDeferral; options: ReaskOptions }[];
  };
  /** Deferred decisions not yet asked again (what the database would list as due). */
  deferrals: DueDeferral[];
  deps: SweepDeps;
  exhausted: number;
  jobs: JobFacts[];
  policies: Record<string, EscalationPolicy>;
  rows: EscalationRow[];
}

const live = (row: EscalationRow): boolean => row.status === "open" || row.status === "acknowledged";

function makeWorld(): World {
  const world: World = {
    arrivals: new Map(),
    calls: { autoResolve: [], escalateFurther: [], notify: [], raise: [], reask: [] },
    deferrals: [],
    deps: undefined as unknown as SweepDeps,
    exhausted: 0,
    jobs: [],
    policies: {
      "job.invoice_waiting": policy("job.invoice_waiting"),
      "job.past_due": policy("job.past_due"),
      "job.quote_not_back": policy("job.quote_not_back"),
      "job.stalled_unacknowledged": policy("job.stalled_unacknowledged"),
      "job.unassigned": policy("job.unassigned", { ladder: [{ role: "facilities_manager", slaHours: 8 }, { role: "director", slaHours: 16 }] }),
      "system.health": policy("system.health", { autoReescalate: "no", ladder: [{ role: "admin" }] }),
    },
    rows: [],
  };

  const jobAdapter: EscalationAdapter = {
    deepLink: (id) => `/jobs?jobId=${id}`,
    isConditionActive: async (_c, ref, now) => {
      const found = world.jobs.find((j) => String(j.jobId) === ref.subjectId);
      return found ? jobConditionActive(ref.policyKey, found, { env: ENV, holidays: NO_HOLIDAYS, now }) : false;
    },
    loadSummary: async () => null,
    subjectType: "job",
    visibleTo: () => true,
  };
  const systemAdapter: EscalationAdapter = {
    deepLink: () => "/escalations",
    isConditionActive: async () => true,
    loadSummary: async () => null,
    subjectType: "system",
    visibleTo: () => true,
  };

  world.deps = {
    autoResolve: async (_c, input) => {
      world.calls.autoResolve.push(input);
      const row = world.rows.find((r) => r.escalationId === input.escalationId);
      if (!row || !live(row)) throw new EscalationError("not_live", "gone");
      row.status = row.status === "open" ? "withdrawn" : "resolved";
      row.resolutionCode = "condition_cleared";
      row.resolvedAt = input.now ?? NOW;
      return { ...row };
    },
    countExhaustedNotifications: async () => world.exhausted,
    escalateFurther: async (_c, input) => {
      world.calls.escalateFurther.push(input);
      const old = world.rows.find((r) => r.escalationId === input.escalationId);
      if (!old || !live(old)) throw new EscalationError("not_live", "gone");
      if (input.onlyIfOpen && old.status !== "open") throw new EscalationError("not_live", "acknowledged");
      old.status = "superseded";
      old.resolutionCode = input.code ?? "escalated";
      old.resolvedAt = input.now ?? NOW;
      const next = esc({
        ...old,
        createdAt: input.now ?? NOW,
        dueAt: ago(-16, input.now ?? NOW),
        lastFollowUpAt: input.code === "follow_up" ? (input.now ?? NOW) : null,
        lastNotifiedAt: input.now ?? NOW,
        level: input.mode === "next_level" ? old.level + 1 : old.level,
        notificationState: "sent",
        parentEscalationId: old.escalationId,
        resolutionCode: null,
        resolvedAt: null,
        status: "open",
        targetRole: input.mode === "next_level" ? "director" : old.targetRole,
      });
      world.rows.push(next);
      return { next: { ...next }, previous: { ...old } };
    },
    getAdapter: (type) => (type === "job" ? jobAdapter : type === "system" ? systemAdapter : null),
    getPolicy: async (_c, key) => world.policies[key] ?? null,
    hasNextLevel: async (_c, row) => row.level < 2,
    latestEmailArrivals: async (_c, ids) => new Map([...world.arrivals].filter(([id]) => ids.includes(id))),
    latestTimesBySubject: async (_c, subjectType) => {
      const map = new Map<string, LatestEscalationTimes>();
      for (const r of world.rows.filter((x) => x.subjectType === subjectType)) {
        const key = latestKey(r.subjectId, r.policyKey);
        const prev = map.get(key);
        map.set(key, {
          lastCreatedAt: !prev || r.createdAt > prev.lastCreatedAt ? r.createdAt : prev.lastCreatedAt,
          lastEndedAt: r.resolvedAt && (!prev?.lastEndedAt || r.resolvedAt > prev.lastEndedAt) ? r.resolvedAt : (prev?.lastEndedAt ?? null),
        });
      }
      return map;
    },
    listDueDeferrals: async () => world.deferrals.map((d) => ({ ...d })),
    listLiveEscalations: async () => world.rows.filter(live).map((r) => ({ ...r })),
    loadLiveJobFacts: async () => world.jobs.filter((j) => !j.isArchived && j.status !== "Done"),
    notifyTargets: async (_c, row, event) => {
      world.calls.notify.push({ event, id: row.escalationId });
      return { attempts: 1, error: null, recipients: [], state: "sent" };
    },
    raise: async (_c, input) => {
      world.calls.raise.push(input);
      const existing = world.rows.find((r) => live(r) && r.subjectType === input.subjectType && r.subjectId === input.subjectId && r.policyKey === input.policyKey);
      if (existing) return { created: false, escalation: { ...existing } };
      const row = esc({
        createdAt: input.now ?? NOW,
        dueAt: ago(-16, input.now ?? NOW),
        notificationState: "pending",
        notificationAttempts: 0,
        lastNotificationAttemptAt: null,
        lastNotifiedAt: null,
        policyKey: input.policyKey,
        subjectId: input.subjectId,
        subjectType: input.subjectType,
        summary: input.summary ?? `${input.subjectType} ${input.subjectId} — ${input.headline ?? ""}`,
        targetRole: input.policyKey === "system.health" ? "admin" : "facilities_manager",
      });
      world.rows.push(row);
      return { created: true, escalation: { ...row } };
    },
    // Like the real one: asking again stamps the deferral, so it is not due any more.
    reaskDeferral: async (_c, deferral, options): Promise<ReaskResult> => {
      world.calls.reask.push({ deferral, options });
      world.deferrals = world.deferrals.filter((d) => d.decisionId !== deferral.decisionId);
      return "asked";
    },
  };
  return world;
}

function sweep(world: World, over: Partial<SweepOptions> = {}): Promise<SweepReport> {
  const log = jest.fn();
  const warn = jest.fn();
  return runSweep(conn, { dryRun: false, env: ENV, log, now: NOW, warn, ...over }, world.deps);
}

const raisedKeys = (world: World): string[] => world.calls.raise.map((c) => `${c.policyKey}:${c.subjectId}`);

beforeEach(() => {
  nextId = 1;
});

// ── Raising for jobs ─────────────────────────────────────────────────────────

describe("job policies", () => {
  it("raises job.stalled_unacknowledged for an assigned job past its priority threshold, and says so", async () => {
    const world = makeWorld();
    world.jobs = [job({ jobId: 1, priority: "Normal", statusSince: ago(9 * DAY) }), job({ jobId: 2, priority: "Normal", statusSince: ago(3 * DAY) })];

    const report = await sweep(world);

    expect(raisedKeys(world)).toEqual(["job.stalled_unacknowledged:1"]);
    expect(report.raised).toBe(1);
    expect(world.calls.raise[0]).toMatchObject({
      actor: SWEEP_ACTOR,
      headline: "Stalled: no acknowledgement or update for 9 days",
      skipConditionCheck: true,
      subjectType: "job",
    });
  });

  it("uses today's per-priority thresholds: a Critical job stalls after 2 days, a Low one after 14", async () => {
    const world = makeWorld();
    world.jobs = [
      job({ jobId: 1, priority: "Critical", statusSince: ago(3 * DAY) }),
      job({ jobId: 2, priority: "Low", statusSince: ago(3 * DAY) }),
      job({ jobId: 3, priority: "Low", statusSince: ago(15 * DAY) }),
    ];

    await sweep(world);

    expect(raisedKeys(world).sort()).toEqual(["job.stalled_unacknowledged:1", "job.stalled_unacknowledged:3"]);
  });

  it("escalates a live unassigned job as 'needs an owner' (F18a)", async () => {
    const world = makeWorld();
    world.jobs = [job({ assigned: false, createdAt: ago(3 * DAY), jobId: 5, statusSince: ago(3 * DAY) })];

    await sweep(world);

    expect(raisedKeys(world)).toEqual(["job.unassigned:5"]);
    expect(world.calls.raise[0]?.headline).toBe("Needs an owner: no one is assigned");
  });

  it("raises job.quote_not_back, with the shorter wait for Critical and High", async () => {
    const world = makeWorld();
    world.jobs = [
      job({ firstQuoteRequestAt: ago(2 * DAY), jobId: 1, requestedContractors: 1, status: "Quote" }),
      job({ firstQuoteRequestAt: ago(2 * DAY), jobId: 2, priority: "High", requestedContractors: 1, status: "Quote" }),
      job({ firstQuoteRequestAt: ago(10 * DAY), jobId: 3, quoteCount: 1, requestedContractors: 1, status: "Quote" }),
    ];
    // Tuesday 12:00; 24 business hours back from now is well before 2 calendar days ago on a Tuesday.
    world.jobs[0].firstQuoteRequestAt = ago(5 * DAY);

    await sweep(world);

    expect(raisedKeys(world).sort()).toEqual(["job.quote_not_back:1", "job.quote_not_back:2"]);
  });

  it("raises job.invoice_waiting and job.past_due", async () => {
    const world = makeWorld();
    world.jobs = [
      job({ jobId: 1, oldestPendingInvoiceAt: ago(9 * DAY), pendingInvoices: 1, status: "Awaiting Approval" }),
      job({ expectedProgressUpdate: ago(3 * DAY), jobId: 2 }),
    ];

    await sweep(world);

    expect(raisedKeys(world).sort()).toEqual(["job.invoice_waiting:1", "job.past_due:2"]);
  });

  it("leaves a job alone that already has a live escalation for the policy", async () => {
    const world = makeWorld();
    world.jobs = [job({ statusSince: ago(9 * DAY) })];
    world.rows = [esc({ createdAt: ago(1 * DAY), dueAt: ago(-5) })];

    const report = await sweep(world);

    expect(world.calls.raise).toEqual([]);
    expect(report.raised).toBe(0);
  });

  it("doesn't raise a switched-off policy", async () => {
    const world = makeWorld();
    world.policies["job.unassigned"] = policy("job.unassigned", { active: false });
    world.jobs = [job({ assigned: false, createdAt: ago(3 * DAY) })];

    await sweep(world);

    expect(world.calls.raise).toEqual([]);
  });

  it("leaves job.past_due alone while it is seeded off, whatever the jobs look like, and says so in a dry run", async () => {
    const world = makeWorld();
    world.policies["job.past_due"] = policy("job.past_due", { active: false });
    world.jobs = [job({ expectedProgressUpdate: ago(5 * DAY), jobId: 1, statusSince: ago(1 * DAY) }), job({ expectedProgressUpdate: ago(30 * DAY), jobId: 2, statusSince: ago(1 * DAY) })];

    const live = await sweep(world);
    expect(world.calls.raise).toEqual([]);
    expect(live.raised).toBe(0);

    const log = jest.fn();
    const dry = await sweep(world, { dryRun: true, log });
    expect(dry.raised).toBe(0);
    expect(log).toHaveBeenCalledWith("escalationSweep: job.past_due is switched off (Active = 0), so it is skipped");
  });

  it("switches job.past_due on again when an admin sets it active", async () => {
    const world = makeWorld();
    world.policies["job.past_due"] = policy("job.past_due", { active: true });
    world.jobs = [job({ expectedProgressUpdate: ago(5 * DAY), jobId: 1, statusSince: ago(1 * DAY) })];

    await sweep(world);

    expect(raisedKeys(world)).toEqual(["job.past_due:1"]);
  });

  it("still ends an existing past-due escalation when its condition clears, even with the policy off", async () => {
    const world = makeWorld();
    world.policies["job.past_due"] = policy("job.past_due", { active: false });
    world.jobs = [job({ expectedProgressUpdate: ago(-3 * DAY), jobId: 1, statusSince: ago(1 * DAY) })];
    world.rows = [esc({ dueAt: ago(-5), policyKey: "job.past_due" })];

    await sweep(world);

    expect(world.calls.autoResolve).toHaveLength(1);
  });

  it("works without any PLANNER_* setting or FACILITIES_MANAGER_EMAILS, which it never reads", async () => {
    const world = makeWorld();
    world.jobs = [job({ statusSince: ago(9 * DAY) })];

    const report = await sweep(world, { env: ENV });

    expect(report.raised).toBe(1);
    expect(Object.keys(ENV).some((k) => k.startsWith("PLANNER_"))).toBe(false);
  });

  it("keeps escalating when APP_BASE_URL is missing too, and says so to admin instead of skipping", async () => {
    const world = makeWorld();
    world.jobs = [job({ statusSince: ago(9 * DAY) }), job({ assigned: false, createdAt: ago(3 * DAY), jobId: 2 })];

    const report = await sweep(world, { env: { ...ENV, APP_BASE_URL: undefined } as NodeJS.ProcessEnv });

    expect(raisedKeys(world)).toEqual(
      expect.arrayContaining(["job.stalled_unacknowledged:1", "job.unassigned:2", "system.health:notification_config"]),
    );
    expect(report.errors).toEqual([]);
  });
});

describe("Admin / Accounts jobs (plan D2) are on none of the job policies", () => {
  // The same facts for every kind: a job stuck waiting on a quote and an invoice,
  // stalled and past its update date; and one nobody owns.
  const stuck = (jobId: number, kind: string): JobFacts =>
    job({
      expectedProgressUpdate: ago(5 * DAY),
      firstQuoteRequestAt: ago(10 * DAY),
      jobId,
      kind,
      oldestPendingInvoiceAt: ago(10 * DAY),
      pendingInvoices: 1,
      requestedContractors: 1,
      status: "Quote",
      statusSince: ago(30 * DAY),
    });
  const unowned = (jobId: number, kind: string): JobFacts =>
    job({ assigned: false, createdAt: ago(3 * DAY), jobId, kind, statusSince: ago(3 * DAY) });
  const raisedFor = (world: World, jobId: number): string[] =>
    world.calls.raise.filter((c) => c.subjectId === String(jobId)).map((c) => c.policyKey).sort();

  it("raises quote_not_back, invoice_waiting and the rest for facilities and maintenance jobs, and none of them for an admin job that qualifies for every one", async () => {
    const world = makeWorld();
    world.jobs = [stuck(1, "facilities"), stuck(2, "maintenance"), stuck(3, "admin"), unowned(4, "facilities"), unowned(5, "admin")];

    const report = await sweep(world);

    const WORK = ["job.invoice_waiting", "job.past_due", "job.quote_not_back", "job.stalled_unacknowledged"];
    expect(raisedFor(world, 1)).toEqual(WORK);
    expect(raisedFor(world, 2)).toEqual(WORK);
    expect(raisedFor(world, 4)).toEqual(["job.unassigned"]);
    expect(raisedFor(world, 3)).toEqual([]);
    expect(raisedFor(world, 5)).toEqual([]);
    expect(report.raised).toBe(9);
  });

  it("selects kinds by name: a job of a kind nobody listed is left alone too", async () => {
    const world = makeWorld();
    world.jobs = [stuck(6, "projects"), unowned(7, "projects")];

    await sweep(world);

    expect(world.calls.raise).toEqual([]);
  });

  it("ends a contractor-flow escalation an admin job already has, as cleared, and keeps the same one on a facilities job", async () => {
    const world = makeWorld();
    world.jobs = [stuck(3, "admin"), stuck(1, "facilities")];
    world.rows = [
      esc({ dueAt: ago(-5), policyKey: "job.quote_not_back", subjectId: "3" }),
      esc({ dueAt: ago(-5), policyKey: "job.quote_not_back", subjectId: "1" }),
    ];

    await sweep(world);

    expect(world.calls.autoResolve.map((c) => c.escalationId)).toEqual([1]);
    expect(world.rows[0]).toMatchObject({ resolutionCode: "condition_cleared", subjectId: "3" });
    expect(world.rows[1]).toMatchObject({ status: "open", subjectId: "1" });
  });

  it("still lets a person escalate an admin job by hand: job.manual follows the job being live, not its kind", async () => {
    const world = makeWorld();
    world.jobs = [stuck(3, "admin")];
    world.rows = [esc({ dueAt: ago(-5), policyKey: "job.manual", raisedByKind: "user", subjectId: "3" })];

    await sweep(world);

    expect(world.calls.autoResolve).toEqual([]);
    expect(world.rows[0].status).toBe("open");
  });
});

describe("what a person already dealt with isn't raised again", () => {
  it("skips a stretch of the condition an earlier escalation already covered", async () => {
    const world = makeWorld();
    const job1 = job({ expectedProgressUpdate: ago(5 * DAY) });
    world.jobs = [job1];
    // A manager resolved job.past_due two days ago; the due date hasn't moved.
    world.rows = [esc({ createdAt: ago(3 * DAY), policyKey: "job.past_due", resolvedAt: ago(2 * DAY), status: "resolved" })];

    const report = await sweep(world);

    expect(world.calls.raise).toEqual([]);
    expect(report.skippedAsHandled).toBe(1);
  });

  it("raises again once the condition's clock moves on (a new due date that has also passed)", async () => {
    const world = makeWorld();
    world.jobs = [job({ expectedProgressUpdate: ago(1 * DAY) })];
    world.rows = [esc({ createdAt: ago(3 * DAY), policyKey: "job.past_due", resolvedAt: ago(2 * DAY), status: "resolved" })];

    await sweep(world);

    expect(raisedKeys(world)).toEqual(["job.past_due:1"]);
  });

  it("raises a stalled job again when new mail about it arrived after the last escalation ended (follow-up)", async () => {
    const world = makeWorld();
    world.jobs = [job({ statusSince: ago(9 * DAY) })];
    world.rows = [esc({ createdAt: ago(5 * DAY), resolvedAt: ago(4 * DAY), status: "resolved" })];
    world.arrivals.set(1, ago(1 * DAY));

    const report = await sweep(world);

    expect(raisedKeys(world)).toEqual(["job.stalled_unacknowledged:1"]);
    expect(report.followUps).toBe(1);
  });

  it("doesn't raise a handled stalled job for mail that came before the escalation ended", async () => {
    const world = makeWorld();
    world.jobs = [job({ statusSince: ago(9 * DAY) })];
    world.rows = [esc({ createdAt: ago(5 * DAY), resolvedAt: ago(4 * DAY), status: "resolved" })];
    world.arrivals.set(1, ago(4.5 * DAY));

    const report = await sweep(world);

    expect(world.calls.raise).toEqual([]);
    expect(report.skippedAsHandled).toBe(1);
  });
});

// ── Cleared conditions ───────────────────────────────────────────────────────

describe("an attention escalation auto-resolves when its condition clears", () => {
  it("ends it, passing the version it read", async () => {
    const world = makeWorld();
    world.jobs = [job({ statusSince: ago(1 * DAY) })]; // no longer stalled
    world.rows = [esc({ dueAt: ago(-5) })];

    const report = await sweep(world);

    expect(world.calls.autoResolve).toEqual([{ escalationId: 1, expectedRowVersion: "v1", now: NOW }]);
    expect(world.rows[0]).toMatchObject({ resolutionCode: "condition_cleared", status: "withdrawn" });
    expect(report.autoResolved).toBe(1);
  });

  it("ends it when the job has gone, finished or been archived", async () => {
    const world = makeWorld();
    world.jobs = [job({ jobId: 2, status: "Done" })];
    world.rows = [esc({ dueAt: ago(-5), subjectId: "1" }), esc({ dueAt: ago(-5), subjectId: "2" })];

    await sweep(world);

    expect(world.calls.autoResolve.map((c) => c.escalationId).sort()).toEqual([1, 2]);
  });

  it("keeps it while the condition holds", async () => {
    const world = makeWorld();
    world.jobs = [job({ statusSince: ago(9 * DAY) })];
    world.rows = [esc({ dueAt: ago(-5) })];

    await sweep(world);

    expect(world.calls.autoResolve).toEqual([]);
    expect(world.rows[0].status).toBe("open");
  });

  it("never auto-resolves an authority escalation, which ends with the decision", async () => {
    const world = makeWorld();
    world.rows = [esc({ dueAt: ago(-5), kind: "authority", policyKey: "quote.over_limit", subjectId: "7", subjectType: "quote" })];

    await sweep(world);

    expect(world.calls.autoResolve).toEqual([]);
  });

  it("leaves a subject type with no adapter alone, and says so once", async () => {
    const world = makeWorld();
    world.rows = [esc({ dueAt: ago(-5), subjectId: "7", subjectType: "rent_review" }), esc({ dueAt: ago(-5), subjectId: "8", subjectType: "rent_review" })];
    const warn = jest.fn();

    await sweep(world, { warn });

    expect(world.calls.autoResolve).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"rent_review"'));
  });
});

// ── SLA ──────────────────────────────────────────────────────────────────────

describe("an unacknowledged escalation past its SLA is superseded by the next level", () => {
  const stalledJob = () => job({ statusSince: ago(9 * DAY) });

  it("moves an overdue open escalation up a level, as the sweep, with the SLA code", async () => {
    const world = makeWorld();
    world.jobs = [stalledJob()];
    world.rows = [esc({ dueAt: ago(1) })];

    const report = await sweep(world);

    expect(world.calls.escalateFurther).toHaveLength(1);
    expect(world.calls.escalateFurther[0]).toMatchObject({
      actor: SWEEP_ACTOR,
      code: "sla_breach",
      escalationId: 1,
      expectedRowVersion: "v1",
      mode: "next_level",
      now: NOW,
      onlyIfOpen: true,
    });
    expect(report.superseded).toBe(1);
    expect(world.rows[0].status).toBe("superseded");
    expect(world.rows[1]).toMatchObject({ level: 2, parentEscalationId: 1, status: "open", targetRole: "director" });
  });

  it("leaves it alone before its SLA, when acknowledged, or when it has no SLA", async () => {
    const world = makeWorld();
    world.jobs = [stalledJob(), job({ jobId: 2, statusSince: ago(9 * DAY) }), job({ jobId: 3, statusSince: ago(9 * DAY) })];
    world.rows = [
      esc({ dueAt: ago(-1), subjectId: "1" }),
      esc({ acknowledgedAt: ago(5), dueAt: ago(2), status: "acknowledged", subjectId: "2", targetUserId: 4 }),
      esc({ dueAt: null, subjectId: "3" }),
    ];

    await sweep(world);

    expect(world.calls.escalateFurther).toEqual([]);
  });

  it("repeats the level as a reminder at the top of the ladder", async () => {
    const world = makeWorld();
    world.jobs = [stalledJob()];
    world.rows = [esc({ dueAt: ago(1), level: 2, targetRole: "director" })];

    const report = await sweep(world);

    expect(world.calls.escalateFurther[0]).toMatchObject({ code: "reminder", mode: "same_level" });
    expect(report.reminded).toBe(1);
    expect(report.superseded).toBe(0);
  });

  it("repeats a reminder / nudge policy, and ignores a policy that doesn't auto-escalate", async () => {
    const world = makeWorld();
    world.jobs = [job({ jobId: 1, statusSince: ago(9 * DAY) }), job({ jobId: 2, expectedProgressUpdate: ago(3 * DAY) }), job({ assigned: false, createdAt: ago(3 * DAY), jobId: 3 })];
    world.policies["job.past_due"] = policy("job.past_due", { autoReescalate: "nudge" });
    world.policies["job.unassigned"] = policy("job.unassigned", { autoReescalate: "no" });
    world.rows = [
      esc({ dueAt: ago(1), subjectId: "1" }),
      esc({ dueAt: ago(1), policyKey: "job.past_due", subjectId: "2" }),
      esc({ dueAt: ago(1), policyKey: "job.unassigned", subjectId: "3" }),
    ];

    await sweep(world);

    const byId = Object.fromEntries(world.calls.escalateFurther.map((c) => [c.escalationId, c.mode]));
    expect(byId).toEqual({ 1: "next_level", 2: "same_level" });
  });

  it("treats a row someone just acknowledged as nothing to do, not an error", async () => {
    const world = makeWorld();
    world.jobs = [stalledJob()];
    world.rows = [esc({ dueAt: ago(1) })];
    world.deps.escalateFurther = async () => {
      throw new EscalationError("not_live", "already acknowledged");
    };
    const log = jest.fn();

    const report = await sweep(world, { log });

    expect(report.errors).toEqual([]);
    expect(report.superseded).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("skipped (not_live)"));
  });
});

// ── Follow-up emails ─────────────────────────────────────────────────────────

describe("a tenant or contractor email restarts the clock on an open attention escalation", () => {
  const stalled = () => job({ statusSince: ago(9 * DAY) });

  it("supersedes it at the same level with the follow-up code", async () => {
    const world = makeWorld();
    world.jobs = [stalled()];
    world.rows = [esc({ dueAt: ago(-5), lastNotifiedAt: ago(10) })];
    world.arrivals.set(1, ago(2));

    const report = await sweep(world);

    expect(world.calls.escalateFurther).toHaveLength(1);
    expect(world.calls.escalateFurther[0]).toMatchObject({ code: "follow_up", escalationId: 1, mode: "same_level", onlyIfOpen: true });
    expect(report.followUps).toBe(1);
    expect(world.rows[1]).toMatchObject({ level: 1, parentEscalationId: 1, targetRole: "facilities_manager" });
    expect(world.rows[1].lastFollowUpAt).toEqual(NOW);
  });

  it("counts mail only after the last notification", () => {
    expect(followUpSince({ createdAt: ago(10), lastFollowUpAt: null, lastNotifiedAt: null })).toEqual(ago(10));
    expect(followUpSince({ createdAt: ago(10), lastFollowUpAt: null, lastNotifiedAt: ago(8) })).toEqual(ago(8));
    expect(followUpSince({ createdAt: ago(10), lastFollowUpAt: ago(3), lastNotifiedAt: ago(8) })).toEqual(ago(3));
  });

  it("ignores mail from before the escalation or its last notification", async () => {
    const world = makeWorld();
    world.jobs = [stalled()];
    world.rows = [esc({ dueAt: ago(-5), lastNotifiedAt: ago(10) })];
    world.arrivals.set(1, ago(11));

    await sweep(world);

    expect(world.calls.escalateFurther).toEqual([]);
  });

  it("does not delay an emergency, and leaves acknowledged ones alone", async () => {
    const world = makeWorld();
    world.jobs = [job({ jobId: 1, priority: "Critical", statusSince: ago(9 * DAY) }), stalled(), job({ jobId: 3, statusSince: ago(9 * DAY) })];
    world.jobs[1].jobId = 2;
    world.rows = [
      esc({ dueAt: ago(-5), lastNotifiedAt: ago(10), policyKey: "job.stalled_unacknowledged", subjectId: "1", urgent: true }),
      esc({ acknowledgedAt: ago(5), dueAt: ago(-5), lastNotifiedAt: ago(10), status: "acknowledged", subjectId: "2", targetUserId: 4 }),
      esc({ dueAt: ago(-5), kind: "attention", lastNotifiedAt: ago(10), subjectId: "3", subjectType: "system" }),
    ];
    for (const id of [1, 2, 3]) world.arrivals.set(id, ago(2));

    await sweep(world);

    expect(world.calls.escalateFurther).toEqual([]);
  });

  it("doesn't restart the same escalation again for the same email (the new row's clock starts now)", async () => {
    const world = makeWorld();
    world.jobs = [stalled()];
    world.rows = [esc({ dueAt: ago(-5), lastNotifiedAt: ago(10) })];
    world.arrivals.set(1, ago(2));

    await sweep(world);
    const rowsAfterFirst = world.rows.length;
    await sweep(world);

    expect(world.calls.escalateFurther).toHaveLength(1);
    expect(world.rows).toHaveLength(rowsAfterFirst);
  });
});

// ── Notification retries ─────────────────────────────────────────────────────

describe("notifications that failed or never left are tried again", () => {
  it("retries a pending notification after its grace and a failed one once its back-off has passed", async () => {
    const world = makeWorld();
    world.jobs = [job({ jobId: 1, statusSince: ago(9 * DAY) }), job({ jobId: 2, statusSince: ago(9 * DAY) }), job({ jobId: 3, statusSince: ago(9 * DAY) }), job({ jobId: 4, statusSince: ago(9 * DAY) })];
    world.rows = [
      esc({ createdAt: ago(0.5), dueAt: ago(-5), lastNotificationAttemptAt: ago(0.5), notificationAttempts: 0, notificationState: "pending", subjectId: "1" }),
      esc({ dueAt: ago(-5), lastNotificationAttemptAt: ago(1), notificationAttempts: 2, notificationState: "failed", subjectId: "2" }),
      esc({ dueAt: ago(-5), lastNotificationAttemptAt: ago(0.1), notificationAttempts: 2, notificationState: "failed", subjectId: "3" }),
      esc({ dueAt: ago(-5), notificationState: "sent", subjectId: "4" }),
    ];

    const report = await sweep(world);

    expect(world.calls.notify.map((n) => n.id).sort()).toEqual([1, 2]);
    expect(report.notificationsRetried).toBe(2);
  });

  it("resends a superseding row's own kind of email", async () => {
    const world = makeWorld();
    world.jobs = [job({ statusSince: ago(9 * DAY) })];
    world.rows = [esc({ dueAt: ago(-5), notificationAttempts: 0, notificationState: "pending", parentEscalationId: 9 })];

    await sweep(world);

    expect(world.calls.notify).toEqual([{ event: "supersede", id: 1 }]);
  });

  it("waits, writing nothing, while the settings that email needs are missing", async () => {
    const world = makeWorld();
    world.jobs = [job({ statusSince: ago(9 * DAY) })];
    world.rows = [esc({ createdAt: ago(5), dueAt: ago(-5), notificationAttempts: 0, notificationState: "pending" })];

    await sweep(world, { env: { ...ENV, GRAPH_SENDER_EMAIL: "" } as NodeJS.ProcessEnv });

    expect(world.calls.notify).toEqual([]);
  });

  it("warns about holidays that are not dates, and carries on", async () => {
    const world = makeWorld();
    const warn = jest.fn();

    const report = await sweep(world, { env: { ...ENV, ESCALATION_HOLIDAYS: "2026-12-25, 25/12/2026" } as NodeJS.ProcessEnv, warn });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("25/12/2026"));
    expect(report.errors).toEqual([]);
  });

  it("stops after the attempts run out", async () => {
    const world = makeWorld();
    world.jobs = [job({ statusSince: ago(9 * DAY) })];
    world.rows = [esc({ dueAt: ago(-5), lastNotificationAttemptAt: ago(99), notificationAttempts: MAX_NOTIFICATION_ATTEMPTS, notificationState: "failed" })];

    await sweep(world);

    expect(world.calls.notify).toEqual([]);
  });
});

// ── system.health ────────────────────────────────────────────────────────────

describe("system.health goes to admin instead of skipping silently", () => {
  const healthRaises = (world: World) => world.calls.raise.filter((c) => c.policyKey === "system.health");

  it("raises when APP_BASE_URL or the sender mailbox is missing, naming what is missing", async () => {
    const world = makeWorld();

    const report = await sweep(world, { env: { ...ENV, APP_BASE_URL: "", GRAPH_SENDER_EMAIL: "" } as NodeJS.ProcessEnv });

    expect(healthRaises(world)).toHaveLength(1);
    expect(healthRaises(world)[0]).toMatchObject({
      context: { missing: ["APP_BASE_URL", "GRAPH_SENDER_EMAIL"] },
      subjectId: "notification_config",
      subjectType: "system",
      summary: "Escalation emails can't be sent: APP_BASE_URL, GRAPH_SENDER_EMAIL not set",
    });
    expect(report.healthRaised).toBe(1);
  });

  it("raises it once, not every half hour", async () => {
    const world = makeWorld();
    const env = { ...ENV, APP_BASE_URL: "" } as NodeJS.ProcessEnv;
    await sweep(world, { env });
    await sweep(world, { env });
    // The second run finds the live escalation and doesn't even try.
    expect(healthRaises(world).filter((c) => c.subjectId === "notification_config")).toHaveLength(1);
    expect(world.rows.filter((r) => r.policyKey === "system.health")).toHaveLength(1);
  });

  it("raises when emails keep failing after every retry", async () => {
    const world = makeWorld();
    world.exhausted = 3;

    await sweep(world);

    expect(healthRaises(world)[0]).toMatchObject({ context: { count: 3 }, subjectId: "notifications", summary: "3 escalation emails could not be sent after 6 tries" });
  });

  it("raises when a step of the run fails, and the other steps still run", async () => {
    const world = makeWorld();
    world.jobs = [job({ statusSince: ago(9 * DAY) })];
    world.rows = [esc({ dueAt: ago(-5), subjectId: "9" })]; // job 9 doesn't exist: its condition cleared
    world.deps.loadLiveJobFacts = async () => {
      throw new Error("deadlock victim");
    };
    const warn = jest.fn();

    const report = await sweep(world, { warn });

    expect(report.errors).toEqual(["raising for jobs: deadlock victim"]);
    expect(world.calls.autoResolve).toHaveLength(1); // the step before still ran
    expect(healthRaises(world)).toHaveLength(1);
    expect(healthRaises(world)[0]).toMatchObject({ subjectId: "sweep" });
    expect(healthRaises(world)[0].summary).toMatch(/^The escalation sweep had 1 problem: raising for jobs: deadlock victim/);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("deadlock victim"));
  });

  it("raises when a single action fails, and carries on with the next", async () => {
    const world = makeWorld();
    world.jobs = [job({ jobId: 1, statusSince: ago(9 * DAY) }), job({ jobId: 2, statusSince: ago(9 * DAY) })];
    const realRaise = world.deps.raise;
    world.deps.raise = async (c, input) => {
      if (input.subjectId === "1") throw new Error("Graph is down");
      return realRaise(c, input);
    };

    const report = await sweep(world);

    expect(report.errors).toEqual(["raising job.stalled_unacknowledged on job #1: Graph is down"]);
    expect(report.raised).toBe(1);
    expect(world.rows.some((r) => r.subjectId === "2" && r.policyKey === "job.stalled_unacknowledged")).toBe(true);
    expect(world.rows.some((r) => r.policyKey === "system.health" && r.subjectId === "sweep")).toBe(true);
  });

  it("ends the sweep health escalation once a run is clean", async () => {
    const world = makeWorld();
    world.rows = [esc({ dueAt: null, policyKey: "system.health", subjectId: "sweep", subjectType: "system", targetRole: "admin" })];

    const report = await sweep(world);

    expect(world.calls.autoResolve.map((c) => c.escalationId)).toEqual([1]);
    expect(report.healthResolved).toBe(1);
  });

  it("raises nothing when everything is fine", async () => {
    const world = makeWorld();
    const report = await sweep(world);
    expect(world.calls.raise).toEqual([]);
    expect(report).toMatchObject({ errors: [], healthRaised: 0, raised: 0 });
  });
});

// ── Dry run, cap and idempotency ─────────────────────────────────────────────

describe("dry run", () => {
  function busyWorld(): World {
    const world = makeWorld();
    world.jobs = [
      job({ jobId: 1, statusSince: ago(9 * DAY) }),
      job({ assigned: false, createdAt: ago(3 * DAY), jobId: 2 }),
      job({ jobId: 3, statusSince: ago(1 * DAY) }),
      job({ jobId: 4, statusSince: ago(9 * DAY) }),
    ];
    world.rows = [
      esc({ dueAt: ago(1), subjectId: "4" }), // overdue, job still stalled: would move up
      esc({ dueAt: ago(-5), subjectId: "3" }), // job 3 is fine now: would end
      esc({ dueAt: ago(-5), lastNotifiedAt: ago(10), subjectId: "1" }), // follow-up mail: would restart
      esc({ createdAt: ago(1), dueAt: ago(-5), notificationAttempts: 0, notificationState: "pending", subjectId: "2", policyKey: "job.unassigned" }),
    ];
    world.arrivals.set(1, ago(2));
    return world;
  }

  it("writes nothing and sends nothing, but logs, with counts, what it would do", async () => {
    const world = busyWorld();
    const before = JSON.stringify(world.rows);
    const log = jest.fn();

    const report = await sweep(world, { dryRun: true, log });

    expect(world.calls).toEqual({ autoResolve: [], escalateFurther: [], notify: [], raise: [], reask: [] });
    expect(JSON.stringify(world.rows)).toBe(before);
    expect(report).toMatchObject({ autoResolved: 1, dryRun: true, followUps: 1, superseded: 1 });
    const lines = log.mock.calls.map((c) => c[0] as string).join("\n");
    expect(lines).toContain("would end #2");
    expect(lines).toContain("would move up #1");
    expect(lines).toContain("would restart the clock on #3");
    expect(lines).toContain("DRY RUN (nothing written)");
    expect(lines).toMatch(/superseded=1/);
  });

  it("reports what it would raise: new job escalations and health", async () => {
    const world = makeWorld();
    world.jobs = [job({ jobId: 1, statusSince: ago(9 * DAY) }), job({ assigned: false, createdAt: ago(3 * DAY), jobId: 2 })];
    const log = jest.fn();

    const report = await sweep(world, { dryRun: true, env: { ...ENV, APP_BASE_URL: "" } as NodeJS.ProcessEnv, log });

    expect(report).toMatchObject({ healthRaised: 1, raised: 2 });
    expect(world.calls.raise).toEqual([]);
    const lines = log.mock.calls.map((c) => c[0] as string).join("\n");
    expect(lines).toContain("would raise job.stalled_unacknowledged on job #1: Stalled");
    expect(lines).toContain("would raise job.unassigned on job #2: Needs an owner");
    expect(lines).toContain("would raise system.health (notification_config)");
  });
});

describe("the action limit", () => {
  it("stops after the limit with the most urgent jobs first, and says it stopped", async () => {
    const world = makeWorld();
    world.jobs = [
      job({ jobId: 1, priority: "Low", statusSince: ago(30 * DAY) }),
      job({ jobId: 2, priority: "Critical", statusSince: ago(30 * DAY) }),
      job({ jobId: 3, priority: "Normal", statusSince: ago(30 * DAY) }),
      job({ jobId: 4, priority: "High", statusSince: ago(30 * DAY) }),
    ];
    const log = jest.fn();

    const report = await sweep(world, { log, maxActions: 2 });

    expect(raisedKeys(world)).toEqual(["job.stalled_unacknowledged:2", "job.stalled_unacknowledged:4"]);
    expect(report.truncated).toBe(true);
    expect(log.mock.calls.map((c) => c[0]).join("\n")).toContain("stopped at the action limit");
  });

  it("finishes the backlog over the next runs", async () => {
    const world = makeWorld();
    world.jobs = [1, 2, 3, 4, 5].map((id) => job({ jobId: id, statusSince: ago(30 * DAY) }));

    const first = await sweep(world, { maxActions: 2 });
    const second = await sweep(world, { maxActions: 2 });
    const third = await sweep(world, { maxActions: 2 });

    expect([first.raised, second.raised, third.raised]).toEqual([2, 2, 1]);
    expect(first.truncated && second.truncated).toBe(true);
    expect(third.truncated).toBe(false);
  });

  it("reads the limit from ESCALATION_SWEEP_MAX_ACTIONS", async () => {
    const world = makeWorld();
    world.jobs = [1, 2, 3].map((id) => job({ jobId: id, statusSince: ago(30 * DAY) }));
    const report = await sweep(world, { env: { ...ENV, ESCALATION_SWEEP_MAX_ACTIONS: "1" } as NodeJS.ProcessEnv });
    expect(report.raised).toBe(1);
  });
});

describe("running it twice", () => {
  it("does nothing the second time", async () => {
    const world = makeWorld();
    world.jobs = [
      job({ jobId: 1, statusSince: ago(9 * DAY) }),
      job({ assigned: false, createdAt: ago(3 * DAY), jobId: 2 }),
      job({ expectedProgressUpdate: ago(3 * DAY), jobId: 3 }),
      job({ jobId: 4, oldestPendingInvoiceAt: ago(9 * DAY), pendingInvoices: 1, status: "Awaiting Approval" }),
      job({ firstQuoteRequestAt: ago(5 * DAY), jobId: 5, requestedContractors: 1, status: "Quote" }),
    ];

    const first = await sweep(world);
    const rowsAfterFirst = JSON.stringify(world.rows);
    const second = await sweep(world);

    expect(first.raised).toBe(5);
    expect(second).toMatchObject({ autoResolved: 0, errors: [], followUps: 0, raised: 0, reminded: 0, superseded: 0 });
    expect(JSON.stringify(world.rows)).toBe(rowsAfterFirst);
  });

  it("settles after resolving: a cleared condition ends once and stays ended", async () => {
    const world = makeWorld();
    world.jobs = [job({ statusSince: ago(1 * DAY) })];
    world.rows = [esc({ dueAt: ago(-5) })];

    const first = await sweep(world);
    const second = await sweep(world);

    expect(first.autoResolved).toBe(1);
    expect(second.autoResolved).toBe(0);
    expect(world.calls.autoResolve).toHaveLength(1);
  });
});

// ── A decision request's schedule (jobs plan A1) ─────────────────────────────

describe("scheduled reminders (a decision request's)", () => {
  /** A pending decision request: authority, asked of two named people, with reminders at the given hours from NOW. */
  const decisionRow = (remindHoursFromNow: number[], over: Partial<EscalationRow> = {}): EscalationRow =>
    esc({
      context: { decision: { question: "Pay it?", requestId: 7 }, schedule: { remindAt: remindHoursFromNow.map((h) => ago(-h).toISOString()) }, userTargets: [3, 5] },
      createdAt: ago(48),
      dueAt: ago(-100),
      kind: "authority",
      lastNotifiedAt: ago(47),
      policyKey: "job.decision_pending",
      subjectId: "12",
      targetRole: null,
      ...over,
    });

  /** Like the real notifier: a reminder that went out is when the people were last told. */
  function remindingWorld(): World {
    const world = makeWorld();
    world.policies["job.decision_pending"] = policy("job.decision_pending", {
      kind: "authority",
      ladder: [{ userTarget: true }, { token: "raiser_manager", slaHours: 16 }, { role: "director" }],
    });
    world.deps.notifyTargets = async (_c, row, event, options) => {
      world.calls.notify.push({ event, id: row.escalationId });
      (world.calls as unknown as { options: unknown[] }).options = [...(((world.calls as unknown as { options?: unknown[] }).options) ?? []), options];
      const found = world.rows.find((r) => r.escalationId === row.escalationId);
      if (found) found.lastNotifiedAt = NOW;
      return { attempts: 1, error: null, recipients: [], state: "sent" };
    };
    return world;
  }

  it("emails the reminder that is due, as a reminder, and writes no new row", async () => {
    const world = remindingWorld();
    world.rows = [decisionRow([-2])];

    const report = await sweep(world);

    expect(report.scheduledReminders).toBe(1);
    expect(world.calls.notify).toEqual([{ event: "reminder", id: 1 }]);
    expect(world.rows).toHaveLength(1);
    expect(world.calls.escalateFurther).toEqual([]);
    expect(report.errors).toEqual([]);
  });

  it("costs the row no attempts when it goes through: the notifier is asked to count failures only", async () => {
    const world = remindingWorld();
    world.rows = [decisionRow([-2])];

    await sweep(world);

    const options = (world.calls as unknown as { options: { countAttempts?: string }[] }).options;
    expect(options).toHaveLength(1);
    expect(options[0].countAttempts).toBe("failures");
  });

  it("does nothing before its time", async () => {
    const world = remindingWorld();
    world.rows = [decisionRow([5, 30])];

    const report = await sweep(world);

    expect(report.scheduledReminders).toBe(0);
    expect(world.calls.notify).toEqual([]);
  });

  it("sends one for the time that has come and, run again, nothing more", async () => {
    const world = remindingWorld();
    world.rows = [decisionRow([-2, 30])];

    const first = await sweep(world);
    const second = await sweep(world);

    expect(first.scheduledReminders).toBe(1);
    expect(second.scheduledReminders).toBe(0);
    expect(world.calls.notify).toHaveLength(1);
  });

  it("sends one reminder, not several, when more than one time has passed (the sweep was off)", async () => {
    const world = remindingWorld();
    world.rows = [decisionRow([-30, -20, -2])];

    const report = await sweep(world);

    expect(report.scheduledReminders).toBe(1);
    expect(world.calls.notify).toHaveLength(1);
  });

  it("still reminds a row someone has acknowledged: the decision has not been made", async () => {
    const world = remindingWorld();
    world.rows = [decisionRow([-2], { acknowledgedAt: ago(5), status: "acknowledged", targetUserId: 3 })];

    const report = await sweep(world);

    expect(report.scheduledReminders).toBe(1);
  });

  it("in a dry run says what it would send and sends nothing", async () => {
    const world = remindingWorld();
    world.rows = [decisionRow([-2])];
    const log = jest.fn();

    const report = await sweep(world, { dryRun: true, log });

    expect(report.scheduledReminders).toBe(1);
    expect(world.calls.notify).toEqual([]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("would remind the people on #1 job.decision_pending on job 12"));
  });

  it("reminds a request with no due moment (an urgent one not ticked to move up), and never moves it up, however far past its respond-by", async () => {
    const world = remindingWorld();
    world.rows = [
      decisionRow([-2], {
        context: {
          decision: { autoEscalate: false, question: "Pay it?", requestId: 7, respondBy: ago(30).toISOString(), tier: "urgent" },
          schedule: { escalateAt: null, remindAt: [ago(2).toISOString()] },
          userTargets: [3, 5],
        },
        createdAt: ago(100),
        dueAt: null,
        lastNotifiedAt: ago(99),
        urgent: true,
      }),
    ];

    const report = await sweep(world);

    expect(report.scheduledReminders).toBe(1);
    expect(world.calls.notify).toEqual([{ event: "reminder", id: 1 }]);
    expect(report.superseded).toBe(0);
    expect(report.reminded).toBe(0);
    expect(world.calls.escalateFurther).toEqual([]);
    expect(world.rows).toHaveLength(1);
    expect(world.rows[0]).toMatchObject({ dueAt: null, level: 1, status: "open" });
  });

  it("moves a request up first when its deadline has passed, and does not remind the row it left or the one it made", async () => {
    const world = remindingWorld();
    world.rows = [decisionRow([-2], { dueAt: ago(1) })];

    const report = await sweep(world);

    expect(report.superseded).toBe(1);
    expect(world.calls.escalateFurther[0]).toMatchObject({ code: "sla_breach", mode: "next_level", onlyIfOpen: true });
    expect(report.scheduledReminders).toBe(0);
    expect(world.calls.notify).toEqual([]);
  });

  it("reports a send that failed as a problem of the run, so system.health hears of it, and tries again next run", async () => {
    const world = remindingWorld();
    world.rows = [decisionRow([-2])];
    world.deps.notifyTargets = async (_c, row, event) => {
      world.calls.notify.push({ event, id: row.escalationId });
      return { attempts: 3, error: "Graph sendMail failed: 503", recipients: ["dee@example.com"], state: "failed" };
    };

    const first = await sweep(world);
    const second = await sweep(world);

    expect(first.scheduledReminders).toBe(0);
    expect(first.errors).toEqual([expect.stringContaining("reminding on escalation #1: Graph sendMail failed: 503")]);
    expect(world.calls.notify).toHaveLength(2);
    expect(second.errors).toHaveLength(1);
  });

  it("only logs, and reports no problem, when there was nobody to tell or the mail settings are missing", async () => {
    const world = remindingWorld();
    world.rows = [decisionRow([-2])];
    world.deps.notifyTargets = async (_c, row, event) => {
      world.calls.notify.push({ event, id: row.escalationId });
      return { attempts: 0, error: "No one with an email address is at this level", recipients: [], state: "none" };
    };
    const log = jest.fn();

    const report = await sweep(world, { log });

    expect(report.errors).toEqual([]);
    expect(report.scheduledReminders).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("no reminder sent on #1 (none: No one with an email address is at this level)"));
  });

  it("counts its sends against the run's allowance", async () => {
    const world = remindingWorld();
    world.rows = [decisionRow([-2], { subjectId: "12" }), decisionRow([-2], { subjectId: "13" })];

    const report = await sweep(world, { env: { ...ENV, ESCALATION_SWEEP_MAX_ACTIONS: "1" } as NodeJS.ProcessEnv });

    expect(report.scheduledReminders).toBe(1);
    expect(report.truncated).toBe(true);
  });

  it("leaves every escalation without a schedule alone", async () => {
    const world = remindingWorld();
    world.jobs = [job({ statusSince: ago(9 * DAY) })];
    world.rows = [esc({ dueAt: ago(-5) }), esc({ context: { schedule: { remindAt: [] } }, dueAt: ago(-5), subjectId: "2" })];

    const report = await sweep(world);

    expect(report.scheduledReminders).toBe(0);
    expect(world.calls.notify).toEqual([]);
  });

  it("does not end a pending decision request whose job meets no condition: it ends with the decision", async () => {
    const world = remindingWorld();
    world.rows = [decisionRow([30])];

    const report = await sweep(world);

    expect(report.autoResolved).toBe(0);
    expect(world.calls.autoResolve).toEqual([]);
    expect(world.rows[0].status).toBe("open");
  });

  it("does not restart a pending decision request's clock when mail about the job arrives", async () => {
    const world = remindingWorld();
    world.rows = [decisionRow([30])];
    world.arrivals.set(12, ago(1));

    const report = await sweep(world);

    expect(report.followUps).toBe(0);
    expect(world.calls.escalateFurther).toEqual([]);
  });

  it("puts the count in the run's one-line summary", async () => {
    const world = remindingWorld();
    world.rows = [decisionRow([-2])];
    const log = jest.fn();

    await sweep(world, { log });

    expect(log).toHaveBeenCalledWith(expect.stringMatching(/scheduledReminders=1 /));
  });
});

// ── Deferred decisions come back (jobs plan A2) ──────────────────────────────

describe("a deferred decision comes back on its day", () => {
  // NOW is Tuesday 2026-10-13, 12:00 Darwin.
  const deferral = (over: Partial<DueDeferral> = {}): DueDeferral => ({ decisionId: 4, deferUntil: "2026-10-13", jobId: 12, requestId: 7, ...over });

  function askingWorld(): World {
    const world = makeWorld();
    world.policies["job.decision_pending"] = policy("job.decision_pending", {
      kind: "authority",
      ladder: [{ userTarget: true }, { token: "raiser_manager", slaHours: 16 }, { role: "director" }],
    });
    return world;
  }

  it("asks it again, once, and says so in the report and the one-line summary", async () => {
    const world = askingWorld();
    world.deferrals = [deferral()];
    const log = jest.fn();

    const report = await sweep(world, { log });

    expect(world.calls.reask).toHaveLength(1);
    expect(world.calls.reask[0].deferral).toEqual(deferral());
    expect(report.reasked).toBe(1);
    expect(report.errors).toEqual([]);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/reasked=1 /));
  });

  it("hands the asker the moment, the holidays and the send options of the run", async () => {
    const world = askingWorld();
    world.deferrals = [deferral()];

    await sweep(world, { env: { ...ENV, ESCALATION_HOLIDAYS: "2026-10-14" } });

    const { options } = world.calls.reask[0];
    expect(options.now).toEqual(NOW);
    expect(options.holidays?.has("2026-10-14")).toBe(true);
    expect(options.notify).toMatchObject({ attempts: 3, backoffMs: 1000 });
  });

  it("is idempotent: run again, and it is not asked a second time", async () => {
    const world = askingWorld();
    world.deferrals = [deferral()];

    const first = await sweep(world);
    const second = await sweep(world);

    expect(first.reasked).toBe(1);
    expect(second.reasked).toBe(0);
    expect(world.calls.reask).toHaveLength(1);
  });

  it("asks every deferral that is due, oldest first as the database lists them", async () => {
    const world = askingWorld();
    world.deferrals = [deferral({ decisionId: 4, deferUntil: "2026-10-09", jobId: 12 }), deferral({ decisionId: 5, deferUntil: "2026-10-13", jobId: 14 })];

    const report = await sweep(world);

    expect(world.calls.reask.map((c) => c.deferral.jobId)).toEqual([12, 14]);
    expect(report.reasked).toBe(2);
  });

  it("waits for the day to open: 08:30 Darwin on the date, not midnight", async () => {
    const world = askingWorld();
    world.deferrals = [deferral({ deferUntil: "2026-10-13" })];
    const sevenAm = new Date(Date.UTC(2026, 9, 13, 7, 0) - 9.5 * 3_600_000);
    const halfPastEight = new Date(Date.UTC(2026, 9, 13, 8, 30) - 9.5 * 3_600_000);

    expect((await sweep(world, { now: sevenAm })).reasked).toBe(0);
    expect(world.calls.reask).toHaveLength(0);
    expect((await sweep(world, { now: halfPastEight })).reasked).toBe(1);
  });

  it("does not ask on a day to come, even if the database listed it", async () => {
    const world = askingWorld();
    world.deferrals = [deferral({ deferUntil: "2026-10-14" })];

    expect((await sweep(world)).reasked).toBe(0);
    expect(world.calls.reask).toHaveLength(0);
  });

  it("asks one whose day went by while the sweep was off, at once", async () => {
    const world = askingWorld();
    world.deferrals = [deferral({ deferUntil: "2026-09-30" })];

    expect((await sweep(world)).reasked).toBe(1);
  });

  it("does not count one the asker skipped (asked already, job closed, a request since)", async () => {
    const world = askingWorld();
    world.deferrals = [deferral()];
    world.deps.reaskDeferral = async (_c, d, options) => {
      world.calls.reask.push({ deferral: d, options });
      return "skipped";
    };

    const report = await sweep(world);

    expect(world.calls.reask).toHaveLength(1);
    expect(report.reasked).toBe(0);
    expect(report.errors).toEqual([]);
  });

  it("reports a failure as a problem of the run and carries on with the next", async () => {
    const world = askingWorld();
    world.deferrals = [deferral({ decisionId: 4, jobId: 12 }), deferral({ decisionId: 5, jobId: 14 })];
    const asked: number[] = [];
    world.deps.reaskDeferral = async (_c, d) => {
      if (d.jobId === 12) throw new Error("Nobody this question was put to can be asked any more");
      asked.push(d.jobId);
      return "asked";
    };

    const report = await sweep(world);

    expect(asked).toEqual([14]);
    expect(report.reasked).toBe(1);
    expect(report.errors).toEqual(["asking job #12 again: Nobody this question was put to can be asked any more"]);
  });

  it("does not stop the other steps of the run when it cannot list the deferrals", async () => {
    const world = askingWorld();
    world.deps.listDueDeferrals = async () => {
      throw new Error("deadlock victim");
    };
    world.jobs = [job({ assigned: false, createdAt: ago(3 * DAY), jobId: 5, statusSince: ago(3 * DAY) })];

    const report = await sweep(world);

    expect(report.errors).toEqual(["asking deferred decisions again: deadlock victim"]);
    expect(raisedKeys(world)).toContain("job.unassigned:5");
  });

  it("leaves them be, and says so, while job.decision_pending is switched off or has no row", async () => {
    for (const setup of [(w: World) => (w.policies["job.decision_pending"].active = false), (w: World) => delete w.policies["job.decision_pending"]]) {
      const world = askingWorld();
      setup(world);
      world.deferrals = [deferral()];
      const log = jest.fn();

      const report = await sweep(world, { log });

      expect(world.calls.reask).toHaveLength(0);
      expect(report.reasked).toBe(0);
      expect(report.errors).toEqual([]);
      expect(log).toHaveBeenCalledWith(expect.stringMatching(/1 deferred decision is due, but job\.decision_pending .* so it is not asked again/));
    }
  });

  it("says nothing about the policy when nothing is due", async () => {
    const world = askingWorld();
    world.policies["job.decision_pending"].active = false;
    const log = jest.fn();

    await sweep(world, { log });

    expect(log).not.toHaveBeenCalledWith(expect.stringMatching(/deferred decision/));
  });

  it("in a dry run says what it would ask and asks nothing", async () => {
    const world = askingWorld();
    world.deferrals = [deferral()];
    const log = jest.fn();

    const report = await sweep(world, { dryRun: true, log });

    expect(world.calls.reask).toHaveLength(0);
    expect(world.deferrals).toHaveLength(1);
    expect(report.reasked).toBe(1);
    expect(log).toHaveBeenCalledWith("escalationSweep: would ask job #12 again (decision #4, deferred until 2026-10-13)");
  });

  it("counts against the run's allowance and finishes over the next run", async () => {
    const world = askingWorld();
    world.deferrals = [deferral({ decisionId: 4, jobId: 12 }), deferral({ decisionId: 5, jobId: 14 }), deferral({ decisionId: 6, jobId: 16 })];

    const first = await sweep(world, { maxActions: 2 });
    const second = await sweep(world, { maxActions: 2 });

    expect(first.reasked).toBe(2);
    expect(first.truncated).toBe(true);
    expect(second.reasked).toBe(1);
    expect(world.calls.reask.map((c) => c.deferral.jobId)).toEqual([12, 14, 16]);
  });

  it("leaves every other step alone: nothing due, nothing asked, no policy read for it", async () => {
    const world = askingWorld();
    const getPolicy = jest.spyOn(world.deps, "getPolicy");

    await sweep(world);

    expect(world.calls.reask).toHaveLength(0);
    expect(getPolicy.mock.calls.map((c) => c[1])).not.toContain("job.decision_pending");
  });
});

describe("a next step is chased on its own clock (jobs plan A2)", () => {
  /** An open next step handed to Alana (9): attention, on the job, with a schedule. */
  const stepRow = (over: Partial<EscalationRow> = {}): EscalationRow =>
    esc({
      context: { nextStep: { decisionId: 4, nextStep: "Pay it" }, schedule: { remindAt: [] }, userTargets: [9] },
      dueAt: ago(-30),
      kind: "attention",
      lastNotifiedAt: ago(10),
      policyKey: "job.next_step",
      raisedByKind: "user",
      raisedByName: "Dee",
      raisedByUserId: 5,
      subjectId: "12",
      targetRole: "accounts",
      targetUserId: 9,
      ...over,
    });

  function stepWorld(): World {
    const world = makeWorld();
    world.policies["job.next_step"] = policy("job.next_step", { ladder: [{ userTarget: true }, { token: "raiser_manager", slaHours: 16 }, { role: "director" }] });
    // The step is open while the world says so, as the job adapter asks the decisions table.
    const original = world.deps.getAdapter;
    world.deps.getAdapter = (type) => {
      const adapter = original(type);
      if (type !== "job" || !adapter) return adapter;
      return { ...adapter, isConditionActive: async (c, ref, now) => (ref.policyKey === "job.next_step" ? true : adapter.isConditionActive(c, ref, now)) };
    };
    return world;
  }

  it("is not restarted by mail about the job, as a stalled job is: it is due when its decision said", async () => {
    const world = stepWorld();
    world.rows = [stepRow()];
    world.arrivals.set(12, ago(1));

    const report = await sweep(world);

    expect(report.followUps).toBe(0);
    expect(world.calls.escalateFurther).toEqual([]);
  });

  it("is restarted by that mail in the control case, so the test above proves something", async () => {
    const world = stepWorld();
    world.jobs = [job({ jobId: 12, statusSince: ago(9 * DAY) })];
    world.rows = [esc({ dueAt: ago(-30), lastNotifiedAt: ago(10), subjectId: "12" })];
    world.arrivals.set(12, ago(1));

    expect((await sweep(world)).followUps).toBe(1);
  });

  it("moves up to the owner's manager when it is overdue, like any open attention escalation", async () => {
    const world = stepWorld();
    world.rows = [stepRow({ dueAt: ago(1) })];

    const report = await sweep(world);

    expect(report.superseded).toBe(1);
    expect(world.calls.escalateFurther[0]).toMatchObject({ code: "sla_breach", escalationId: 1, mode: "next_level", onlyIfOpen: true });
  });

  it("is ended as cleared when the step is no longer open (the job was closed or archived)", async () => {
    const world = stepWorld();
    const adapter = world.deps.getAdapter("job") as EscalationAdapter;
    world.deps.getAdapter = (type) => (type === "job" ? { ...adapter, isConditionActive: async () => false } : null);
    world.rows = [stepRow()];

    const report = await sweep(world);

    expect(report.autoResolved).toBe(1);
    expect(world.calls.autoResolve).toHaveLength(1);
  });

  it("reminds its owner on the schedule it was raised with", async () => {
    const world = stepWorld();
    world.rows = [stepRow({ context: { nextStep: { decisionId: 4, nextStep: "Pay it" }, schedule: { remindAt: [ago(2).toISOString()] }, userTargets: [9] }, lastNotifiedAt: ago(30) })];

    const report = await sweep(world);

    expect(report.scheduledReminders).toBe(1);
    expect(world.calls.notify).toEqual([{ event: "reminder", id: 1 }]);
  });
});

describe("attribution notices (R2, R13)", () => {
  it("raises a missing notice for an unanswered attribution, to the named manager, once", async () => {
    const world = makeWorld();
    world.deps.listUnansweredAttributions = async () => [{ attributedToUserId: 30, ref: { id: 7, jobId: 9, kind: "quote" } }];

    await sweep(world);
    await sweep(world);

    expect(world.calls.raise).toEqual([
      expect.objectContaining({ policyKey: "quote.attribution_notice", subjectId: "quote:7@9", subjectType: "approval_attribution", userTargets: [30] }),
    ]);
  });

  it("leaves alone one that already had a notice, even if a person closed it", async () => {
    const world = makeWorld();
    world.rows.push(esc({ policyKey: "po.variance_notice", status: "resolved", subjectId: "variance:4@9", subjectType: "approval_attribution" }));
    world.deps.listUnansweredAttributions = async () => [{ attributedToUserId: 30, ref: { id: 4, jobId: 9, kind: "variance" } }];

    await sweep(world);

    expect(world.calls.raise).toEqual([]);
  });

  it("only says what it would do on a dry run", async () => {
    const world = makeWorld();
    world.deps.listUnansweredAttributions = async () => [{ attributedToUserId: 30, ref: { id: 7, jobId: 9, kind: "quote" } }];
    expect((await sweep(world, { dryRun: true })).raised).toBe(1);
    expect(world.calls.raise).toEqual([]);
  });
});

describe("unacknowledged tenant requests (TR1)", () => {
  const overdue = { dueAt: new Date("2026-10-27T01:00:00Z"), priority: "High", workRequestId: 31 };

  it("raises request.unacknowledged for a request past its target, once", async () => {
    const world = makeWorld();
    world.deps.listOverdueRequests = async () => [overdue];

    await sweep(world);
    await sweep(world);

    expect(world.calls.raise).toEqual([expect.objectContaining({ policyKey: "request.unacknowledged", subjectId: "31", subjectType: "work_request" })]);
  });

  it("raises nothing when no target is set (the list is empty), or when the step is not wired", async () => {
    const world = makeWorld();
    world.deps.listOverdueRequests = async () => [];
    await sweep(world);
    delete world.deps.listOverdueRequests;
    await sweep(world);
    expect(world.calls.raise).toEqual([]);
  });

  it("leaves alone a request that already had one, even if a person closed it", async () => {
    const world = makeWorld();
    world.rows.push(esc({ policyKey: "request.unacknowledged", status: "resolved", subjectId: "31", subjectType: "work_request" }));
    world.deps.listOverdueRequests = async () => [overdue];
    await sweep(world);
    expect(world.calls.raise).toEqual([]);
  });

  it("only says what it would do on a dry run", async () => {
    const world = makeWorld();
    world.deps.listOverdueRequests = async () => [overdue];
    expect((await sweep(world, { dryRun: true })).raised).toBe(1);
    expect(world.calls.raise).toEqual([]);
  });
});
