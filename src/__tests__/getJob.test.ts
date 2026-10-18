/// <reference types="jest" />
// getJob (J6b): J6 opens Done and archived jobs from links by id, so the read by
// id keeps test jobs out as getJobs does (D9), and says so in words a person
// following a link can use.
import type { HttpRequest, InvocationContext } from "@azure/functions";

export {};

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn(), timer: jest.fn() } };
});
jest.mock("../db", () => ({
  closeConnection: jest.fn(),
  createRequestConnection: jest.fn().mockResolvedValue({}),
  executeQuery: jest.fn().mockResolvedValue([]),
}));
jest.mock("../auth", () => ({
  ...jest.requireActual("../auth"),
  extractToken: jest.fn(() => "token"),
  requireRole: jest.fn().mockResolvedValue(null),
}));
jest.mock("../test-data", () => ({
  ...jest.requireActual("../test-data"),
  showTestParam: jest.fn(async () => ({ name: "ShowTest", type: jest.requireActual("tedious").TYPES.Bit, value: false })),
}));

const db = require("../db") as { executeQuery: jest.Mock };
require("../functions/jobs");
const { app } = require("@azure/functions") as { app: { http: jest.Mock } };
type Handler = (request: HttpRequest, context: InvocationContext) => Promise<{ jsonBody?: unknown; status?: number }>;
const getJob = (app.http.mock.calls.find((call: unknown[]) => call[0] === "getJob")?.[1] as { handler: Handler }).handler;

const request = (jobId: string) => ({ headers: { get: () => null }, query: new URLSearchParams({ jobId }) }) as unknown as HttpRequest;
const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;

describe("getJob and test records (D9, J6b)", () => {
  it("reads the job only when it isn't a test record, or the admin's Show test data is on", async () => {
    await getJob(request("41"), ctx);
    const [, sql, params] = db.executeQuery.mock.calls[0] as [unknown, string, { name: string; value: unknown }[]];
    expect(sql).toMatch(/WHERE JobID = @JobID AND \(IsTest = 0 OR @ShowTest = 1\)/);
    expect(params).toEqual(expect.arrayContaining([expect.objectContaining({ name: "ShowTest", value: false })]));
  });

  it("answers 404 in words a person following a link can use", async () => {
    const res = await getJob(request("41"), ctx);
    expect(res).toEqual({ jsonBody: { error: "That job wasn't found, or isn't one you can open." }, status: 404 });
  });
});
