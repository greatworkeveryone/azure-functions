/// <reference types="jest" />

// The MYOB lab endpoints (plan M5): read (cfo, director, admin); probe and
// record (the CFO, through the M9 controller gate), only once the lab is ready.

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
}));
jest.mock("../ledger/actor", () => ({ resolveLedgerActor: jest.fn().mockResolvedValue({ kind: "user", name: "Johanne", role: "cfo", userId: 12 }) }));
jest.mock("../myob/lab/status", () => ({ loadLabStatus: jest.fn() }));
jest.mock("../myob/lab/results", () => ({ loadLabResults: jest.fn().mockResolvedValue(new Map()), recordLabResult: jest.fn().mockResolvedValue(undefined) }));
jest.mock("../myob/lab/probes", () => ({ ...jest.requireActual("../myob/lab/probes"), runLabProbe: jest.fn().mockResolvedValue({ code: "not_allowed", refused: true }) }));

import type { HttpRequest, InvocationContext } from "@azure/functions";
import { getMyobLab, recordMyobLabResult, runMyobLabProbe } from "./myobLab";

const auth = require("../auth") as Record<string, jest.Mock>;
const { loadLabStatus } = require("../myob/lab/status") as { loadLabStatus: jest.Mock };
const results = require("../myob/lab/results") as Record<string, jest.Mock>;
const { runLabProbe } = require("../myob/lab/probes") as { runLabProbe: jest.Mock };

const DEMO = "0f9e8d7c-6b5a-4f3e-9d2c-1b0a99887766";
const READY = { demoFile: { id: DEMO, mode: "write", name: "MYOB sample" }, link: null, problems: [], ready: true };
const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;
const post = (body: unknown) => ({ json: async () => body }) as unknown as HttpRequest;
const RESULT = { caseId: "create.order", note: "Matches in MYOB", observed: "In MYOB, matches", pass: true, proposalId: 5 };

beforeEach(() => {
  jest.clearAllMocks();
  auth.rolesForRequest.mockResolvedValue(["cfo"]);
  loadLabStatus.mockResolvedValue(READY);
});

describe("getMyobLab", () => {
  it("shows the lab's status, every case with its latest result, and whether the caller may record", async () => {
    results.loadLabResults.mockResolvedValueOnce(new Map([["create.order", { pass: true }]]));
    const res = await getMyobLab({} as HttpRequest, ctx);
    expect(res.status).toBe(200);
    const body = res.jsonBody as { canRecord: boolean; cases: { id: string; result: unknown }[]; status: unknown };
    expect(body.canRecord).toBe(true);
    expect(body.cases.find((c) => c.id === "create.order")?.result).toEqual({ pass: true });
    expect(body.status).toEqual(READY);
    auth.rolesForRequest.mockResolvedValue(["director"]);
    expect(((await getMyobLab({} as HttpRequest, ctx)).jsonBody as { canRecord: boolean }).canRecord).toBe(false);
  });
});

describe("runMyobLabProbe", () => {
  it("asks the guard about the probe on the demonstration file", async () => {
    const res = await runMyobLabProbe(post({ probe: "card_file" }), ctx);
    expect(res).toMatchObject({ jsonBody: { result: { code: "not_allowed", refused: true } }, status: 200 });
    expect(runLabProbe).toHaveBeenCalledWith("card_file", DEMO, expect.any(Date));
  });

  it("refuses until the lab is ready, an unknown probe, and anyone but the CFO", async () => {
    loadLabStatus.mockResolvedValueOnce({ ...READY, problems: ["Set MYOB_RP_COMPANY_FILE_ID"], ready: false });
    expect((await runMyobLabProbe(post({ probe: "card_file" }), ctx)).status).toBe(409);
    expect((await runMyobLabProbe(post({ probe: "send_money" }), ctx)).status).toBe(400);
    auth.rolesForRequest.mockResolvedValue(["admin"]);
    expect((await runMyobLabProbe(post({ probe: "card_file" }), ctx)).status).toBe(403);
    expect(runLabProbe).not.toHaveBeenCalled();
  });
});

describe("recordMyobLabResult", () => {
  it("ledgers her result on the demonstration file", async () => {
    expect((await recordMyobLabResult(post(RESULT), ctx)).status).toBe(200);
    expect(results.recordLabResult).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ role: "cfo" }), RESULT, DEMO);
  });

  it.each([
    ["no note", { ...RESULT, note: " " }, 400],
    ["no pass or fail", { ...RESULT, pass: "yes" }, 400],
  ])("400s %s", async (_label, body, status) => {
    expect((await recordMyobLabResult(post(body), ctx)).status).toBe(status);
    expect(results.recordLabResult).not.toHaveBeenCalled();
  });

  it("refuses while the lab isn't ready, and anyone but the CFO", async () => {
    loadLabStatus.mockResolvedValueOnce({ ...READY, ready: false });
    expect((await recordMyobLabResult(post(RESULT), ctx)).status).toBe(409);
    auth.rolesForRequest.mockResolvedValue(["director"]);
    expect((await recordMyobLabResult(post(RESULT), ctx)).status).toBe(403);
    expect(results.recordLabResult).not.toHaveBeenCalled();
  });
});
