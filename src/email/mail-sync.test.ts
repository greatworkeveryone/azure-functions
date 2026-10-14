/// <reference types="jest" />
// DL-13: the mailbox is read oldest-first, page by page (@odata.nextLink), and
// the mailbox's watermark moves only past messages that are stored. Drives the
// real graph.ts paging and upsertGraphEmails against a fake Graph and DB.

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn(), storageQueue: jest.fn(), timer: jest.fn() } };
});
jest.mock("../db", () => ({ closeConnection: jest.fn(), createRequestConnection: jest.fn(), executeQuery: jest.fn() }));
jest.mock("../blob-storage", () => ({ generateReadSasUrl: jest.fn(), uploadBlob: jest.fn() }));
jest.mock("../rateLimit", () => ({ checkRateLimit: jest.fn() }));

import { syncMailbox } from "./mail-sync";

const db = jest.requireMock("../db") as { executeQuery: jest.Mock };
const connection = {} as never;
const MAILBOX = "inbox@example.test";

const at = (minute: number) => new Date(Date.UTC(2026, 9, 14, 0, minute)).toISOString();
const message = (i: number, over: Record<string, unknown> = {}) => ({
  body: { content: "body" },
  from: { emailAddress: { address: "tenant@example.test", name: "Tenant" } },
  hasAttachments: false,
  id: `g-${i}`,
  internetMessageId: `<m${i}@x>`,
  receivedDateTime: at(i),
  subject: `Subject ${i}`,
  ...over,
});

let pages: unknown[][];
let messageUrls: string[];
let inserted: Record<string, unknown>[];
let watermarks: Record<string, unknown>[];
let state: { hasTable: boolean; row: { LastReceivedAt: Date } | null; newestStored: Date | null };
let failOn: string | null;

const params = (call: unknown[]) =>
  Object.fromEntries(((call[2] as { name: string; value: unknown }[]) ?? []).map((p) => [p.name, p.value]));

function respond(body: unknown) {
  return { json: async () => body, ok: true, status: 200, text: async () => "" };
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.GRAPH_TENANT_ID = "tenant";
  process.env.GRAPH_CLIENT_ID = "client";
  process.env.GRAPH_CLIENT_SECRET = "secret";
  messageUrls = [];
  inserted = [];
  watermarks = [];
  failOn = null;
  state = { hasTable: true, newestStored: null, row: null };
  const all = Array.from({ length: 120 }, (_, i) => message(i));
  pages = [all.slice(0, 50), all.slice(50, 100), all.slice(100)];

  global.fetch = jest.fn(async (input: string) => {
    const url = String(input);
    if (url.startsWith("https://login.microsoftonline.com/")) return respond({ access_token: "graph-tok" });
    messageUrls.push(url);
    const index = url.includes("/mailFolders/Inbox/messages") ? 0 : Number(url.match(/page=(\d+)/)?.[1]);
    const next = index + 1 < pages.length ? { "@odata.nextLink": `https://graph.microsoft.com/v1.0/next?page=${index + 1}` } : {};
    return respond({ value: pages[index], ...next });
  }) as unknown as typeof fetch;

  db.executeQuery.mockImplementation(async (...call: unknown[]) => {
    const sql = String(call[1]);
    if (/OBJECT_ID\(N'dbo\.EmailSyncState'/.test(sql)) return [{ HasState: state.hasTable ? 1 : 0 }];
    if (/FROM dbo\.EmailSyncState/.test(sql)) return state.row ? [state.row] : [];
    if (/MAX\(ReceivedAt\)/.test(sql)) return [{ LatestReceivedAt: state.newestStored }];
    if (/INSERT INTO Emails/.test(sql)) {
      const row = params(call);
      if (row.MessageID === failOn) throw new Error("Transaction (Process ID 61) was deadlocked");
      inserted.push(row);
      return [];
    }
    if (/MERGE dbo\.EmailSyncState/.test(sql)) watermarks.push(params(call));
    return [];
  });
});

describe("syncMailbox", () => {
  it("stores all 120 messages from 3 pages, oldest first", async () => {
    const result = await syncMailbox(connection, MAILBOX);

    expect(inserted.map((r) => r.MessageID)).toEqual(Array.from({ length: 120 }, (_, i) => `<m${i}@x>`));
    expect(messageUrls).toHaveLength(3);
    expect(new URL(messageUrls[0]).searchParams.get("$orderby")).toBe("receivedDateTime asc");
    expect(result).toEqual({ fetched: 120, pages: 3, since: null });
  });

  it("moves the watermark after each stored page, to the newest message stored", async () => {
    await syncMailbox(connection, MAILBOX);

    expect(watermarks.map((w) => w.LastMessageId)).toEqual(["<m49@x>", "<m99@x>", "<m119@x>"]);
    expect(watermarks[2]).toMatchObject({ LastReceivedAt: new Date(at(119)), Mailbox: MAILBOX });
  });

  it("leaves the watermark where it was when storing a page throws", async () => {
    failOn = "<m60@x>";

    await expect(syncMailbox(connection, MAILBOX)).rejects.toThrow(/deadlocked/);

    expect(watermarks.map((w) => w.LastMessageId)).toEqual(["<m49@x>"]);
    expect(inserted).toHaveLength(60);
  });

  it("stores a 600-character subject cut to the column's 500", async () => {
    pages = [[message(0, { subject: "s".repeat(600) })]];

    await syncMailbox(connection, MAILBOX);

    expect(String(inserted[0].Subject)).toHaveLength(500);
  });

  it("starts from this mailbox's own watermark, not the newest row in Emails", async () => {
    state.row = { LastReceivedAt: new Date(at(30)) };
    state.newestStored = new Date("2027-01-01T00:00:00Z");

    const result = await syncMailbox(connection, MAILBOX);

    expect(new URL(messageUrls[0]).searchParams.get("$filter")).toBe(`receivedDateTime ge ${at(30)}`);
    expect(result.since).toBe(at(30));
  });

  it("starts from the newest stored email for a mailbox it has never synced", async () => {
    state.newestStored = new Date(at(10));

    await syncMailbox(connection, MAILBOX);

    expect(new URL(messageUrls[0]).searchParams.get("$filter")).toBe(`receivedDateTime ge ${at(10)}`);
  });

  it("still pages and stores before migration 129, but has nowhere to record a watermark", async () => {
    state.hasTable = false;

    await syncMailbox(connection, MAILBOX);

    expect(inserted).toHaveLength(120);
    expect(watermarks).toEqual([]);
  });
});
