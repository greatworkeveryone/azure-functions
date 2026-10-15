/// <reference types="jest" />
// INDEX_AVAILABLE (WP26): after the CPI sync, a review waiting for its index
// goes back to in progress once both its quarters are in CpiIndex on one base,
// ledgered as the CPI timer (the real ledger, read back from its INSERTs). A dry
// run only says so; a review someone moved on meanwhile is left alone.
import { addMonthsClamped, todayInDarwin } from "../darwinDate";
import { previousQuarter, referenceQuarter } from "../rentReview/cpi";
import { awaitingReviewOf, CPI_TIMER_ACTOR, indexPublished, resumeAwaitingIndex } from "../rentReview/indexResume";
import { callsMatching, ledgerRowsOf, routeSql, type Param } from "./fixtures/rentReviewFakes";

jest.mock("../db", () => ({
  beginTransaction: jest.fn().mockResolvedValue(undefined),
  commitTransaction: jest.fn().mockResolvedValue(undefined),
  executeQuery: jest.fn(),
  rollbackTransaction: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../tenant-register-cache", () => ({ invalidateTenantAndBuilding: jest.fn() }));
jest.mock("../sentry", () => ({ Sentry: { captureException: jest.fn() } }));

const db = require("../db") as Record<string, jest.Mock>;
const cache = require("../tenant-register-cache") as { invalidateTenantAndBuilding: jest.Mock };
const connection = {} as never;

const REVIEW_DATE = addMonthsClamped(todayInDarwin(), -1);
const REFERENCE = referenceQuarter(REVIEW_DATE);
const PREVIOUS = previousQuarter(REFERENCE, 12);
const BASE = "Sep 2025 = 100.0";

const waitingRow = (over: Record<string, unknown> = {}) => ({
  Basis: JSON.stringify({ intervalMonths: 12, method: "cpi", region: "DARWIN" }),
  ExpectedIndexAt: null,
  OwnerUserId: 7,
  ReviewId: "rev-1",
  ScheduledFor: new Date(`${REVIEW_DATE}T00:00:00Z`),
  TenantBuildingId: 5,
  TenantId: 7,
  ...over,
});

let waiting: Array<Record<string, unknown>>;
let cpi: Array<Record<string, unknown>>;
let moves: boolean;

beforeEach(() => {
  jest.clearAllMocks();
  waiting = [waitingRow()];
  cpi = [
    { IndexValue: 100, Period: PREVIOUS, ReferenceBase: BASE },
    { IndexValue: 103.2, Period: REFERENCE, ReferenceBase: BASE },
  ];
  moves = true;
  routeSql(db.executeQuery, [
    [/INSERT INTO dbo\.DecisionLedger/, () => []],
    [/WHERE r\.State = 'awaiting_index'/, () => waiting],
    [/FROM dbo\.CpiIndex/, (params: Param[]) => cpi.filter((row) => params.some((p) => p.value === row.Period))],
    [/UPDATE dbo\.RentReviews/, (params: Param[]) => (moves ? [{ ReviewId: params.find((p) => p.name === "ReviewId")?.value }] : [])],
  ]);
});

const run = (dryRun = false) => resumeAwaitingIndex(connection, { dryRun, log: jest.fn(), warn: jest.fn() });

describe("which waiting reviews can go back", () => {
  it("reads the quarters from the review's basis and date", () => {
    expect(awaitingReviewOf(waitingRow())).toMatchObject({ previousQuarter: PREVIOUS, referenceQuarter: REFERENCE, region: "DARWIN", reviewId: "rev-1" });
    expect(awaitingReviewOf(waitingRow({ Basis: JSON.stringify({ intervalMonths: 24, region: "aus" }) }))).toMatchObject({
      previousQuarter: previousQuarter(REFERENCE, 24),
      region: "AUS",
    });
  });

  it("needs both quarters, on the same known base", () => {
    const review = awaitingReviewOf(waitingRow());
    const rows = (base: string | null) => [
      { indexValue: 100, period: PREVIOUS, referenceBase: BASE },
      { indexValue: 103.2, period: REFERENCE, referenceBase: base },
    ];
    expect(indexPublished(review, rows(BASE))).toBe(true);
    expect(indexPublished(review, rows("Jun 2026 = 100.0"))).toBe(false);
    expect(indexPublished(review, rows(null))).toBe(false);
    expect(indexPublished(review, rows(BASE).slice(0, 1))).toBe(false);
  });
});

describe("resumeAwaitingIndex", () => {
  it("moves a review whose quarter is now published back to in progress, ledgered as the CPI timer", async () => {
    expect(await run()).toEqual({ errors: [], resumed: 1, waiting: 0 });
    const [update] = callsMatching(db.executeQuery, /UPDATE dbo\.RentReviews/);
    expect(update.sql).toMatch(/WHERE ReviewId = @ReviewId AND State IN \(@From0\)/);
    expect(update.params).toMatchObject({ From0: "awaiting_index", Status: "due", To: "in_progress" });
    expect(update.sql).toContain("ExpectedIndexAt = NULL");
    expect(ledgerRowsOf(db.executeQuery)).toEqual([
      expect.objectContaining({
        action: "rent_review.index_available",
        actorKind: "system",
        actorName: CPI_TIMER_ACTOR.name,
        ruleApplied: "reference_quarter_published",
        subjectId: "rev-1",
        tenantId: 7,
      }),
    ]);
    expect(ledgerRowsOf(db.executeQuery)[0].after).toMatchObject({ ownerUserId: 7, referenceQuarter: REFERENCE, state: "in_progress" });
    expect(db.commitTransaction).toHaveBeenCalledTimes(1);
    expect(cache.invalidateTenantAndBuilding).toHaveBeenCalledWith(7, 5);
  });

  it("leaves a review whose quarter still isn't published", async () => {
    cpi = cpi.filter((row) => row.Period !== REFERENCE);
    expect(await run()).toEqual({ errors: [], resumed: 0, waiting: 1 });
    expect(callsMatching(db.executeQuery, /UPDATE/)).toEqual([]);
  });

  it("leaves a review someone moved on meanwhile, without a ledger row", async () => {
    moves = false;
    expect(await run()).toEqual({ errors: [], resumed: 0, waiting: 0 });
    expect(ledgerRowsOf(db.executeQuery)).toEqual([]);
  });

  it("writes nothing in a dry run, and says what it would move", async () => {
    expect(await run(true)).toEqual({ errors: [], resumed: 1, waiting: 0 });
    expect(callsMatching(db.executeQuery, /\b(UPDATE|INSERT)\b/)).toEqual([]);
    expect(db.beginTransaction).not.toHaveBeenCalled();
  });

  it("rolls a review back and carries on with the rest when its ledger row fails", async () => {
    waiting = [waitingRow(), waitingRow({ ReviewId: "rev-2", TenantId: 8 })];
    routeSql(db.executeQuery, [
      [/INSERT INTO dbo\.DecisionLedger/, (params: Param[]) => (params.find((p) => p.name === "SubjectId")?.value === "rev-1" ? Promise.reject(new Error("ledger down")) : [])],
      [/WHERE r\.State = 'awaiting_index'/, () => waiting],
      [/FROM dbo\.CpiIndex/, (params: Param[]) => cpi.filter((row) => params.some((p) => p.value === row.Period))],
      [/UPDATE dbo\.RentReviews/, (params: Param[]) => [{ ReviewId: params.find((p) => p.name === "ReviewId")?.value }]],
    ]);
    const report = await run();
    expect(report).toEqual({ errors: [{ message: "ledger down", reviewId: "rev-1" }], resumed: 1, waiting: 0 });
    expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
  });
});
