/// <reference types="jest" />
// commenceRentReview: scheduled or due -> in_progress, with the checks (C1, C2),
// the 409 on a stale write, the owner, the basis snapshot, the step link and
// the ledger row, all in one transaction. The ledger is the real one, read back
// from the INSERTs it sent.
import type { InvocationContext } from "@azure/functions";
import { clearRoleCache } from "../auth";
import { commenceRentReview } from "../functions/commenceRentReview";
import { LEGACY_REVIEW_TYPES, LEGACY_STATUSES } from "../rentReview/legacyMap";
import {
  callsMatching,
  DAY,
  ledgerRowsOf,
  NEXT_VERSION_HEX,
  postRequest,
  reviewRow,
  rowVersion,
  routeSql,
  tenancyRow,
  VERSION_HEX,
  type Param,
  type Row,
} from "./fixtures/rentReviewFakes";

jest.mock("../db", () => ({
  beginTransaction: jest.fn(),
  closeConnection: jest.fn(),
  commitTransaction: jest.fn(),
  createRequestConnection: jest.fn(),
  executeQuery: jest.fn(),
  rollbackTransaction: jest.fn(),
}));
jest.mock("../ledger/actor", () => ({ resolveLedgerActor: jest.fn() }));
jest.mock("../tenant-register-cache", () => ({ invalidateTenantAndBuilding: jest.fn() }));

const db = require("../db") as Record<"beginTransaction" | "closeConnection" | "commitTransaction" | "createRequestConnection" | "executeQuery" | "rollbackTransaction", jest.Mock>;
const { resolveLedgerActor } = require("../ledger/actor") as { resolveLedgerActor: jest.Mock };
const cache = require("../tenant-register-cache") as { invalidateTenantAndBuilding: jest.Mock };
const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;

const ANN = { kind: "user", name: "Ann Accounts", role: "accounts", userId: 7 };
const STEP_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const BODY = { reviewId: "rev-1", rowVersion: VERSION_HEX };

let stored: Row;
let tenancy: Row | null;
let otherOpen: Row[];
let updateMoves: boolean;

function serve() {
  routeSql(db.executeQuery, [
    [/INSERT INTO dbo\.DecisionLedger/, () => []],
    [/RentReviews r WITH \(UPDLOCK, ROWLOCK\)/, () => [stored]],
    [/FROM dbo\.RentReviews r\s+INNER JOIN/, () => [stored]],
    [/FROM dbo\.Tenants t\s+LEFT JOIN dbo\.Buildings/, () => (tenancy ? [tenancy] : [])],
    [/SELECT TOP 1 ReviewId FROM dbo\.RentReviews/, () => otherOpen],
    [
      /UPDATE dbo\.RentReviews/,
      (params: Param[]) => {
        if (!updateMoves) return [];
        const p = Object.fromEntries(params.map((x) => [x.name, x.value]));
        stored = {
          ...stored,
          Basis: p.Basis,
          BuildingId: p.BuildingId,
          Method: p.Method,
          OwnerName: "Ann Accounts",
          OwnerUserId: p.OwnerUserId,
          ReviewType: p.ReviewType,
          State: "in_progress",
          Status: p.Status,
          StepId: p.StepId,
          Version: rowVersion(NEXT_VERSION_HEX),
        };
        return [{ ReviewId: p.ReviewId }];
      },
    ],
  ]);
}

const commenceRaw = (body: unknown, roles: string | null = "accounts") => commenceRentReview(postRequest(body, roles), ctx);
const commence = (body: unknown = BODY, roles: string | null = "accounts") => commenceRaw(body, roles);
const writes = () => callsMatching(db.executeQuery, /\b(UPDATE|INSERT INTO)\b/).filter(({ sql }) => !sql.includes("DecisionLedger"));

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "warn").mockImplementation(() => undefined); // the dev role override warns on every call
  clearRoleCache();
  process.env.DEV_ROLE_OVERRIDE_ENABLED = "true";
  delete process.env.AZURE_FUNCTIONS_ENVIRONMENT;
  db.createRequestConnection.mockResolvedValue({});
  db.beginTransaction.mockResolvedValue(undefined);
  db.commitTransaction.mockResolvedValue(undefined);
  db.rollbackTransaction.mockResolvedValue(undefined);
  resolveLedgerActor.mockResolvedValue(ANN);
  stored = reviewRow();
  tenancy = tenancyRow();
  otherOpen = [];
  updateMoves = true;
  serve();
});

describe("who may commence", () => {
  it("needs a token", async () => {
    expect((await commence(BODY, null)).status).toBe(401);
    expect(db.createRequestConnection).not.toHaveBeenCalled();
  });

  it.each(["accounts", "accounts_manager", "cfo", "director", "admin"])("lets %s, an editor of tenancies", async (role) => {
    expect((await commence(BODY, role)).status).toBe(200);
  });

  it.each(["facilities", "facilities_manager", "user"])("refuses %s before touching the database", async (role) => {
    expect((await commence(BODY, role)).status).toBe(403);
    expect(db.createRequestConnection).not.toHaveBeenCalled();
  });

  it("refuses a caller whose token can't be tied to a Floorplan user", async () => {
    resolveLedgerActor.mockResolvedValue(null);
    expect((await commence()).status).toBe(401);
    expect(writes()).toHaveLength(0);
  });

  it("refuses a caller with no user id, because the owner has to be a person who can be found", async () => {
    resolveLedgerActor.mockResolvedValue({ ...ANN, userId: null });
    const res = await commence();
    expect(res.status).toBe(422);
    expect(res.jsonBody).toMatchObject({ code: "no_user" });
    expect(writes()).toHaveLength(0);
  });
});

describe("the request", () => {
  it.each([
    ["no body", undefined],
    ["a list", []],
    ["no reviewId", { rowVersion: VERSION_HEX }],
    ["a reviewId with spaces", { reviewId: "rev 1", rowVersion: VERSION_HEX }],
    ["no rowVersion", { reviewId: "rev-1" }],
    ["a short rowVersion", { reviewId: "rev-1", rowVersion: "0a01" }],
    ["a rowVersion that isn't hex", { reviewId: "rev-1", rowVersion: "zzzzzzzzzzzzzzzz" }],
    ["a numeric rowVersion", { reviewId: "rev-1", rowVersion: 7 }],
  ])("refuses %s with a 400, and reads nothing", async (_label, body) => {
    const res = await commenceRaw(body);
    expect(res.status).toBe(400);
    expect(db.executeQuery).not.toHaveBeenCalled();
    expect(db.beginTransaction).not.toHaveBeenCalled();
  });

  it("accepts the rowVersion in either case", async () => {
    expect((await commence({ reviewId: "rev-1", rowVersion: VERSION_HEX.toUpperCase() })).status).toBe(200);
  });

  it("is a 404 for a review that doesn't exist, rolled back", async () => {
    routeSql(db.executeQuery, [[/RentReviews r WITH \(UPDLOCK, ROWLOCK\)/, () => []]]);
    const res = await commence();
    expect(res.status).toBe(404);
    expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(db.commitTransaction).not.toHaveBeenCalled();
  });
});

describe("a stale write is a 409", () => {
  it("refuses a rowVersion that isn't the current one, and says what the review looks like now", async () => {
    stored = reviewRow({ Version: rowVersion(NEXT_VERSION_HEX), OwnerUserId: 9, OwnerName: "Bo Manager", State: "in_progress" });

    const res = await commence({ reviewId: "rev-1", rowVersion: VERSION_HEX });

    expect(res.status).toBe(409);
    expect(res.jsonBody).toMatchObject({
      code: "stale",
      current: { ownerName: "Bo Manager", reviewId: "rev-1", rowVersion: NEXT_VERSION_HEX, state: "in_progress" },
    });
    expect((res.jsonBody as { error: string }).error).toMatch(/Someone else changed this review/);
    expect(writes()).toHaveLength(0);
    expect(ledgerRowsOf(db.executeQuery)).toHaveLength(0);
    expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(db.commitTransaction).not.toHaveBeenCalled();
    expect(cache.invalidateTenantAndBuilding).not.toHaveBeenCalled();
  });

  it("checks the version before the state, so a client learns it is out of date", async () => {
    stored = reviewRow({ State: "approved", Version: rowVersion(NEXT_VERSION_HEX) });
    expect((await commence()).jsonBody).toMatchObject({ code: "stale" });
  });

  it("locks the review row for the whole check-and-write", async () => {
    await commence();
    const [{ sql }] = callsMatching(db.executeQuery, /UPDLOCK/);
    expect(sql).toContain("FROM dbo.RentReviews r WITH (UPDLOCK, ROWLOCK)");
    expect(sql).toContain("r.State IS NOT NULL");
  });
});

describe("only a scheduled or due review can be commenced", () => {
  it.each(["in_progress", "awaiting_index", "referred", "awaiting_approval", "approved", "completed", "waived", "cancelled"])(
    "refuses a %s review with a 409 and writes nothing",
    async (state) => {
      stored = reviewRow({ State: state });
      const res = await commence();
      expect(res.status).toBe(409);
      expect(res.jsonBody).toMatchObject({ code: "invalid_state", state });
      expect(writes()).toHaveLength(0);
      expect(ledgerRowsOf(db.executeQuery)).toHaveLength(0);
    },
  );

  it.each(["scheduled", "due"])("commences a %s review", async (state) => {
    stored = reviewRow({ State: state, Status: state === "due" ? "due" : "upcoming" });
    const res = await commence();
    expect(res.status).toBe(200);
    expect((res.jsonBody as { review: { state: string } }).review.state).toBe("in_progress");
  });

  it("says so when someone else commenced it between the check and the write", async () => {
    updateMoves = false;
    const res = await commence();
    expect(res.status).toBe(409);
    expect(res.jsonBody).toMatchObject({ code: "invalid_state" });
    expect(ledgerRowsOf(db.executeQuery)).toHaveLength(0);
    expect(db.commitTransaction).not.toHaveBeenCalled();
  });
});

describe("C1: the tenancy is live and has no other open review", () => {
  it("refuses a vacated tenancy", async () => {
    tenancy = tenancyRow({ Status: "vacated" });
    const res = await commence();
    expect(res.status).toBe(422);
    expect(res.jsonBody).toMatchObject({ code: "tenancy_vacated" });
    expect(writes()).toHaveLength(0);
    expect(ledgerRowsOf(db.executeQuery)).toHaveLength(0);
    expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
  });

  it("commences a tenancy that is in holdover or pending", async () => {
    for (const status of ["holdover", "pending", "current"]) {
      tenancy = tenancyRow({ Status: status });
      stored = reviewRow();
      expect((await commence()).status).toBe(200);
    }
  });

  it("refuses when the tenancy has another open review, and names it", async () => {
    otherOpen = [{ ReviewId: "rev-older" }];
    const res = await commence();
    expect(res.status).toBe(422);
    expect(res.jsonBody).toMatchObject({ code: "open_review_exists", reviewId: "rev-older" });
    expect(writes()).toHaveLength(0);
    expect(ledgerRowsOf(db.executeQuery)).toHaveLength(0);
  });

  it("asks about the tenancy's open reviews other than this one, by parameter", async () => {
    await commence();
    const [{ params, sql }] = callsMatching(db.executeQuery, /SELECT TOP 1 ReviewId/);
    expect(params).toMatchObject({ ReviewId: "rev-1", TenantId: 7 });
    expect(Object.values(params)).toEqual(expect.arrayContaining(["scheduled", "due", "in_progress", "awaiting_index", "referred", "awaiting_approval"]));
    expect(sql).toContain("ReviewId <> @ReviewId");
    expect(Object.values(params)).not.toContain("approved");
  });

  it("is a 404 when the review's tenancy is gone", async () => {
    tenancy = null;
    expect((await commence()).status).toBe(404);
  });
});

describe("C2: the method", () => {
  const stepsWith = (kind: string | undefined) =>
    JSON.stringify([
      { baseRentPerAnnum: 100000, effectiveFrom: DAY(-400), id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", methodKind: "commencement", ratePercent: 0 },
      { effectiveFrom: DAY(10), id: STEP_ID, ...(kind ? { methodKind: kind } : {}), ratePercent: 3 },
    ]);

  const methodOf = async () => {
    const res = await commence();
    expect(res.status).toBe(200);
    const [update] = callsMatching(db.executeQuery, /UPDATE dbo\.RentReviews/);
    return { ledger: ledgerRowsOf(db.executeQuery)[0], update: update.params };
  };

  it("takes the method from the step dated on the review's day", async () => {
    tenancy = tenancyRow({ ReviewType: "CPI Darwin (June)", ScheduledRateSteps: stepsWith("fixed") });
    const { ledger, update } = await methodOf();
    expect(update).toMatchObject({ Method: "fixed", ReviewType: "fixedPercent", StepId: STEP_ID });
    expect(ledger.ruleApplied).toBe("method_from_step");
  });

  it("takes it from the tenancy's review type when the step names none", async () => {
    tenancy = tenancyRow({ ReviewType: "Market on Expiry", ScheduledRateSteps: stepsWith(undefined) });
    const { ledger, update } = await methodOf();
    expect(update).toMatchObject({ Method: "market", ReviewType: "marketReview", StepId: STEP_ID });
    expect(ledger.ruleApplied).toBe("method_from_review_type");
  });

  it("falls to other when nothing recognises it, and still commences", async () => {
    tenancy = tenancyRow({ ReviewType: "Special arrangement" });
    const { ledger, update } = await methodOf();
    expect(update).toMatchObject({ Method: "other", ReviewType: "none", StepId: null });
    expect(ledger.ruleApplied).toBe("method_other_fallback");
  });

  it("re-reads the method at commence, so a lease edited since SCHEDULE is what the review follows", async () => {
    stored = reviewRow({ Method: "fixed", ReviewType: "fixedPercent" });
    tenancy = tenancyRow({ ReviewType: "CPI Darwin (June)" });
    const { ledger, update } = await methodOf();
    expect(update).toMatchObject({ Method: "cpi", ReviewType: "cpi" });
    expect(ledger.before).toMatchObject({ method: "fixed" });
    expect(ledger.after).toMatchObject({ method: "cpi" });
  });

  it("only links a step dated on the review's own day", async () => {
    tenancy = tenancyRow({
      ScheduledRateSteps: JSON.stringify([
        { effectiveFrom: DAY(11), id: STEP_ID, methodKind: "cpi", ratePercent: 3 },
        { effectiveFrom: DAY(9), id: "cccccccc-cccc-cccc-cccc-cccccccccccc", methodKind: "cpi", ratePercent: 3 },
      ]),
    });
    expect((await methodOf()).update.StepId).toBeNull();
  });
});

describe("what commencing does", () => {
  it("makes the caller the owner", async () => {
    const res = await commence();
    const body = res.jsonBody as { review: Record<string, any> };
    expect(callsMatching(db.executeQuery, /UPDATE dbo\.RentReviews/)[0].params.OwnerUserId).toBe(7);
    expect(body.review).toMatchObject({ ownerName: "Ann Accounts", ownerUserId: 7, rowVersion: NEXT_VERSION_HEX, state: "in_progress" });
  });

  it("snapshots the basis from the lease", async () => {
    await commence();
    const [{ params }] = callsMatching(db.executeQuery, /UPDATE dbo\.RentReviews/);
    expect(JSON.parse(params.Basis as string)).toEqual({
      capPercent: 5,
      floorPercent: 1,
      intervalMonths: 12,
      method: "cpi",
      ratchet: true,
      referenceQuarterRule: "quarter_before_review_date",
      region: "DARWIN",
      reviewDate: DAY(10),
      reviewType: "CPI Darwin (June)",
    });
  });

  it("snapshots a fixed review's percentage, and a market review's empty clause and deadlines", async () => {
    tenancy = tenancyRow({ FixedReviewPercent: 3.5, ReviewType: "Fixed" });
    await commence();
    expect(JSON.parse(callsMatching(db.executeQuery, /UPDATE dbo\.RentReviews/)[0].params.Basis as string)).toMatchObject({
      fixedPercent: 3.5,
      method: "fixed",
    });
    jest.clearAllMocks();
    stored = reviewRow();
    tenancy = tenancyRow({ ReviewType: "Market" });
    await commence();
    expect(JSON.parse(callsMatching(db.executeQuery, /UPDATE dbo\.RentReviews/)[0].params.Basis as string)).toMatchObject({
      deadlines: [],
      leaseClause: null,
      method: "market",
    });
  });

  it("links the step on the review's date when there is one", async () => {
    tenancy = tenancyRow({
      ScheduledRateSteps: JSON.stringify([
        { baseRentPerAnnum: 100000, effectiveFrom: DAY(-400), id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", methodKind: "commencement", ratePercent: 0 },
        { cpiValue: 103.2, effectiveFrom: DAY(10), id: STEP_ID, methodKind: "cpi", ratePercent: 3 },
      ]),
    });
    const res = await commence();
    expect(callsMatching(db.executeQuery, /UPDATE dbo\.RentReviews/)[0].params.StepId).toBe(STEP_ID);
    expect((res.jsonBody as { review: { stepId: string } }).review.stepId).toBe(STEP_ID);
  });

  it("links nothing when no step is dated that day, and never creates one", async () => {
    await commence();
    expect(callsMatching(db.executeQuery, /UPDATE dbo\.RentReviews/)[0].params.StepId).toBeNull();
    // The only write besides the ledger row is the review's own UPDATE: the schedule is untouched.
    expect(writes().map(({ sql }) => sql.match(/(UPDATE|INSERT INTO) (dbo\.\w+)/)?.slice(1).join(" "))).toEqual(["UPDATE dbo.RentReviews"]);
    expect(callsMatching(db.executeQuery, /dbo\.Tenants/).every(({ sql }) => /^\s*SELECT/i.test(sql))).toBe(true);
  });

  it("moves the legacy columns with it, to values the old checks accept", async () => {
    await commence();
    const [{ params }] = callsMatching(db.executeQuery, /UPDATE dbo\.RentReviews/);
    expect(params.Status).toBe("due");
    expect(LEGACY_STATUSES).toContain(params.Status);
    expect(LEGACY_REVIEW_TYPES).toContain(params.ReviewType);
  });

  it("records the tenancy's building on the review", async () => {
    tenancy = tenancyRow({ BuildingId: 12 });
    await commence();
    expect(callsMatching(db.executeQuery, /UPDATE dbo\.RentReviews/)[0].params.BuildingId).toBe(12);
  });

  it("updates only a review that is still scheduled or due", async () => {
    await commence();
    expect(callsMatching(db.executeQuery, /UPDATE dbo\.RentReviews/)[0].sql).toContain("State IN ('scheduled', 'due')");
  });

  it("refreshes the cached tenancy once it has committed", async () => {
    await commence();
    expect(cache.invalidateTenantAndBuilding).toHaveBeenCalledWith(7, 5);
  });
});

describe("the ledger", () => {
  it("records rent_review.commence for the caller, with the before and after", async () => {
    tenancy = tenancyRow({
      ScheduledRateSteps: JSON.stringify([{ cpiValue: 103.2, effectiveFrom: DAY(10), id: STEP_ID, methodKind: "cpi", ratePercent: 3 }]),
    });

    await commence();

    const rows = ledgerRowsOf(db.executeQuery);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "rent_review.commence",
      actorKind: "user",
      actorName: "Ann Accounts",
      actorRole: "accounts",
      actorUserId: 7,
      before: { method: "cpi", ownerUserId: null, state: "due", stepId: null },
      buildingId: 5,
      isException: false,
      reason: null,
      ruleApplied: "method_from_step",
      subjectId: "rev-1",
      subjectType: "rent_review",
      tenantId: 7,
    });
    expect(rows[0].after).toMatchObject({ method: "cpi", ownerUserId: 7, state: "in_progress", stepId: STEP_ID });
    expect(rows[0].after?.basis).toMatchObject({ method: "cpi", region: "DARWIN", reviewDate: DAY(10) });
  });

  it("is in the same transaction as the change: begin, update, ledger row, commit", async () => {
    await commence();
    const begin = db.beginTransaction.mock.invocationCallOrder[0];
    const commit = db.commitTransaction.mock.invocationCallOrder[0];
    const order = (pattern: RegExp) =>
      db.executeQuery.mock.invocationCallOrder[db.executeQuery.mock.calls.findIndex((call) => pattern.test(String(call[1])))];
    expect(begin).toBeLessThan(order(/RentReviews r WITH \(UPDLOCK/));
    expect(order(/UPDATE dbo\.RentReviews/)).toBeLessThan(order(/INSERT INTO dbo\.DecisionLedger/));
    expect(order(/INSERT INTO dbo\.DecisionLedger/)).toBeLessThan(commit);
    expect(db.rollbackTransaction).not.toHaveBeenCalled();
  });

  it("no ledger row, no commence: a failed ledger write rolls the whole thing back", async () => {
    routeSql(db.executeQuery, [
      [/INSERT INTO dbo\.DecisionLedger/, () => Promise.reject(new Error("ledger unavailable"))],
      [/RentReviews r WITH \(UPDLOCK, ROWLOCK\)/, () => [stored]],
      [/FROM dbo\.Tenants t\s+LEFT JOIN dbo\.Buildings/, () => [tenancyRow()]],
      [/SELECT TOP 1 ReviewId FROM dbo\.RentReviews/, () => []],
      [/UPDATE dbo\.RentReviews/, () => [{ ReviewId: "rev-1" }]],
    ]);

    const res = await commence();

    expect(res.status).toBe(500);
    expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(db.commitTransaction).not.toHaveBeenCalled();
    expect(cache.invalidateTenantAndBuilding).not.toHaveBeenCalled();
  });

  it("answers a ledger refusal with a 400 and rolls back", async () => {
    resolveLedgerActor.mockResolvedValue({ ...ANN, role: "" });
    const res = await commence();
    expect(res.status).toBe(400);
    expect((res.jsonBody as { error: string }).error).toMatch(/role/);
    expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(db.commitTransaction).not.toHaveBeenCalled();
  });
});

describe("its responses", () => {
  it("returns the review as it now stands", async () => {
    const res = await commence();
    expect(res.status).toBe(200);
    const { review } = res.jsonBody as { review: Record<string, any> };
    expect(review).toMatchObject({
      buildingId: 5,
      method: "cpi",
      overdue: false,
      reviewId: "rev-1",
      scheduledFor: DAY(10),
      state: "in_progress",
      tenantId: 7,
    });
    expect(review.basis).toMatchObject({ method: "cpi" });
  });

  it("closes the connection however it ends", async () => {
    await commence();
    routeSql(db.executeQuery, [[/RentReviews r WITH \(UPDLOCK, ROWLOCK\)/, () => []]]);
    await commence();
    expect(db.closeConnection).toHaveBeenCalledTimes(2);
  });
});
