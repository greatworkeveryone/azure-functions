/// <reference types="jest" />
// The named manager answers an attributed approval or an accepted variance
// (R2, R13): only they may, once; "I didn't agree" needs a reason, is ledgered
// as an exception and escalates. DB and the engine's writes are mocked; the real
// ledger runs, so the INSERT record() sends is what is asserted.
import { HttpRequest, InvocationContext } from "@azure/functions";
import { ledgerInserts } from "../__tests__/fixtures/ledgerCalls";

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn(), storageQueue: jest.fn(), timer: jest.fn() } };
});
jest.mock("../db", () => ({
  beginTransaction: jest.fn(),
  closeConnection: jest.fn(),
  commitTransaction: jest.fn(),
  createRequestConnection: jest.fn(),
  executeQuery: jest.fn(),
  rollbackTransaction: jest.fn(),
}));
jest.mock("../auth", () => {
  const actual = jest.requireActual("../auth");
  return {
    ...actual,
    errorResponse: jest.fn().mockReturnValue({ jsonBody: { error: "Error" }, status: 500 }),
    extractToken: jest.fn().mockReturnValue("mock-token"),
    rolesForRequest: jest.fn(),
    unauthorizedResponse: jest.fn().mockReturnValue({ jsonBody: { error: "Unauthorized" }, status: 401 }),
    verifiedIdentityFromRequest: jest.fn(),
  };
});
jest.mock("../escalation/engine", () => ({
  ...jest.requireActual("../escalation/engine"),
  raiseWithin: jest.fn(),
  resolveWithin: jest.fn(),
}));
jest.mock("../escalation/store", () => ({ ...jest.requireActual("../escalation/store"), findLiveEscalation: jest.fn() }));
jest.mock("../sentry", () => ({ Sentry: { captureException: jest.fn(), captureMessage: jest.fn() } }));

const auth = require("../auth") as { rolesForRequest: jest.Mock; verifiedIdentityFromRequest: jest.Mock };
const db = require("../db") as { beginTransaction: jest.Mock; commitTransaction: jest.Mock; createRequestConnection: jest.Mock; executeQuery: jest.Mock; rollbackTransaction: jest.Mock };
const engine = require("../escalation/engine") as { raiseWithin: jest.Mock; resolveWithin: jest.Mock };
const store = require("../escalation/store") as { findLiveEscalation: jest.Mock };
const { _resetRateLimitForTests } = require("../rateLimit") as { _resetRateLimitForTests: () => void };
const { answerApprovalAttribution } = require("./answerApprovalAttribution") as {
  answerApprovalAttribution: (req: HttpRequest, ctx: InvocationContext) => Promise<{ jsonBody?: unknown; status?: number }>;
};

type Route = { match: RegExp; rows?: Record<string, unknown>[] };
function mockSql(routes: Route[]): void {
  db.executeQuery.mockImplementation(async (_c: unknown, sql: string) => routes.find((r) => r.match.test(sql))?.rows ?? []);
}
const calls = () =>
  db.executeQuery.mock.calls.map((c: unknown[]) => ({
    params: Object.fromEntries(((c[2] as { name: string; value: unknown }[] | undefined) ?? []).map((p) => [p.name, p.value])),
    sql: String(c[1]),
  }));
const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;
const answer = (body: Record<string, unknown>) =>
  answerApprovalAttribution({ headers: { get: () => null }, json: jest.fn().mockResolvedValue(body) } as unknown as HttpRequest, ctx);

const MO = { email: "mo@example.com", name: "Mo Manager", oid: "mo-oid" };
const appUser = (id: number): Route => ({ match: /FROM dbo\.AppUsers WHERE EntraOid/, rows: [{ UserID: id }] });
const QUOTE: Route = {
  match: /FROM Quotes q WITH \(UPDLOCK, HOLDLOCK\)/,
  rows: [{
    Amount: 4500, ApprovalAttributedToUserID: 30, ApprovedBy: "Fi Facilities", AttributedToName: "Mo Manager", AttributionAnsweredAt: null,
    BuildingID: 5, ContractorID: 3, ContractorName: "Acme", JobID: 9, QuoteID: 7, QuoteNumber: "QT-9-1",
  }],
};
const VARIANCE: Route = {
  match: /FROM dbo\.MoneyVariances v WITH \(UPDLOCK, HOLDLOCK\)/,
  rows: [{
    AnsweredAt: null, AttributedToName: "Mo Manager", AttributedToUserID: 30, BuildingID: 5, ContractorID: 3, ContractorName: "Acme",
    Disputed: null, EditorName: "Fi Facilities", JobID: 9, NewAmount: 10600, OriginalAmount: 10000, Rationale: "Extra valve",
    SubjectID: 12, SubjectType: "purchase_order", VarianceID: 4,
  }],
};
const SCOPE: Route = { match: /SELECT JobID, BuildingID FROM Jobs WHERE JobID|SELECT BuildingID FROM Jobs WHERE JobID/, rows: [{ BuildingID: 5, JobID: 9 }] };

beforeEach(() => {
  jest.clearAllMocks();
  _resetRateLimitForTests();
  jest.spyOn(console, "error").mockImplementation(() => undefined);
  auth.verifiedIdentityFromRequest.mockResolvedValue(MO);
  auth.rolesForRequest.mockResolvedValue(["facilities_manager"]);
  db.createRequestConnection.mockResolvedValue({ id: "connection" });
  db.beginTransaction.mockResolvedValue(undefined);
  db.commitTransaction.mockResolvedValue(undefined);
  db.rollbackTransaction.mockResolvedValue(undefined);
  store.findLiveEscalation.mockResolvedValue({ escalationId: 55 });
  engine.resolveWithin.mockResolvedValue({});
  engine.raiseWithin.mockResolvedValue({ announce: jest.fn().mockResolvedValue({}), created: true, escalation: {} });
});
afterEach(() => jest.restoreAllMocks());

describe("answerApprovalAttribution", () => {
  it("'Yes, I agreed' stamps the answer and ends the notice, raising nothing and ledgering no exception", async () => {
    mockSql([appUser(30), QUOTE, SCOPE]);

    const res = await answer({ agreed: true, id: 7, kind: "quote" });

    expect(res).toEqual({ jsonBody: { answered: true, disputed: false }, status: 200 });
    expect(calls().some((c) => /UPDATE Quotes SET AttributionAnsweredAt = SYSUTCDATETIME\(\)/.test(c.sql))).toBe(true);
    expect(store.findLiveEscalation).toHaveBeenCalledWith(expect.anything(), "approval_attribution", "quote:7@9", "quote.attribution_notice");
    expect(engine.resolveWithin).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ escalationId: 55, resolutionCode: "agreed" }));
    expect(engine.raiseWithin).not.toHaveBeenCalled();
    expect(ledgerInserts(db.executeQuery)).toEqual([]);
    expect(db.commitTransaction).toHaveBeenCalledTimes(1);
  });

  it("'I didn't agree to this' on a quote: answer, exception ledgered by the manager, notice ended and the dispute raised, one transaction", async () => {
    mockSql([appUser(30), QUOTE, SCOPE]);

    const res = await answer({ agreed: false, id: 7, kind: "quote", reason: "We never spoke about this" });

    expect(res).toEqual({ jsonBody: { answered: true, disputed: true }, status: 200 });
    expect(ledgerInserts(db.executeQuery)).toEqual([
      expect.objectContaining({
        action: "quote.attribution_disputed",
        actorName: "Mo Manager",
        after: expect.objectContaining({ amount: 4500, contractorId: 3, disputed: true }),
        isException: true,
        jobId: 9,
        reason: "We never spoke about this",
        subjectId: "7",
        subjectType: "quote",
      }),
    ]);
    expect(engine.resolveWithin).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ resolutionCode: "disputed" }));
    expect(engine.raiseWithin).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ policyKey: "quote.attribution_disputed", subjectId: "quote:7@9", subjectType: "approval_attribution" }),
    );
    const announce = (await engine.raiseWithin.mock.results[0].value).announce as jest.Mock;
    expect(db.commitTransaction.mock.invocationCallOrder[0]).toBeLessThan(announce.mock.invocationCallOrder[0]);
  });

  it("a disputed variance marks the row disputed and is ledgered against its purchase order", async () => {
    mockSql([appUser(30), VARIANCE, SCOPE]);

    await answer({ agreed: false, id: 4, kind: "variance", reason: "Not agreed" });

    const stamp = calls().find((c) => /UPDATE dbo\.MoneyVariances SET AnsweredAt/.test(c.sql));
    expect(stamp?.params).toMatchObject({ Disputed: true, Id: 4 });
    expect(ledgerInserts(db.executeQuery)).toEqual([
      expect.objectContaining({ action: "po.variance_disputed", subjectId: "12", subjectType: "purchase_order" }),
    ]);
    expect(engine.raiseWithin).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ policyKey: "po.variance_disputed", subjectId: "variance:4@9" }));
  });

  it("a dispute needs a reason (400, nothing read)", async () => {
    mockSql([appUser(30), QUOTE]);
    const res = await answer({ agreed: false, id: 7, kind: "quote", reason: "  " });
    expect(res.status).toBe(400);
    expect(db.beginTransaction).not.toHaveBeenCalled();
  });

  it("only the manager named may answer: 403, ledgered as a refused dispute, nothing changed", async () => {
    mockSql([appUser(31), QUOTE, SCOPE]);

    const res = await answer({ agreed: false, id: 7, kind: "quote", reason: "no" });

    expect(res).toEqual({ jsonBody: { code: "not_named_manager", error: "Only Mo Manager can answer this: they were named on it." }, status: 403 });
    expect(calls().some((c) => /UPDATE/.test(c.sql))).toBe(false);
    expect(ledgerInserts(db.executeQuery)).toEqual([
      expect.objectContaining({ action: "denied", before: expect.objectContaining({ attempted: "quote.attribution_disputed" }), ruleApplied: "not_named_manager" }),
    ]);
  });

  it("answers once: a second answer is a 409", async () => {
    mockSql([appUser(30), { ...QUOTE, rows: [{ ...QUOTE.rows![0], AttributionAnsweredAt: new Date("2026-10-16T00:00:00Z") }] }, SCOPE]);
    const res = await answer({ agreed: true, id: 7, kind: "quote" });
    expect(res.status).toBe(409);
    expect(res.jsonBody).toMatchObject({ code: "already_answered" });
  });

  it("404 when there is no attribution to answer", async () => {
    mockSql([appUser(30), { ...QUOTE, rows: [{ ...QUOTE.rows![0], ApprovalAttributedToUserID: null }] }]);
    expect((await answer({ agreed: true, id: 7, kind: "quote" })).status).toBe(404);
  });

  it.each([[{ agreed: true, id: 7, kind: "job" }], [{ agreed: "yes", id: 7, kind: "quote" }], [{ agreed: true, id: -1, kind: "quote" }]])(
    "400 for a malformed body %p",
    async (body) => {
      expect((await answer(body)).status).toBe(400);
    },
  );
});
