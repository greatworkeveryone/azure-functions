/// <reference types="jest" />
// Flagged email is no longer hidden from every staff view: getEmails?flagged=true
// lists exactly what the AI couldn't read; the default inbox still excludes it.
import { HttpRequest, InvocationContext } from "@azure/functions";

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn(), storageQueue: jest.fn(), timer: jest.fn() } };
});
jest.mock("../db", () => ({ closeConnection: jest.fn(), createRequestConnection: jest.fn().mockResolvedValue({}), executeQuery: jest.fn() }));
jest.mock("../auth", () => ({
  ...jest.requireActual("../auth"),
  extractToken: jest.fn().mockReturnValue("tok"),
  requireRole: jest.fn().mockResolvedValue(null),
}));
jest.mock("../blob-storage", () => ({ generateReadSasUrl: jest.fn() }));
jest.mock("../rateLimit", () => ({ checkRateLimit: jest.fn() }));

import { getEmails } from "./emails";

const db = jest.requireMock("../db") as { executeQuery: jest.Mock };
const ctx = { error: jest.fn(), log: jest.fn() } as unknown as InvocationContext;
const get = (query: string) => ({ headers: { get: () => null }, query: new URLSearchParams(query) }) as unknown as HttpRequest;
const whereOf = () => String(db.executeQuery.mock.calls[0][1]);

beforeEach(() => {
  jest.clearAllMocks();
  db.executeQuery.mockResolvedValue([{ Total: 0 }]);
});

describe("getEmails flagged filter", () => {
  it("excludes flagged email from the inbox by default", async () => {
    await getEmails(get("statuses=unread,matched"), ctx);
    expect(whereOf()).toMatch(/AIFlaggedForReview = 0/);
  });

  it("lists only flagged email with flagged=true", async () => {
    await getEmails(get("statuses=unread,matched&flagged=true"), ctx);
    expect(whereOf()).toMatch(/AIFlaggedForReview = 1/);
    expect(whereOf()).not.toMatch(/AIFlaggedForReview = 0/);
  });
});
