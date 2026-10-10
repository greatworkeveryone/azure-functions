/// <reference types="jest" />
import { HttpRequest, InvocationContext } from "@azure/functions";

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn(), storageQueue: jest.fn(), timer: jest.fn() } };
});

jest.mock("../db", () => ({
  beginTransaction: jest.fn().mockResolvedValue(undefined),
  buildUpdateSet: jest.fn(),
  closeConnection: jest.fn(),
  commitTransaction: jest.fn().mockResolvedValue(undefined),
  createRequestConnection: jest.fn().mockResolvedValue({}),
  executeQuery: jest.fn().mockResolvedValue([]),
  rollbackTransaction: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../auth", () => {
  const actual = jest.requireActual("../auth");
  return {
    ...actual,
    errorResponse: jest.fn().mockReturnValue({ status: 500, jsonBody: { error: "Error" } }),
    extractToken: jest.fn().mockReturnValue("mock-token"),
    requireRole: jest.fn().mockResolvedValue(null),
    rolesForRequest: jest.fn().mockResolvedValue(["director"]),
    unauthorizedResponse: jest.fn().mockReturnValue({ status: 401, jsonBody: { error: "Unauthorized" } }),
    verifiedIdentityFromRequest: jest.fn().mockResolvedValue({
      email: "carlo@randazzo.properties",
      name: "Carlo Randazzo",
      oid: "director-oid",
    }),
  };
});

jest.mock("../planner", () => ({ resolveActivePlannerTasks: jest.fn().mockResolvedValue(undefined) }));
jest.mock("../quote-decisions", () => ({
  QUOTE_COLUMNS: "QuoteID",
  approveDirectorQuote: jest.fn(),
  rejectQuote: jest.fn(),
}));

const auth = require("../auth") as { rolesForRequest: jest.Mock; verifiedIdentityFromRequest: jest.Mock };
const db = require("../db") as { commitTransaction: jest.Mock; rollbackTransaction: jest.Mock; beginTransaction: jest.Mock };
const planner = require("../planner") as { resolveActivePlannerTasks: jest.Mock };
const decisions = require("../quote-decisions") as { approveDirectorQuote: jest.Mock; rejectQuote: jest.Mock };

type Handler = (req: HttpRequest, ctx: InvocationContext) => Promise<{ status?: number; jsonBody?: unknown }>;
const { directorApproveQuote, rejectQuote } = require("./quotes") as {
  directorApproveQuote: Handler;
  rejectQuote: Handler;
};

function makeRequest(body: unknown): HttpRequest {
  return {
    headers: { get: () => null },
    json: jest.fn().mockResolvedValue(body),
    query: new URLSearchParams(),
  } as unknown as HttpRequest;
}

const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;
const storedQuote = { QuoteID: 7, Status: "rejected" };

beforeEach(() => {
  jest.clearAllMocks();
  decisions.rejectQuote.mockResolvedValue({ jobId: 9, ok: true, previousStatus: "pending", quote: storedQuote });
  decisions.approveDirectorQuote.mockResolvedValue({ jobId: 9, ok: true, quote: { ...storedQuote, Status: "approved" } });
});

describe("rejectQuote (in-app)", () => {
  it("takes the actor from the verified token and ignores RejectedBy in the body", async () => {
    const res = await rejectQuote(makeRequest({ QuoteID: 7, RejectedBy: "Mallory" }), ctx);

    expect(res.status).toBe(200);
    expect(decisions.rejectQuote).toHaveBeenCalledWith({}, {
      expectedStatuses: ["pending", "awaiting_director"],
      quoteId: 7,
      rejectedBy: "Carlo Randazzo",
    });
  });

  it("surfaces the helper's 409 when the quote is not rejectable", async () => {
    decisions.rejectQuote.mockResolvedValue({
      error: "Quote is approved — it can only be rejected while pending or awaiting_director",
      ok: false,
      status: 409,
    });

    const res = await rejectQuote(makeRequest({ QuoteID: 7 }), ctx);

    expect(res.status).toBe(409);
  });

  it("commits the transaction on success", async () => {
    await rejectQuote(makeRequest({ QuoteID: 7 }), ctx);

    expect(db.beginTransaction).toHaveBeenCalled();
    expect(db.commitTransaction).toHaveBeenCalled();
    expect(db.rollbackTransaction).not.toHaveBeenCalled();
  });

  it("rolls back and does not commit when the helper is not ok", async () => {
    decisions.rejectQuote.mockResolvedValue({ error: "x", ok: false, status: 409 });

    const res = await rejectQuote(makeRequest({ QuoteID: 7 }), ctx);

    expect(res.status).toBe(409);
    expect(db.rollbackTransaction).toHaveBeenCalled();
    expect(db.commitTransaction).not.toHaveBeenCalled();
  });

  it("rolls back and 500s when the helper throws, even if rollback fails", async () => {
    decisions.rejectQuote.mockRejectedValue(new Error("boom"));
    db.rollbackTransaction.mockRejectedValueOnce(new Error("rollback failed"));

    const res = await rejectQuote(makeRequest({ QuoteID: 7 }), ctx);

    expect(res.status).toBe(500);
    expect(db.rollbackTransaction).toHaveBeenCalled();
    expect(db.commitTransaction).not.toHaveBeenCalled();
  });

  it("resolves the director Planner task after rejecting from awaiting_director", async () => {
    decisions.rejectQuote.mockResolvedValue({ jobId: 9, ok: true, previousStatus: "awaiting_director", quote: storedQuote });

    const res = await rejectQuote(makeRequest({ QuoteID: 7 }), ctx);

    expect(res.status).toBe(200);
    expect(planner.resolveActivePlannerTasks).toHaveBeenCalledWith("job", 9, ["director_approval"]);
  });

  it("does not resolve the Planner task when rejecting from pending", async () => {
    await rejectQuote(makeRequest({ QuoteID: 7 }), ctx);

    expect(planner.resolveActivePlannerTasks).not.toHaveBeenCalled();
  });

  it("still 200s when the Planner resolve throws", async () => {
    decisions.rejectQuote.mockResolvedValue({ jobId: 9, ok: true, previousStatus: "awaiting_director", quote: storedQuote });
    planner.resolveActivePlannerTasks.mockRejectedValueOnce(new Error("graph down"));

    const res = await rejectQuote(makeRequest({ QuoteID: 7 }), ctx);

    expect(res.status).toBe(200);
  });

  it("401s and writes nothing when the token identity cannot be verified", async () => {
    auth.verifiedIdentityFromRequest.mockResolvedValueOnce(null);

    const res = await rejectQuote(makeRequest({ QuoteID: 7 }), ctx);

    expect(res.status).toBe(401);
    expect(decisions.rejectQuote).not.toHaveBeenCalled();
  });
});

describe("directorApproveQuote", () => {
  it("403s an admin without the literal director role — director-only by policy", async () => {
    auth.rolesForRequest.mockResolvedValueOnce(["admin"]);

    const res = await directorApproveQuote(makeRequest({ QuoteID: 7 }), ctx);

    expect(res.status).toBe(403);
    expect(decisions.approveDirectorQuote).not.toHaveBeenCalled();
  });

  it("stamps the verified director, not ApprovedBy from the body", async () => {
    const res = await directorApproveQuote(makeRequest({ ApprovedBy: "Mallory", QuoteID: 7 }), ctx);

    expect(res.status).toBe(200);
    expect(decisions.approveDirectorQuote).toHaveBeenCalledWith({}, { approvedBy: "Carlo Randazzo", quoteId: 7 });
  });

  it("commits the transaction on success", async () => {
    await directorApproveQuote(makeRequest({ QuoteID: 7 }), ctx);

    expect(db.beginTransaction).toHaveBeenCalled();
    expect(db.commitTransaction).toHaveBeenCalled();
    expect(db.rollbackTransaction).not.toHaveBeenCalled();
  });

  it("rolls back and does not commit when the helper is not ok", async () => {
    decisions.approveDirectorQuote.mockResolvedValue({ error: "x", ok: false, status: 409 });

    const res = await directorApproveQuote(makeRequest({ QuoteID: 7 }), ctx);

    expect(res.status).toBe(409);
    expect(db.rollbackTransaction).toHaveBeenCalled();
    expect(db.commitTransaction).not.toHaveBeenCalled();
  });

  it("rolls back and 500s when the helper throws", async () => {
    decisions.approveDirectorQuote.mockRejectedValue(new Error("boom"));

    const res = await directorApproveQuote(makeRequest({ QuoteID: 7 }), ctx);

    expect(res.status).toBe(500);
    expect(db.rollbackTransaction).toHaveBeenCalled();
    expect(db.commitTransaction).not.toHaveBeenCalled();
  });
});
