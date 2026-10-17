/// <reference types="jest" />

// The MYOB Activity, reconciliation and acceptance endpoints (SPR-M4):
// activity and reconciliation read (cfo, director, admin); accepting MYOB's
// record as the baseline is the CFO's (the M9 controller gate).

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn(), storageQueue: jest.fn(), timer: jest.fn() } };
});
jest.mock("../db", () => ({
  beginTransaction: jest.fn().mockResolvedValue(undefined), closeConnection: jest.fn(), commitTransaction: jest.fn().mockResolvedValue(undefined),
  createRequestConnection: jest.fn().mockResolvedValue({}), rollbackTransaction: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../auth", () => ({
  ...jest.requireActual("../auth"),
  extractToken: jest.fn().mockReturnValue("token"),
  requireRole: jest.fn().mockResolvedValue(null),
  rolesForRequest: jest.fn().mockResolvedValue(["cfo"]),
  verifiedIdentityFromRequest: jest.fn().mockResolvedValue({ email: "j@rp", name: "Johanne", oid: "cfo-oid" }),
}));
jest.mock("../ledger/actor", () => ({ resolveLedgerActor: jest.fn().mockResolvedValue({ kind: "user", name: "Johanne", role: "cfo", userId: 12 }) }));
jest.mock("../rateLimit", () => ({ checkRateLimit: jest.fn().mockReturnValue({ allowed: true, retryAfterMs: 0 }) }));
jest.mock("../myob/activity/activityStore", () => ({
  CALL_ROWS: 2000, PROPOSAL_ROWS: 500, loadCallRows: jest.fn().mockResolvedValue([]), loadProposalRows: jest.fn().mockResolvedValue([]),
  loadRegisteredFiles: jest.fn().mockResolvedValue(new Map([["cf", "Demo Pty Ltd"]])),
}));
jest.mock("../myob/activity/reconcile", () => ({ RECONCILE_LIMIT: 100, reconcile: jest.fn().mockResolvedValue({ rows: [] }) }));
jest.mock("../myob/activity/acceptBaseline", () => ({ acceptBaseline: jest.fn().mockResolvedValue({ proposalId: 5 }), readForAcceptance: jest.fn().mockResolvedValue({ RowVersion: "9" }) }));
jest.mock("../myob/proposalsStore", () => ({ getProposal: jest.fn().mockResolvedValue({ proposalId: 5 }) }));

import type { HttpRequest, InvocationContext } from "@azure/functions";
import { acceptMyobBaseline } from "./acceptMyobBaseline";
import { getMyobActivity } from "./getMyobActivity";
import { reconcileMyob } from "./reconcileMyob";

const auth = require("../auth") as Record<string, jest.Mock>;
const store = require("../myob/activity/activityStore") as Record<string, jest.Mock>;
const { reconcile } = require("../myob/activity/reconcile") as { reconcile: jest.Mock };
const accept = require("../myob/activity/acceptBaseline") as Record<string, jest.Mock>;
const { checkRateLimit } = require("../rateLimit") as { checkRateLimit: jest.Mock };

const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;
const get = (query: Record<string, string>) => ({ query: new URLSearchParams(query) }) as unknown as HttpRequest;
const post = (body: unknown) => ({ json: async () => body, query: new URLSearchParams() }) as unknown as HttpRequest;
const ACCEPT = { expectedRowVersion: "v1", myobRowVersion: "9", note: "Her hold is right", proposalId: 5 };

beforeEach(() => {
  jest.clearAllMocks();
  auth.rolesForRequest.mockResolvedValue(["cfo"]);
});

describe("getMyobActivity", () => {
  it("lists proposals with the filters, the registered files for the filter, and whether the list was cut short", async () => {
    const res = await getMyobActivity(get({ from: "2026-10-14", kind: "proposals", state: "verified" }), ctx);
    expect(res).toMatchObject({ jsonBody: { files: [{ id: "cf", name: "Demo Pty Ltd" }], kind: "proposals", truncated: false }, status: 200 });
    expect(store.loadProposalRows).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ state: "verified" }));
  });

  it("exports the calls as CSV, and 400s a bad filter", async () => {
    expect((await getMyobActivity(get({ format: "csv", kind: "calls" }), ctx)).jsonBody).toMatchObject({ filename: expect.stringMatching(/^floorplan-myob-calls-/) });
    expect((await getMyobActivity(get({ kind: "ledger" }), ctx)).status).toBe(400);
  });

  it("passes the role check's 403 through", async () => {
    auth.requireRole.mockResolvedValueOnce({ jsonBody: { error: "Forbidden" }, status: 403 });
    expect((await getMyobActivity(get({}), ctx)).status).toBe(403);
  });
});

describe("reconcileMyob", () => {
  it("checks against MYOB as the signed-in person, rate-limited per person, and says whether she may accept", async () => {
    const res = await reconcileMyob(post({ companyFileId: "0F9E8D7C-6B5A-4F3E-9D2C-1B0A99887766" }), ctx);
    expect(res).toMatchObject({ jsonBody: { canAccept: true, rows: [] }, status: 200 });
    expect(reconcile).toHaveBeenCalledWith(expect.anything(), { kind: "user", name: "Johanne", oid: "cfo-oid" }, { companyFileId: "0f9e8d7c-6b5a-4f3e-9d2c-1b0a99887766", limit: 100 }, expect.anything());
    expect(checkRateLimit).toHaveBeenCalledWith("reconcileMyob:cfo-oid", { limit: 3, windowMs: 60_000 });
    auth.rolesForRequest.mockResolvedValue(["director"]);
    expect((await reconcileMyob(post({}), ctx)).jsonBody).toMatchObject({ canAccept: false });
  });

  it("429s past the limit and 400s a bad file", async () => {
    checkRateLimit.mockReturnValueOnce({ allowed: false, retryAfterMs: 30_000 });
    expect((await reconcileMyob(post({}), ctx)).status).toBe(429);
    expect((await reconcileMyob(post({ companyFileId: "rp" }), ctx)).status).toBe(400);
  });
});

describe("acceptMyobBaseline", () => {
  it("reads MYOB again before the transaction, then accepts in it", async () => {
    const res = await acceptMyobBaseline(post(ACCEPT), ctx);
    expect(res.status).toBe(200);
    expect(accept.readForAcceptance).toHaveBeenCalledWith({ proposalId: 5 }, { kind: "user", name: "Johanne", oid: "cfo-oid" }, expect.anything());
    expect(accept.acceptBaseline).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ role: "cfo" }), expect.objectContaining({ myobRecord: { RowVersion: "9" }, note: "Her hold is right" }), expect.any(Date));
  });

  it.each([["admin"], ["director"], ["accounts_manager"]])("403s %s: only the CFO accepts MYOB's record", async (role) => {
    auth.rolesForRequest.mockResolvedValue([role]);
    expect((await acceptMyobBaseline(post(ACCEPT), ctx)).status).toBe(403);
    expect(accept.readForAcceptance).not.toHaveBeenCalled();
  });

  it("400s without her note, before reading MYOB", async () => {
    expect((await acceptMyobBaseline(post({ ...ACCEPT, note: " " }), ctx)).status).toBe(400);
    expect(accept.readForAcceptance).not.toHaveBeenCalled();
  });
});
