/// <reference types="jest" />

// MYOB N11: the timesheet "sync" stamped SentToMyobDate without calling MYOB.
// Until the export exists (Track T), it answers 501 and writes nothing.

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn(), storageQueue: jest.fn(), timer: jest.fn() } };
});
jest.mock("../db", () => ({
  closeConnection: jest.fn(),
  createRequestConnection: jest.fn().mockResolvedValue({}),
  executeQuery: jest.fn().mockResolvedValue([{ TimesheetID: 1, UserDisplayName: "A" }]),
}));
jest.mock("../auth", () => ({
  ...jest.requireActual("../auth"),
  extractToken: jest.fn().mockReturnValue("token"),
  requireRole: jest.fn().mockResolvedValue(null),
  rolesForRequest: jest.fn().mockResolvedValue(["accounts_manager"]),
}));

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { HttpRequest, InvocationContext } from "@azure/functions";

const db = require("../db") as Record<string, jest.Mock>;
const auth = require("../auth") as Record<string, jest.Mock>;
require("./timesheets");
const { app } = require("@azure/functions") as { app: { http: jest.Mock } };
const handler = (app.http.mock.calls.find((c: unknown[]) => c[0] === "syncTimesheetsToMyob")?.[1] as {
  handler: (r: HttpRequest, c: InvocationContext) => Promise<{ status?: number; jsonBody?: { error?: string } }>;
}).handler;

const ctx = { error: jest.fn(), log: jest.fn() } as unknown as InvocationContext;
const request = {} as HttpRequest;

beforeEach(() => jest.clearAllMocks());

describe("syncTimesheetsToMyob", () => {
  it("answers 501 and stamps nothing", async () => {
    const res = await handler(request, ctx);

    expect(res.status).toBe(501);
    expect(res.jsonBody?.error).toBe("MYOB timesheet export not built");
    expect(db.executeQuery).not.toHaveBeenCalled();
    expect(db.createRequestConnection).not.toHaveBeenCalled();
  });

  it("still checks who is asking first", async () => {
    auth.extractToken.mockReturnValueOnce(null);
    expect((await handler(request, ctx)).status).toBe(401);
    auth.requireRole.mockResolvedValueOnce({ status: 403 });
    expect((await handler(request, ctx)).status).toBe(403);
  });

  it("has no code left that sets SentToMyobDate", () => {
    const source = readFileSync(join(__dirname, "timesheets.ts"), "utf8");
    expect(source).not.toMatch(/SET\s+SentToMyobDate/i);
  });
});

describe("sqlKeepWarmTimer", () => {
  it("is gone", () => {
    expect(() => readFileSync(join(__dirname, "sqlKeepWarmTimer.ts"), "utf8")).toThrow();
  });
});
