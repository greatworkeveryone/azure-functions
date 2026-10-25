/// <reference types="jest" />
// The review generator: one open review per live tenancy (not vacated, not
// archived, and not a lease with no review clause), for the next review date
// derived for today; scheduled, then due once inside the
// window; idempotent; a dry run writes nothing. The database is an in-memory
// fake that enforces the filtered unique index, so "a re-run changes nothing"
// is checked against what was actually stored. The ledger is the real one: its
// INSERTs reach the same fake, so every entry has passed the ledger's own
// validation (known action, subject type, reason rules) and is read back as the
// row that would be stored.
import type { Connection } from "tedious";
import { addDaysIso, addMonthsClamped } from "../darwinDate";
import type { SqlRow } from "../db";
import {
  DEFAULT_REVIEW_WINDOW_DAYS,
  GENERATOR_ACTOR,
  generatorMode,
  nextReviewFor,
  planGenerator,
  reviewWindowDays,
  runReviewGenerator,
  scheduleNextReview,
  toTenancyFacts,
  type OpenReview,
} from "../rentReview/generator";
import { LEGACY_REVIEW_TYPES, LEGACY_STATUSES } from "../rentReview/legacyMap";

jest.mock("../db", () => ({
  beginTransaction: jest.fn().mockResolvedValue(undefined),
  commitTransaction: jest.fn().mockResolvedValue(undefined),
  executeQuery: jest.fn(),
  rollbackTransaction: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../tenant-register-cache", () => ({ invalidateTenantAndBuilding: jest.fn() }));
// The escalation step has its own tests (rentReviewEscalations.test.ts); here only its wiring.
jest.mock("../rentReview/escalations", () => ({
  runReviewEscalations: jest.fn().mockResolvedValue({ ended: 0, errors: [], raised: 2, truncated: false }),
}));

const db = require("../db") as {
  beginTransaction: jest.Mock;
  commitTransaction: jest.Mock;
  executeQuery: jest.Mock;
  rollbackTransaction: jest.Mock;
};
const cache = require("../tenant-register-cache") as { invalidateTenantAndBuilding: jest.Mock };
const { runReviewEscalations } = require("../rentReview/escalations") as { runReviewEscalations: jest.Mock };

// The generator is handed the date, so these tests never read the clock.
const TODAY = "2026-10-14";
const DAY = (offset: number): string => addDaysIso(TODAY, offset);
const asDate = (iso: string): Date => new Date(`${iso}T00:00:00Z`);

type Param = { name: string; value: unknown };
const CONNECTION = {} as Connection;

/** A schedule whose step on `review` names `kind` (a commencement row a year earlier, then the review step). */
function stepsFor(review: string, kind: string | undefined): string {
  return JSON.stringify([
    { baseRentPerAnnum: 100000, effectiveFrom: addMonthsClamped(review, -12), id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", methodKind: "commencement", ratePercent: 0 },
    { effectiveFrom: review, id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", ...(kind ? { methodKind: kind } : {}), ratePercent: 3 },
  ]);
}

/** A tenancy whose next review derives to `review`: its lease began a review interval earlier. */
function tenancy(id: number, review: string | null, over: SqlRow = {}): SqlRow {
  return {
    BuildingId: 5,
    Commencement: review === null ? null : asDate(addMonthsClamped(review, -12)),
    LastReviewDate: null,
    LegalName: `Tenant ${id} Pty Ltd`,
    NextReviewDate: null,
    ResolvedReviewDates: null,
    ReviewIntervalMonths: 12,
    ReviewType: "CPI Darwin (June)",
    ScheduledRateSteps: null,
    Status: "current",
    TenantId: id,
    TradingName: null,
    ...over,
  };
}

interface StoredReview {
  BuildingId: number;
  Method: string;
  ReviewId: string;
  ReviewType: string;
  ScheduledFor: Date;
  State: string;
  Status: string;
  TenantId: number;
}

let tenants: SqlRow[] = [];
let stored: StoredReview[] = [];
let writes: string[] = [];
let uniqueViolationFor: number | null = null;
let failLedgerFor: { action: string; tenantId: number } | null = null;

const json = (value: unknown): unknown => (typeof value === "string" ? JSON.parse(value) : null);

/** The decision-ledger rows the real record() sent to the fake, as they would be stored. */
function ledgerRows() {
  return (db.executeQuery.mock.calls as Array<[unknown, string, Param[]?]>)
    .filter(([, sql]) => typeof sql === "string" && sql.includes("INSERT INTO dbo.DecisionLedger"))
    .map(([, , params = []]) => {
      const p = Object.fromEntries(params.map((x) => [x.name, x.value]));
      return {
        action: p.Action as string,
        actorKind: p.ActorKind,
        actorName: p.ActorName,
        after: json(p.After),
        before: json(p.Before),
        buildingId: p.BuildingId as number,
        correlationId: p.CorrelationId as string,
        reason: p.Reason,
        ruleApplied: p.RuleApplied,
        subjectId: p.SubjectId as string,
        subjectType: p.SubjectType,
        tenantId: p.TenantId as number,
      };
    });
}

const OPEN = ["scheduled", "due", "in_progress", "awaiting_index", "referred", "awaiting_approval"];

function fakeSql(_connection: unknown, sql: string, params: Param[] = []): Promise<SqlRow[]> {
  const param = (name: string): unknown => params.find((p) => p.name === name)?.value;
  if (sql.includes("INSERT INTO dbo.DecisionLedger")) {
    if (failLedgerFor && param("TenantId") === failLedgerFor.tenantId && param("Action") === failLedgerFor.action) {
      return Promise.reject(new Error("ledger unavailable"));
    }
    return Promise.resolve([]);
  }
  if (/FROM dbo\.Tenants t\s+WHERE t\.TenantId = @TenantId AND t\.Status <> 'vacated' AND t\.ArchivedAt IS NULL/.test(sql)) {
    return Promise.resolve(tenants.filter((row) => row.TenantId === param("TenantId") && row.Status !== "vacated" && !row.ArchivedAt));
  }
  if (/FROM dbo\.RentReviews\s+WHERE TenantId = @TenantId AND State IN/.test(sql)) {
    return Promise.resolve(stored.filter((r) => r.TenantId === param("TenantId") && OPEN.includes(r.State)).map((r) => ({ ...r })));
  }
  if (/FROM dbo\.Tenants t\s+WHERE t\.Status <> 'vacated'/.test(sql)) {
    // The fake honours the archive filter only if the SQL asks for it, so the
    // tests below fail if the clause is dropped.
    const leavesOutArchived = /AND t\.ArchivedAt IS NULL/.test(sql);
    return Promise.resolve(tenants.filter((row) => row.Status !== "vacated" && !(leavesOutArchived && row.ArchivedAt)));
  }
  if (/FROM dbo\.RentReviews\s+WHERE State IN/.test(sql)) {
    return Promise.resolve(stored.filter((r) => OPEN.includes(r.State)).map((r) => ({ ...r })));
  }
  if (/INSERT INTO dbo\.RentReviews/.test(sql)) {
    writes.push("insert");
    const tenantId = param("TenantId") as number;
    if (uniqueViolationFor === tenantId || stored.some((r) => r.TenantId === tenantId && OPEN.includes(r.State))) {
      return Promise.reject(Object.assign(new Error("Cannot insert duplicate key row (UX_RentReviews_OpenPerTenant)"), { number: 2601 }));
    }
    stored.push({
      BuildingId: param("BuildingId") as number,
      Method: param("Method") as string,
      ReviewId: param("ReviewId") as string,
      ReviewType: param("ReviewType") as string,
      ScheduledFor: asDate(param("ScheduledFor") as string),
      State: "scheduled",
      Status: param("Status") as string,
      TenantId: tenantId,
    });
    return Promise.resolve([]);
  }
  if (/UPDATE dbo\.RentReviews/.test(sql) && /State = 'due'/.test(sql)) {
    writes.push("open_window");
    const review = stored.find((r) => r.ReviewId === param("ReviewId") && r.State === "scheduled");
    if (!review) return Promise.resolve([]);
    review.State = "due";
    review.Status = param("Status") as string;
    return Promise.resolve([{ ReviewId: review.ReviewId }]);
  }
  return Promise.reject(new Error(`unexpected SQL: ${sql}`));
}

const run = (over: Partial<Parameters<typeof runReviewGenerator>[0]> = {}) => {
  const log = jest.fn();
  const warn = jest.fn();
  const onError = jest.fn();
  return runReviewGenerator({ connection: CONNECTION, dryRun: false, log, onError, today: TODAY, warn, windowDays: 60, ...over }).then(
    (report) => ({ log, onError, report, warn }),
  );
};

beforeEach(() => {
  jest.clearAllMocks();
  tenants = [];
  stored = [];
  writes = [];
  uniqueViolationFor = null;
  failLedgerFor = null;
  db.executeQuery.mockImplementation(fakeSql);
  db.beginTransaction.mockResolvedValue(undefined);
  db.commitTransaction.mockResolvedValue(undefined);
  db.rollbackTransaction.mockResolvedValue(undefined);
});

describe("settings", () => {
  it("is off unless RENT_REVIEW_GENERATOR_ENABLED is exactly true", () => {
    expect(generatorMode({} as NodeJS.ProcessEnv)).toBe("off");
    for (const value of ["1", "yes", "TRUE", "True", " true", ""]) {
      expect(generatorMode({ RENT_REVIEW_GENERATOR_ENABLED: value } as NodeJS.ProcessEnv)).toBe("off");
    }
    expect(generatorMode({ RENT_REVIEW_GENERATOR_ENABLED: "true" } as NodeJS.ProcessEnv)).toBe("live");
  });

  it("a dry run needs no enabling and wins over it", () => {
    expect(generatorMode({ RENT_REVIEW_GENERATOR_DRY_RUN: "true" } as NodeJS.ProcessEnv)).toBe("dry-run");
    expect(
      generatorMode({ RENT_REVIEW_GENERATOR_DRY_RUN: "true", RENT_REVIEW_GENERATOR_ENABLED: "true" } as NodeJS.ProcessEnv),
    ).toBe("dry-run");
    expect(
      generatorMode({ RENT_REVIEW_GENERATOR_DRY_RUN: "false", RENT_REVIEW_GENERATOR_ENABLED: "false" } as NodeJS.ProcessEnv),
    ).toBe("off");
  });

  it("reads REVIEW_WINDOW_DAYS, defaulting to 60", () => {
    expect(DEFAULT_REVIEW_WINDOW_DAYS).toBe(60);
    expect(reviewWindowDays({} as NodeJS.ProcessEnv)).toBe(60);
    expect(reviewWindowDays({ REVIEW_WINDOW_DAYS: "30" } as NodeJS.ProcessEnv)).toBe(30);
    expect(reviewWindowDays({ REVIEW_WINDOW_DAYS: "0" } as NodeJS.ProcessEnv)).toBe(0);
    for (const bad of ["-1", "abc", "1.5", "367", " "]) {
      expect(reviewWindowDays({ REVIEW_WINDOW_DAYS: bad } as NodeJS.ProcessEnv)).toBe(60);
    }
  });
});

describe("planGenerator", () => {
  const facts = (rows: SqlRow[]) => rows.map(toTenancyFacts);
  const open = (entries: Array<[number, OpenReview]>) => new Map(entries);

  it("schedules a tenancy with no open review for its derived date, with the method from its review type", () => {
    const plan = planGenerator(facts([tenancy(1, DAY(120))]), open([]), TODAY, 60);
    expect(plan.actions).toEqual([
      {
        buildingId: 5,
        daysUntil: 120,
        kind: "schedule",
        method: "cpi",
        methodSource: "review_type",
        opensWindow: false,
        scheduledFor: DAY(120),
        tenantId: 1,
        tenantName: "Tenant 1 Pty Ltd",
      },
    ]);
  });

  it("opens the window straight away when the date is already inside it, overdue dates included", () => {
    const plan = planGenerator(facts([tenancy(1, DAY(60)), tenancy(2, DAY(61)), tenancy(3, DAY(-20))]), open([]), TODAY, 60);
    expect(plan.actions.map((a) => [a.tenantId, a.kind === "schedule" && a.opensWindow])).toEqual([
      [1, true], // exactly 60 days out is inside
      [2, false],
      [3, true],
    ]);
  });

  it("takes the method from the step on the review date before the review type", () => {
    const review = DAY(90);
    const steps = JSON.stringify([
      { baseRentPerAnnum: 100000, effectiveFrom: addMonthsClamped(review, -12), id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", methodKind: "commencement", ratePercent: 0 },
      { effectiveFrom: review, id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", methodKind: "fixed", ratePercent: 3 },
    ]);
    const plan = planGenerator(facts([tenancy(1, review, { ReviewType: "CPI Darwin (June)", ScheduledRateSteps: steps })]), open([]), TODAY, 60);
    expect(plan.actions[0]).toMatchObject({ method: "fixed", methodSource: "step", scheduledFor: review });
  });

  it("falls back to other for a review type nothing recognises, and for a blank one, because someone has to classify the lease", () => {
    const plan = planGenerator(
      facts([tenancy(1, DAY(90), { ReviewType: "Special arrangement" }), tenancy(2, DAY(90), { ReviewType: "" }), tenancy(3, DAY(90), { ReviewType: "   " })]),
      open([]),
      TODAY,
      60,
    );
    expect(plan.skipped).toEqual([]);
    expect(plan.actions.map((a) => a.kind === "schedule" && [a.tenantId, a.method, a.methodSource])).toEqual([
      [1, "other", "fallback"],
      [2, "other", "fallback"],
      [3, "other", "fallback"],
    ]);
  });

  describe("a lease with no review clause (ReviewType none)", () => {
    it.each(["none", "None", " NONE "])("is skipped as no_review_clause, not given an other review: %j", (reviewType) => {
      const plan = planGenerator(facts([tenancy(1, DAY(90), { ReviewType: reviewType })]), open([]), TODAY, 60);
      expect(plan.actions).toEqual([]);
      expect(plan.skipped).toEqual([{ reason: "no_review_clause", tenantId: 1 }]);
      expect(plan.unchanged).toBe(0);
    });

    it("still gets the review a step on the date names: a fixed step schedules a fixed review", () => {
      const review = DAY(90);
      const plan = planGenerator(facts([tenancy(1, review, { ReviewType: "none", ScheduledRateSteps: stepsFor(review, "fixed") })]), open([]), TODAY, 60);
      expect(plan.skipped).toEqual([]);
      expect(plan.actions).toEqual([expect.objectContaining({ kind: "schedule", method: "fixed", methodSource: "step", scheduledFor: review, tenantId: 1 })]);
    });

    it("counts a step that names other: that is a method somebody chose", () => {
      const review = DAY(90);
      const plan = planGenerator(facts([tenancy(1, review, { ReviewType: "none", ScheduledRateSteps: stepsFor(review, "other") })]), open([]), TODAY, 60);
      expect(plan.actions).toEqual([expect.objectContaining({ kind: "schedule", method: "other", methodSource: "step" })]);
    });

    it("is not rescued by a step on the date that names no method, or by a step on an earlier date", () => {
      const review = DAY(90);
      // Last year's review was a fixed step, now settled; this year's date has no step.
      const lastYearsStep = JSON.stringify([
        { baseRentPerAnnum: 100000, effectiveFrom: addMonthsClamped(review, -24), id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", methodKind: "commencement", ratePercent: 0 },
        { effectiveFrom: addMonthsClamped(review, -12), id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", methodKind: "fixed", ratePercent: 3 },
      ]);
      expect(nextReviewFor(tenancy(2, review, { ScheduledRateSteps: lastYearsStep }), TODAY)).toBe(review);

      const plan = planGenerator(
        facts([
          tenancy(1, review, { ReviewType: "none", ScheduledRateSteps: stepsFor(review, undefined) }),
          tenancy(2, review, { ReviewType: "none", ScheduledRateSteps: lastYearsStep }),
          // The same schedule on a lease nobody has classified is scheduled for the same date: it is the clause that skips tenancy 2.
          tenancy(3, review, { ReviewType: "", ScheduledRateSteps: lastYearsStep }),
        ]),
        open([]),
        TODAY,
        60,
      );
      expect(plan.skipped).toEqual([
        { reason: "no_review_clause", tenantId: 1 },
        { reason: "no_review_clause", tenantId: 2 },
      ]);
      expect(plan.actions).toEqual([expect.objectContaining({ kind: "schedule", method: "other", scheduledFor: review, tenantId: 3 })]);
    });

    it("does not touch a tenancy that already has an open review: that review runs on as usual", () => {
      const plan = planGenerator(
        facts([tenancy(1, DAY(45), { ReviewType: "none" })]),
        open([[1, { method: "other", reviewId: "r1", scheduledFor: DAY(45), state: "scheduled" }]]),
        TODAY,
        60,
      );
      expect(plan.skipped).toEqual([]);
      expect(plan.actions).toEqual([expect.objectContaining({ kind: "open_window", reviewId: "r1", tenantId: 1 })]);
    });
  });

  it("skips an archived tenancy like a vacated one, with or without an open review", () => {
    const archivedAt = asDate(DAY(-30));
    const plan = planGenerator(
      facts([tenancy(1, DAY(10), { ArchivedAt: archivedAt }), tenancy(2, DAY(10), { ArchivedAt: archivedAt }), tenancy(3, DAY(10))]),
      open([[2, { method: "cpi", reviewId: "r2", scheduledFor: DAY(10), state: "scheduled" }]]),
      TODAY,
      60,
    );
    expect(plan.skipped).toEqual([
      { reason: "archived", tenantId: 1 },
      { reason: "archived", tenantId: 2 },
    ]);
    // Only the live tenancy is scheduled; the archived one's open review is left exactly as it is.
    expect(plan.actions).toEqual([expect.objectContaining({ kind: "schedule", tenantId: 3 })]);
    expect(plan.drift).toEqual([]);
    expect(plan.unchanged).toBe(0);
  });

  it("reads a tenancy as archived only when its ArchivedAt is set, so a restored one is live again", () => {
    expect(toTenancyFacts(tenancy(1, DAY(10))).archived).toBe(false);
    expect(toTenancyFacts(tenancy(1, DAY(10), { ArchivedAt: null })).archived).toBe(false);
    expect(toTenancyFacts(tenancy(1, DAY(10), { ArchivedAt: asDate(DAY(-1)) })).archived).toBe(true);
  });

  it("derives the date for today instead of reading the stored NextReviewDate", () => {
    const review = DAY(200);
    const steps = JSON.stringify([
      { baseRentPerAnnum: 100000, effectiveFrom: addMonthsClamped(review, -12), id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", methodKind: "commencement", ratePercent: 0 },
      { effectiveFrom: review, id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", methodKind: "fixed", ratePercent: 3 },
    ]);
    // The stored column still says January 2020 (it only moves on a write or a recompute).
    const plan = planGenerator(facts([tenancy(1, review, { NextReviewDate: asDate("2020-01-01"), ScheduledRateSteps: steps })]), open([]), TODAY, 60);
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]).toMatchObject({ kind: "schedule", scheduledFor: review });
  });

  it("keeps the stored date when there is nothing to derive one from, as the screens do", () => {
    const plan = planGenerator(
      facts([tenancy(1, null, { NextReviewDate: asDate(DAY(40)) })]),
      open([]),
      TODAY,
      60,
    );
    expect(plan.actions[0]).toMatchObject({ kind: "schedule", opensWindow: true, scheduledFor: DAY(40) });
  });

  it("skips a tenancy with no review date at all, and a vacated one", () => {
    const plan = planGenerator(facts([tenancy(1, null), tenancy(2, DAY(10), { Status: "vacated" })]), open([]), TODAY, 60);
    expect(plan.actions).toEqual([]);
    expect(plan.skipped).toEqual([
      { reason: "no_review_date", tenantId: 1 },
      { reason: "vacated", tenantId: 2 },
    ]);
  });

  it("opens the window on a scheduled review that has come inside it, and only on one that is scheduled", () => {
    const reviews: Array<[number, OpenReview]> = [
      [1, { method: "cpi", reviewId: "r1", scheduledFor: DAY(45), state: "scheduled" }],
      [2, { method: "cpi", reviewId: "r2", scheduledFor: DAY(45), state: "due" }],
      [3, { method: "cpi", reviewId: "r3", scheduledFor: DAY(45), state: "in_progress" }],
      [4, { method: "cpi", reviewId: "r4", scheduledFor: DAY(100), state: "scheduled" }],
    ];
    const plan = planGenerator(facts([tenancy(1, DAY(45)), tenancy(2, DAY(45)), tenancy(3, DAY(45)), tenancy(4, DAY(100))]), open(reviews), TODAY, 60);
    expect(plan.actions).toEqual([
      expect.objectContaining({ kind: "open_window", reviewId: "r1", tenantId: 1 }),
    ]);
    expect(plan.unchanged).toBe(3);
  });

  it("schedules nothing second: a tenancy that already has an open review gets no new one", () => {
    const plan = planGenerator(
      facts([tenancy(1, DAY(100))]),
      open([[1, { method: "cpi", reviewId: "r1", scheduledFor: DAY(100), state: "scheduled" }]]),
      TODAY,
      60,
    );
    expect(plan.actions).toEqual([]);
    expect(plan.unchanged).toBe(1);
  });

  it("counts, and leaves alone, an open review dated differently from today's derivation", () => {
    const plan = planGenerator(
      facts([tenancy(1, DAY(100))]),
      open([[1, { method: "cpi", reviewId: "r1", scheduledFor: DAY(-30), state: "in_progress" }]]),
      TODAY,
      60,
    );
    expect(plan.actions).toEqual([]);
    expect(plan.drift).toEqual([{ derived: DAY(100), reviewId: "r1", scheduledFor: DAY(-30), state: "in_progress", tenantId: 1 }]);
    expect(plan.unchanged).toBe(0);
  });

  it("is a fixed point: carrying the plan out and planning again gives nothing to do", () => {
    const rows = [tenancy(1, DAY(120)), tenancy(2, DAY(30)), tenancy(3, DAY(-20)), tenancy(4, null)];
    const first = planGenerator(facts(rows), open([]), TODAY, 60);
    const opened = new Map<number, OpenReview>();
    for (const action of first.actions) {
      if (action.kind === "schedule") {
        opened.set(action.tenantId, {
          method: action.method,
          reviewId: `r${action.tenantId}`,
          scheduledFor: action.scheduledFor,
          state: action.opensWindow ? "due" : "scheduled",
        });
      }
    }
    const second = planGenerator(facts(rows), opened, TODAY, 60);
    expect(first.actions).toHaveLength(3);
    expect(second.actions).toEqual([]);
    expect(second.drift).toEqual([]);
    expect(second.unchanged).toBe(3);
  });
});

describe("runReviewGenerator, live", () => {
  beforeEach(() => {
    tenants = [
      tenancy(1, DAY(120)),
      tenancy(2, DAY(30), { ReviewType: "Fixed 3%" }),
      tenancy(3, DAY(-20), { BuildingId: 9, ReviewType: "Market on Expiry" }),
      tenancy(4, null),
      tenancy(5, DAY(10), { Status: "vacated" }),
    ];
  });

  it("creates one review per tenancy, in the state its date calls for, with values the legacy checks accept", async () => {
    const { report } = await run();

    expect(report).toMatchObject({ errors: [], scheduled: 3, tenancies: 4, windowsOpened: 2, raced: 0 });
    const byTenant = new Map(stored.map((r) => [r.TenantId, r]));
    expect([...byTenant.keys()].sort()).toEqual([1, 2, 3]);
    expect(byTenant.get(1)).toMatchObject({ BuildingId: 5, Method: "cpi", ReviewType: "cpi", ScheduledFor: asDate(DAY(120)), State: "scheduled", Status: "upcoming" });
    expect(byTenant.get(2)).toMatchObject({ Method: "fixed", ReviewType: "fixedPercent", State: "due", Status: "due" });
    expect(byTenant.get(3)).toMatchObject({ BuildingId: 9, Method: "market", ReviewType: "marketReview", ScheduledFor: asDate(DAY(-20)), State: "due" });
    for (const review of stored) {
      expect(LEGACY_REVIEW_TYPES).toContain(review.ReviewType);
      expect(LEGACY_STATUSES).toContain(review.Status);
      expect(review.ReviewId).toMatch(/^[0-9a-f-]{36}$/);
    }
    // One open review per tenancy.
    expect(new Set(stored.map((r) => r.TenantId)).size).toBe(stored.length);
  });

  it("changes nothing when run again", async () => {
    await run();
    const after = JSON.stringify(stored);
    writes = [];
    const ledgerBefore = ledgerRows().length;
    db.beginTransaction.mockClear();

    const { report } = await run();

    expect(JSON.stringify(stored)).toBe(after);
    expect(writes).toEqual([]);
    expect(ledgerRows()).toHaveLength(ledgerBefore);
    expect(db.beginTransaction).not.toHaveBeenCalled();
    expect(report).toMatchObject({ errors: [], scheduled: 0, unchanged: 3, windowsOpened: 0 });
    expect(report.actions).toEqual([]);
  });

  it("opens the window later, on the day the date comes inside it, and not before", async () => {
    await run();
    const stillScheduled = stored.find((r) => r.TenantId === 1) as StoredReview;
    expect(stillScheduled.State).toBe("scheduled");

    const { report } = await run({ today: DAY(59) }); // review on DAY(120) is now 61 days out
    expect(report.actions).toEqual([]);

    const later = await run({ today: DAY(60) }); // 60 days out
    expect(later.report.actions).toEqual([expect.objectContaining({ kind: "open_window", tenantId: 1 })]);
    expect((stored.find((r) => r.TenantId === 1) as StoredReview).State).toBe("due");
    expect(ledgerRows().at(-1)).toMatchObject({
      action: "rent_review.open_window",
      after: { state: "due" },
      before: { state: "scheduled" },
      tenantId: 1,
    });
  });

  it("writes a ledger row for every transition, as the system actor, in the transaction that made it", async () => {
    await run();

    const rows = ledgerRows();
    // 3 schedules and 2 window openings
    expect(rows.map((row) => row.action).sort()).toEqual([
      "rent_review.open_window",
      "rent_review.open_window",
      "rent_review.schedule",
      "rent_review.schedule",
      "rent_review.schedule",
    ]);
    const correlationIds = new Set(rows.map((row) => row.correlationId));
    expect(correlationIds.size).toBe(1);
    expect([...correlationIds][0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    for (const row of rows) {
      expect(row).toMatchObject({ actorKind: "system", actorName: GENERATOR_ACTOR.name, subjectType: "rent_review" });
      expect(row.actorName).toBe("tenancyReviewScheduleTimer");
      expect(stored.map((r) => r.ReviewId)).toContain(row.subjectId);
      expect([5, 9]).toContain(row.buildingId);
    }
    const scheduleFor2 = rows.find((row) => row.action === "rent_review.schedule" && row.tenantId === 2);
    expect(scheduleFor2).toMatchObject({
      after: { method: "fixed", methodSource: "review_type", scheduledFor: DAY(30), state: "scheduled" },
      ruleApplied: "derived_next_review",
    });
    expect(rows.find((row) => row.action === "rent_review.open_window")).toMatchObject({ ruleApplied: "review_window_60_days" });
    // Every transition is its own transaction: 5 begins, 5 commits, no rollbacks.
    expect(db.beginTransaction).toHaveBeenCalledTimes(5);
    expect(db.commitTransaction).toHaveBeenCalledTimes(5);
    expect(db.rollbackTransaction).not.toHaveBeenCalled();
    // The schedule row precedes its window opening.
    const order = rows.filter((row) => row.tenantId === 3).map((row) => row.action);
    expect(order).toEqual(["rent_review.schedule", "rent_review.open_window"]);
  });

  it("refreshes the cached tenancy it changed", async () => {
    await run();
    expect(cache.invalidateTenantAndBuilding).toHaveBeenCalledWith(1, 5);
    expect(cache.invalidateTenantAndBuilding).toHaveBeenCalledWith(3, 9);
  });

  it("rolls a transition back, and carries on with the others, when its ledger row fails", async () => {
    failLedgerFor = { action: "rent_review.schedule", tenantId: 2 };

    const { onError, report, warn } = await run();

    expect(report.errors).toEqual([{ message: "ledger unavailable", tenantId: 2 }]);
    expect(onError).toHaveBeenCalledWith(expect.any(Error), 2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("tenancy 2 failed: ledger unavailable"));
    expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(report).toMatchObject({ scheduled: 2 });
  });

  it("still counts a review as scheduled when only opening its window fails, and reports the failure", async () => {
    failLedgerFor = { action: "rent_review.open_window", tenantId: 3 };

    const { onError, report } = await run();

    expect(report).toMatchObject({ errors: [{ message: "ledger unavailable", tenantId: 3 }], scheduled: 3, windowsOpened: 1 });
    expect(onError).toHaveBeenCalledWith(expect.any(Error), 3);
    // Tenancy 3 was scheduled in its own transaction before the window step failed.
    expect(ledgerRows().some((row) => row.action === "rent_review.schedule" && row.tenantId === 3)).toBe(true);
    expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
  });

  it("treats the unique index refusing a second open review as another run getting there first", async () => {
    uniqueViolationFor = 1;

    const { report } = await run();

    expect(report).toMatchObject({ errors: [], raced: 1, scheduled: 2 });
    expect(stored.some((r) => r.TenantId === 1)).toBe(false);
    expect(ledgerRows().some((row) => row.tenantId === 1)).toBe(false);
    expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
  });

  it("does not open a window on a review someone commenced after the plan was made", async () => {
    await run({ today: DAY(100) }); // schedules, and opens windows where inside
    stored.find((r) => r.TenantId === 1)!.State = "scheduled";
    const racing = stored.find((r) => r.TenantId === 1) as StoredReview;
    // The plan sees `scheduled`; by the time the UPDATE runs the review has moved on.
    const original = db.executeQuery.getMockImplementation() as typeof fakeSql;
    db.executeQuery.mockImplementation((c: unknown, sql: string, params?: Param[]) => {
      if (/State = 'due'/.test(sql)) racing.State = "in_progress";
      return original(c, sql, params);
    });
    const ledgerBefore = ledgerRows().length;

    const { report } = await run({ today: DAY(100) });

    expect(report.raced).toBeGreaterThanOrEqual(1);
    expect(racing.State).toBe("in_progress");
    expect(ledgerRows().slice(ledgerBefore).some((row) => row.action === "rent_review.open_window" && row.tenantId === 1)).toBe(false);
  });

  it("warns about, and leaves alone, an open review dated differently from the derivation", async () => {
    stored.push({
      BuildingId: 5,
      Method: "cpi",
      ReviewId: "existing-review",
      ReviewType: "cpi",
      ScheduledFor: asDate(DAY(500)),
      State: "in_progress",
      Status: "due",
      TenantId: 1,
    });

    const { report, warn } = await run();

    expect(report.drift).toEqual([expect.objectContaining({ reviewId: "existing-review", scheduledFor: DAY(500), derived: DAY(120) })]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("left as it is"));
    expect(stored.filter((r) => r.TenantId === 1)).toHaveLength(1);
    expect(stored.find((r) => r.ReviewId === "existing-review")?.ScheduledFor).toEqual(asDate(DAY(500)));
  });
});

describe("runReviewGenerator, tenancies out of scope", () => {
  const tenanciesSql = () =>
    (db.executeQuery.mock.calls as Array<[unknown, string]>).map(([, sql]) => sql).find((sql) => /FROM dbo\.Tenants t/.test(sql)) as string;

  beforeEach(() => {
    tenants = [
      tenancy(1, DAY(120)),
      tenancy(2, DAY(30), { ArchivedAt: asDate(DAY(-5)) }),
      tenancy(3, DAY(30), { ReviewType: "none" }),
      tenancy(4, DAY(30), { ReviewType: "none", ScheduledRateSteps: stepsFor(DAY(30), "fixed") }),
    ];
  });

  it("leaves archived tenancies out in the SQL, so they are not even read or counted", async () => {
    const { report } = await run();

    expect(tenanciesSql()).toMatch(/WHERE t\.Status <> 'vacated' AND t\.ArchivedAt IS NULL/);
    expect(report.tenancies).toBe(3); // 1, 3 and 4: tenancy 2 never left the database
    expect(report.skipped.map((skip) => skip.tenantId)).not.toContain(2);
  });

  it("writes nothing for an archived tenancy or a lease with no review clause, and still schedules the method a step names", async () => {
    const { report } = await run();

    expect(report).toMatchObject({ errors: [], scheduled: 2 });
    expect(report.skipped).toEqual([{ reason: "no_review_clause", tenantId: 3 }]);
    expect(stored.map((review) => review.TenantId).sort()).toEqual([1, 4]);
    expect(stored.find((review) => review.TenantId === 4)).toMatchObject({ Method: "fixed", ReviewType: "fixedPercent", State: "due" });
    const ledgered = ledgerRows().map((row) => row.tenantId);
    expect(ledgered).not.toContain(2);
    expect(ledgered).not.toContain(3);
  });

  it("leaves an archived tenancy's open review exactly as it is, and picks it up again once the tenancy is restored", async () => {
    stored.push({
      BuildingId: 5,
      Method: "cpi",
      ReviewId: "kept",
      ReviewType: "cpi",
      ScheduledFor: asDate(DAY(30)),
      State: "scheduled",
      Status: "upcoming",
      TenantId: 2,
    });

    await run();
    expect(stored.find((review) => review.ReviewId === "kept")?.State).toBe("scheduled"); // inside the window, but out of scope

    tenants[1] = tenancy(2, DAY(30)); // restored: ArchivedAt cleared
    const { report } = await run();
    expect(stored.find((review) => review.ReviewId === "kept")?.State).toBe("due");
    expect(report).toMatchObject({ errors: [], scheduled: 0, windowsOpened: 1 });
  });

  it("counts the lease with no review clause among the skipped in a dry run too", async () => {
    const { log } = await run({ dryRun: true });
    expect(log.mock.calls.at(-1)?.[0]).toMatch(/3 tenancies checked on 2026-10-14 .*, 1 skipped,/);
    expect(stored).toEqual([]);
  });
});

describe("runReviewGenerator, dry run", () => {
  beforeEach(() => {
    tenants = [tenancy(1, DAY(120)), tenancy(2, DAY(30)), tenancy(3, DAY(-20))];
    stored.push({
      BuildingId: 5,
      Method: "cpi",
      ReviewId: "existing",
      ReviewType: "cpi",
      ScheduledFor: asDate(DAY(40)),
      State: "scheduled",
      Status: "upcoming",
      TenantId: 4,
    });
    tenants.push(tenancy(4, DAY(40)));
  });

  it("reads, logs what it would create or move with counts, and writes nothing", async () => {
    const before = JSON.stringify(stored);

    const { log, report } = await run({ dryRun: true });

    expect(JSON.stringify(stored)).toBe(before);
    expect(writes).toEqual([]);
    expect(db.beginTransaction).not.toHaveBeenCalled();
    expect(db.commitTransaction).not.toHaveBeenCalled();
    expect(ledgerRows()).toEqual([]);
    expect(cache.invalidateTenantAndBuilding).not.toHaveBeenCalled();
    // Only reads reached the database.
    for (const [, sql] of db.executeQuery.mock.calls as Array<[unknown, string]>) {
      expect(sql).not.toMatch(/\b(INSERT|UPDATE)\b/i);
    }
    expect(report).toMatchObject({ dryRun: true, scheduled: 3, windowsOpened: 3, tenancies: 4 });
    const lines = log.mock.calls.map(([line]) => String(line));
    expect(lines.some((line) => /would schedule Tenant 1 Pty Ltd \(tenancy 1\) for .*, cpi$/.test(line))).toBe(true);
    expect(lines.some((line) => /would open the window on Tenant 4 Pty Ltd/.test(line))).toBe(true);
    expect(lines.at(-1)).toMatch(/dry run, nothing written\. 4 tenancies checked on 2026-10-14 \(window 60 days\): 3 to schedule, 3 windows to open/);
  });

  it("then a live run does exactly what the dry run said", async () => {
    const dry = await run({ dryRun: true });
    const live = await run();
    expect(live.report.scheduled).toBe(dry.report.scheduled);
    expect(live.report.windowsOpened).toBe(dry.report.windowsOpened);
    expect(live.report.actions).toEqual(dry.report.actions);
  });
});

describe("escalating (the timer asks for it)", () => {
  beforeEach(() => {
    tenants = [tenancy(1, DAY(5))];
  });

  it("runs the review escalation step after its own work, as the generator, live or dry", async () => {
    const { report } = await run({ escalate: true });
    expect(runReviewEscalations).toHaveBeenCalledWith(CONNECTION, expect.objectContaining({ actor: GENERATOR_ACTOR, dryRun: false, today: TODAY }));
    expect(report.escalations).toEqual({ ended: 0, errors: [], raised: 2, truncated: false });

    await run({ dryRun: true, escalate: true });
    expect(runReviewEscalations.mock.calls[1][1]).toMatchObject({ dryRun: true });
  });

  it("doesn't escalate unless asked", async () => {
    const { report } = await run();
    expect(runReviewEscalations).not.toHaveBeenCalled();
    expect(report.escalations).toBeNull();
  });
});

describe("scheduleNextReview: SCHEDULE for one tenancy, after a decision", () => {
  it("schedules the tenancy's next review by the generator's own plan and writes, and opens its window when it is due soon", async () => {
    tenants = [tenancy(1, DAY(30)), tenancy(2, DAY(40))];
    const result = await scheduleNextReview(CONNECTION, 1, { today: TODAY, windowDays: 60 });
    expect(result).toEqual({ review: { reviewId: expect.any(String), scheduledFor: DAY(30), state: "due" }, skipped: null });
    expect(stored.map((r) => r.TenantId)).toEqual([1]);
    expect(ledgerRows().map((r) => [r.action, r.actorName])).toEqual([
      ["rent_review.schedule", GENERATOR_ACTOR.name],
      ["rent_review.open_window", GENERATOR_ACTOR.name],
    ]);
  });

  it("returns the open review a tenancy already has, and writes nothing", async () => {
    tenants = [tenancy(1, DAY(120))];
    await scheduleNextReview(CONNECTION, 1, { today: TODAY, windowDays: 60 });
    writes = [];
    const again = await scheduleNextReview(CONNECTION, 1, { today: TODAY, windowDays: 60 });
    expect(again.review).toMatchObject({ scheduledFor: DAY(120), state: "scheduled" });
    expect(writes).toEqual([]);
  });

  it("gives a vacated or archived tenancy nothing", async () => {
    tenants = [tenancy(1, DAY(30), { Status: "vacated" }), tenancy(2, DAY(30), { ArchivedAt: new Date() })];
    await expect(scheduleNextReview(CONNECTION, 1, { today: TODAY })).resolves.toEqual({ review: null, skipped: "vacated" });
    await expect(scheduleNextReview(CONNECTION, 2, { today: TODAY })).resolves.toEqual({ review: null, skipped: "vacated" });
    expect(writes).toEqual([]);
  });

  it("gives a lease with no review clause nothing, and says why", async () => {
    tenants = [tenancy(1, DAY(30), { ReviewType: "none" })];
    await expect(scheduleNextReview(CONNECTION, 1, { today: TODAY })).resolves.toEqual({ review: null, skipped: "no_review_clause" });
  });
});
