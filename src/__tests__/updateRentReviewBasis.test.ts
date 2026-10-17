/// <reference types="jest" />
// updateRentReviewBasis: corrections to the basis of a review that is being
// worked on. Needs a reason; ledgered with before and after; only in_progress or
// awaiting_index; only the owner or an accounts manager and up; 409 when stale.
import type { InvocationContext } from "@azure/functions";
import { clearRoleCache } from "../auth";
import { updateRentReviewBasis } from "../functions/updateRentReviewBasis";
import { buildBasisSnapshot } from "../rentReview/basis";
import {
  callsMatching,
  DAY,
  ledgerRowsOf,
  NEXT_VERSION_HEX,
  postRequest,
  reviewRow,
  rowVersion,
  routeSql,
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
const BASIS = buildBasisSnapshot({
  cpiCapPercent: 5,
  cpiFloorPercent: 1,
  cpiRegion: "DARWIN",
  fixedReviewPercent: null,
  intervalMonths: 12,
  method: "cpi",
  ratchet: true,
  reviewDate: DAY(10),
  reviewType: "CPI Darwin (June)",
  step: null,
});
const REASON = "The lease caps the increase at 4%, not 5%";
const BODY = { basis: { capPercent: 4 }, reason: REASON, reviewId: "rev-1", rowVersion: VERSION_HEX };

let stored: Row;
let saveMoves: boolean;

const inProgress = (over: Row = {}): Row =>
  reviewRow({ Basis: JSON.stringify(BASIS), OwnerName: "Ann Accounts", OwnerUserId: 7, State: "in_progress", ...over });

function serve() {
  routeSql(db.executeQuery, [
    [/INSERT INTO dbo\.DecisionLedger/, () => []],
    [/RentReviews r WITH \(UPDLOCK, ROWLOCK\)/, () => [stored]],
    [/FROM dbo\.RentReviews r\s+INNER JOIN/, () => [stored]],
    [
      /UPDATE dbo\.RentReviews/,
      (params: Param[]) => {
        if (!saveMoves) return [];
        const p = Object.fromEntries(params.map((x) => [x.name, x.value]));
        stored = { ...stored, Basis: p.Basis, Version: rowVersion(NEXT_VERSION_HEX) };
        return [{ ReviewId: p.ReviewId }];
      },
    ],
  ]);
}

const update = (body: unknown = BODY, roles: string | null = "accounts") => updateRentReviewBasis(postRequest(body, roles), ctx);
const saves = () => callsMatching(db.executeQuery, /UPDATE dbo\.RentReviews/);

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "warn").mockImplementation(() => undefined); // the dev role override warns on every call
  clearRoleCache();
  process.env.DEV_ROLE_OVERRIDE_ENABLED = "true";
  process.env.AZURE_FUNCTIONS_ENVIRONMENT = "Development"; // the override only applies there (jwt.ts isDevOverrideEnabled)
  db.createRequestConnection.mockResolvedValue({});
  db.beginTransaction.mockResolvedValue(undefined);
  db.commitTransaction.mockResolvedValue(undefined);
  db.rollbackTransaction.mockResolvedValue(undefined);
  resolveLedgerActor.mockResolvedValue(ANN);
  stored = inProgress();
  saveMoves = true;
  serve();
});

describe("a reason is required", () => {
  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["blank", "   "],
    ["not text", 5],
    ["null", null],
  ])("refuses a basis change whose reason is %s, before reading anything", async (_label, reason) => {
    const res = await update({ ...BODY, reason });
    expect(res.status).toBe(400);
    expect(res.jsonBody).toMatchObject({ code: "reason_required" });
    expect(db.executeQuery).not.toHaveBeenCalled();
    expect(db.beginTransaction).not.toHaveBeenCalled();
  });

  it("refuses a reason longer than the ledger holds", async () => {
    const res = await update({ ...BODY, reason: "x".repeat(2001) });
    expect(res.status).toBe(400);
    expect(db.executeQuery).not.toHaveBeenCalled();
  });

  it("and the ledger would refuse it too, if the endpoint ever let it through", () => {
    // basis_update is a reasoned code in the registry, whatever the handler checks.
    const { assertLedgerEntry } = jest.requireActual("../ledger") as typeof import("../ledger");
    const entry = { action: "rent_review.basis_update" as const, actor: ANN as never, subject: { id: "rev-1", type: "rent_review" as const } };
    expect(() => assertLedgerEntry(entry)).toThrow(/reason is required/);
    expect(() => assertLedgerEntry({ ...entry, reason: "   " })).toThrow(/reason is required/);
    expect(() => assertLedgerEntry({ ...entry, reason: REASON })).not.toThrow();
  });

  it("records the reason, trimmed, on the ledger row", async () => {
    await update({ ...BODY, reason: `  ${REASON}  ` });
    expect(ledgerRowsOf(db.executeQuery)[0].reason).toBe(REASON);
  });
});

describe("who may change the basis", () => {
  it("needs a token and a tenancy editor's role", async () => {
    expect((await update(BODY, null)).status).toBe(401);
    for (const role of ["facilities", "facilities_manager", "user"]) {
      expect((await update(BODY, role)).status).toBe(403);
    }
    expect(db.createRequestConnection).not.toHaveBeenCalled();
  });

  it("lets the review's owner, whatever their role", async () => {
    stored = inProgress({ OwnerUserId: 7 });
    expect((await update(BODY, "accounts")).status).toBe(200);
  });

  it("refuses an accounts clerk who doesn't own the review", async () => {
    stored = inProgress({ OwnerUserId: 9, OwnerName: "Bo Manager" });
    const res = await update(BODY, "accounts");
    expect(res.status).toBe(403);
    expect(res.jsonBody).toMatchObject({ code: "forbidden" });
    expect(saves()).toHaveLength(0);
    expect(ledgerRowsOf(db.executeQuery)).toHaveLength(0);
    expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
  });

  it.each(["accounts_manager", "cfo", "director", "admin"])("lets %s change a review someone else owns", async (role) => {
    stored = inProgress({ OwnerUserId: 9, OwnerName: "Bo Manager" });
    expect((await update(BODY, role)).status).toBe(200);
  });

  it("does not treat an unowned review as everyone's", async () => {
    stored = inProgress({ OwnerName: null, OwnerUserId: null });
    expect((await update(BODY, "accounts")).status).toBe(403);
    expect((await update(BODY, "accounts_manager")).status).toBe(200);
  });

  it("refuses a caller whose token can't be tied to a Floorplan user", async () => {
    resolveLedgerActor.mockResolvedValue(null);
    expect((await update()).status).toBe(401);
  });
});

describe("when the basis can be changed", () => {
  it.each(["in_progress", "awaiting_index"])("in a %s review", async (state) => {
    stored = inProgress({ State: state });
    expect((await update()).status).toBe(200);
  });

  it.each(["scheduled", "due", "referred", "awaiting_approval", "approved", "completed", "waived", "cancelled"])(
    "not in a %s review: 409, nothing written",
    async (state) => {
      stored = inProgress({ State: state });
      const res = await update();
      expect(res.status).toBe(409);
      expect(res.jsonBody).toMatchObject({ code: "invalid_state", state });
      expect(saves()).toHaveLength(0);
      expect(ledgerRowsOf(db.executeQuery)).toHaveLength(0);
    },
  );

  it("not in a review of an archived tenancy: 422 with a plain sentence, nothing written, even for the owner and an admin", async () => {
    for (const role of ["accounts", "admin"]) {
      jest.clearAllMocks();
      stored = inProgress({ OwnerUserId: 7, TenantArchivedAt: new Date("2026-10-01T00:00:00Z") });
      const res = await update(BODY, role);
      expect(res.status).toBe(422);
      expect(res.jsonBody).toMatchObject({
        code: "tenancy_archived",
        error: "This tenancy has been archived, so its rent review can't be changed.",
      });
      expect(saves()).toHaveLength(0);
      expect(ledgerRowsOf(db.executeQuery)).toHaveLength(0);
      expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
      expect(db.commitTransaction).not.toHaveBeenCalled();
      expect(cache.invalidateTenantAndBuilding).not.toHaveBeenCalled();
    }
  });

  it("reads the tenancy's archive stamp with the review, under the same lock", async () => {
    await update();
    const [{ sql }] = callsMatching(db.executeQuery, /RentReviews r WITH \(UPDLOCK, ROWLOCK\)/);
    expect(sql).toContain("t.ArchivedAt AS TenantArchivedAt");
  });

  it("changes the basis again once the tenancy is restored", async () => {
    stored = inProgress({ TenantArchivedAt: null });
    expect((await update()).status).toBe(200);
  });

  it("is a 404 for a review that doesn't exist", async () => {
    routeSql(db.executeQuery, [[/RentReviews r WITH \(UPDLOCK, ROWLOCK\)/, () => []]]);
    expect((await update()).status).toBe(404);
  });

  it("is a 409 for a stale rowVersion, with the review as it is now", async () => {
    stored = inProgress({ OwnerUserId: 9, OwnerName: "Bo Manager", Version: rowVersion(NEXT_VERSION_HEX) });
    const res = await update(BODY, "accounts_manager");
    expect(res.status).toBe(409);
    expect(res.jsonBody).toMatchObject({ code: "stale", current: { ownerName: "Bo Manager", rowVersion: NEXT_VERSION_HEX } });
    expect(saves()).toHaveLength(0);
    expect(ledgerRowsOf(db.executeQuery)).toHaveLength(0);
    expect(db.commitTransaction).not.toHaveBeenCalled();
  });

  it("says so when the review moved on between the check and the write", async () => {
    saveMoves = false;
    const res = await update();
    expect(res.status).toBe(409);
    expect(res.jsonBody).toMatchObject({ code: "invalid_state" });
    expect(ledgerRowsOf(db.executeQuery)).toHaveLength(0);
    expect(db.commitTransaction).not.toHaveBeenCalled();
  });

  it("writes only to a review that is still in progress or waiting for the index", async () => {
    await update();
    expect(saves()[0].sql).toContain("State IN ('in_progress', 'awaiting_index')");
  });

  it("drops the review's calculation with the old basis (WP26): it was worked on terms that no longer stand", async () => {
    await update();
    expect(saves()[0].sql).toMatch(/SET Basis = @Basis, Calc = NULL,/);
  });
});

describe("what it changes", () => {
  it("merges the named fields into the stored basis and keeps the rest", async () => {
    const res = await update({ ...BODY, basis: { capPercent: 4, region: "AUS" } });

    expect(res.status).toBe(200);
    const [{ params }] = saves();
    expect(JSON.parse(params.Basis as string)).toEqual({ ...BASIS, capPercent: 4, region: "AUS" });
    const { review } = res.jsonBody as { review: Record<string, any> };
    expect(review.basis).toMatchObject({ capPercent: 4, floorPercent: 1, method: "cpi", region: "AUS", reviewDate: DAY(10) });
    expect(review.rowVersion).toBe(NEXT_VERSION_HEX);
  });

  it("clears a field with null", async () => {
    await update({ ...BODY, basis: { floorPercent: null } });
    expect(JSON.parse(saves()[0].params.Basis as string)).toMatchObject({ floorPercent: null });
  });

  it.each([
    ["an unknown field", { colour: "red" }],
    ["a field that belongs to another method", { fixedPercent: 3 }],
    ["the review date", { reviewDate: "2030-01-01" }],
    ["the method", { method: "fixed" }],
    ["a cap that isn't a number", { capPercent: "high" }],
    ["a floor above the cap", { floorPercent: 9 }],
    ["an empty change", {}],
    ["no change at all", undefined],
    ["a list", []],
  ])("refuses %s with a 400", async (_label, basis) => {
    const res = await update({ ...BODY, basis });
    expect(res.status).toBe(400);
    expect(saves()).toHaveLength(0);
    expect(ledgerRowsOf(db.executeQuery)).toHaveLength(0);
    expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
  });

  it("refuses a change that changes nothing, so no empty decision is recorded", async () => {
    const res = await update({ ...BODY, basis: { capPercent: 5, region: "DARWIN" } });
    expect(res.status).toBe(400);
    expect(res.jsonBody).toMatchObject({ code: "no_change" });
    expect(ledgerRowsOf(db.executeQuery)).toHaveLength(0);
  });

  it("works from the fields the review's method allows", async () => {
    const market = () => inProgress({ Basis: JSON.stringify({ ...BASIS, method: "market" }), Method: "market" });
    stored = market();
    expect((await update({ ...BODY, basis: { leaseClause: "Clause 4.2", deadlines: [{ date: DAY(60), label: "Notice" }] } })).status).toBe(200);
    stored = market();
    expect((await update({ ...BODY, basis: { capPercent: 4 } })).status).toBe(400);
  });
});

describe("the ledger", () => {
  it("records rent_review.basis_update with the reason and the fields that changed, before and after", async () => {
    await update({ ...BODY, basis: { capPercent: 4, floorPercent: 1, region: "AUS" } });

    const rows = ledgerRowsOf(db.executeQuery);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "rent_review.basis_update",
      actorKind: "user",
      actorName: "Ann Accounts",
      actorRole: "accounts",
      actorUserId: 7,
      after: { capPercent: 4, region: "AUS" },
      before: { capPercent: 5, region: "DARWIN" },
      buildingId: 5,
      isException: true,
      reason: REASON,
      subjectId: "rev-1",
      subjectType: "rent_review",
      tenantId: 7,
    });
  });

  it("shows up in the review's decision history, which is read by subject", async () => {
    await update();
    const [row] = ledgerRowsOf(db.executeQuery);
    expect([row.subjectType, row.subjectId]).toEqual(["rent_review", "rev-1"]);
  });

  it("is in the same transaction as the change: begin, update, ledger row, commit", async () => {
    await update();
    const order = (pattern: RegExp) =>
      db.executeQuery.mock.invocationCallOrder[db.executeQuery.mock.calls.findIndex((call) => pattern.test(String(call[1])))];
    expect(db.beginTransaction.mock.invocationCallOrder[0]).toBeLessThan(order(/RentReviews r WITH \(UPDLOCK/));
    expect(order(/UPDATE dbo\.RentReviews/)).toBeLessThan(order(/INSERT INTO dbo\.DecisionLedger/));
    expect(order(/INSERT INTO dbo\.DecisionLedger/)).toBeLessThan(db.commitTransaction.mock.invocationCallOrder[0]);
    expect(db.rollbackTransaction).not.toHaveBeenCalled();
  });

  it("no ledger row, no change: a failed ledger write rolls the update back", async () => {
    routeSql(db.executeQuery, [
      [/INSERT INTO dbo\.DecisionLedger/, () => Promise.reject(new Error("ledger unavailable"))],
      [/RentReviews r WITH \(UPDLOCK, ROWLOCK\)/, () => [stored]],
      [/UPDATE dbo\.RentReviews/, () => [{ ReviewId: "rev-1" }]],
    ]);

    const res = await update();

    expect(res.status).toBe(500);
    expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(db.commitTransaction).not.toHaveBeenCalled();
    expect(cache.invalidateTenantAndBuilding).not.toHaveBeenCalled();
  });

  it("refreshes the cached tenancy once it has committed", async () => {
    await update();
    expect(cache.invalidateTenantAndBuilding).toHaveBeenCalledWith(7, 5);
  });
});
