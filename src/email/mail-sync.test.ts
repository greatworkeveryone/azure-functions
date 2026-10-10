/// <reference types="jest" />
jest.mock("../db", () => ({ executeQuery: jest.fn() }));
jest.mock("../graph", () => ({ graphFetchEmails: jest.fn().mockResolvedValue([]) }));
jest.mock("../functions/emails", () => ({ upsertGraphEmails: jest.fn().mockResolvedValue(undefined) }));

import { syncMailbox } from "./mail-sync";

const db = require("../db") as { executeQuery: jest.Mock };
const graph = require("../graph") as { graphFetchEmails: jest.Mock };
const emails = require("../functions/emails") as { upsertGraphEmails: jest.Mock };
const connection = {} as never;

beforeEach(() => {
  jest.clearAllMocks();
});

describe("syncMailbox", () => {
  it("passes MessageIDs stored at or after the newest ReceivedAt to Graph", async () => {
    db.executeQuery.mockImplementation(async (_c: unknown, sql: string) => {
      if (sql.includes("MAX(ReceivedAt)")) return [{ LatestReceivedAt: new Date("2026-10-06T01:00:00Z") }];
      if (sql.includes("SELECT MessageID FROM Emails")) return [{ MessageID: "<old@x>" }, { MessageID: null }];
      return [];
    });

    const result = await syncMailbox(connection, "inbox@example.test");

    expect(graph.graphFetchEmails).toHaveBeenCalledWith(
      "inbox@example.test",
      "2026-10-06T01:00:00.000Z",
      new Set(["<old@x>"]),
    );
    const known = db.executeQuery.mock.calls.find((c: unknown[]) => String(c[1]).includes("SELECT MessageID FROM Emails"));
    expect(String(known?.[1])).toMatch(/ReceivedAt >= @Since/);
    expect(emails.upsertGraphEmails).toHaveBeenCalledWith(connection, []);
    expect(result).toEqual({ fetched: 0, since: "2026-10-06T01:00:00.000Z" });
  });

  it("fetches everything with an empty known set when Emails is empty", async () => {
    db.executeQuery.mockResolvedValue([{ LatestReceivedAt: null }]);

    await syncMailbox(connection, "inbox@example.test");

    expect(graph.graphFetchEmails).toHaveBeenCalledWith("inbox@example.test", undefined, new Set());
    expect(db.executeQuery).toHaveBeenCalledTimes(1);
  });
});
