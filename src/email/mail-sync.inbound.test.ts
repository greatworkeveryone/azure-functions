/// <reference types="jest" />
// EB3: more than one mailbox, each with its own watermark, and replies linked to the send they
// answer. The mailbox Incoming has always read must be read exactly as before. Drives the real
// graph.ts paging and upsertGraphEmails against a fake Graph and DB.

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn(), storageQueue: jest.fn(), timer: jest.fn() } };
});
jest.mock("../db", () => ({ closeConnection: jest.fn(), createRequestConnection: jest.fn(), executeQuery: jest.fn() }));
jest.mock("../blob-storage", () => ({ generateReadSasUrl: jest.fn(), uploadBlob: jest.fn() }));
jest.mock("../rateLimit", () => ({ checkRateLimit: jest.fn() }));
jest.mock("../inboundTriage/sendLookup", () => ({ findSendByInternetMessageId: jest.fn() }));

import { syncMailbox } from "./mail-sync";

const db = jest.requireMock("../db") as { executeQuery: jest.Mock };
const lookup = jest.requireMock("../inboundTriage/sendLookup") as { findSendByInternetMessageId: jest.Mock };
const connection = {} as never;
const MAIN = "ops@example.test";
const EXTRA = "accounts@example.test";

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

let page: unknown[];
let urls: string[];
let statements: { params: Record<string, unknown>; sql: string }[];
let watermarkRows: Record<string, Date | null>;
let newestStored: Date | null;
let storedReplies: Record<string, unknown>[];

const paramsOf = (call: unknown[]) => Object.fromEntries(((call[2] as { name: string; value: unknown }[]) ?? []).map((p) => [p.name, p.value]));
const respond = (body: unknown) => ({ json: async () => body, ok: true, status: 200, text: async () => "" });
const inserts = () => statements.filter((s) => /INSERT INTO Emails/.test(s.sql));
const settings = ["INBOUND_TRIAGE_ENABLED", "INBOUND_TRIAGE_DRY_RUN", "INBOUND_EXTRA_MAILBOXES"] as const;

beforeEach(() => {
  jest.clearAllMocks();
  for (const name of settings) delete process.env[name];
  process.env.GRAPH_TENANT_ID = "tenant";
  process.env.GRAPH_CLIENT_ID = "client";
  process.env.GRAPH_CLIENT_SECRET = "secret";
  urls = [];
  statements = [];
  watermarkRows = {};
  newestStored = new Date(at(5));
  storedReplies = [];
  page = [message(10)];
  lookup.findSendByInternetMessageId.mockResolvedValue(null);

  global.fetch = jest.fn(async (input: string) => {
    const url = String(input);
    if (url.startsWith("https://login.microsoftonline.com/")) return respond({ access_token: "graph-tok" });
    urls.push(url);
    return respond({ value: page });
  }) as unknown as typeof fetch;

  db.executeQuery.mockImplementation(async (...call: unknown[]) => {
    const sql = String(call[1]);
    const params = paramsOf(call);
    statements.push({ params, sql });
    if (/OBJECT_ID\(N'dbo\.EmailSyncState'/.test(sql)) return [{ HasState: 1 }];
    if (/FROM dbo\.EmailSyncState/.test(sql)) {
      const last = watermarkRows[String(params.Mailbox)];
      return last ? [{ LastReceivedAt: last }] : [];
    }
    if (/MAX\(ReceivedAt\)/.test(sql)) return [{ LatestReceivedAt: newestStored }];
    if (/MERGE dbo\.EmailSyncState/.test(sql)) watermarkRows[String(params.Mailbox)] = params.LastReceivedAt as Date;
    if (/FROM dbo\.Emails\s+WHERE MessageID IN/.test(sql)) return storedReplies;
    return [];
  });
});

afterAll(() => {
  for (const name of settings) delete process.env[name];
});

describe("the mailbox Incoming has always read", () => {
  it("is stored with exactly the columns it had before, and nothing is linked, with every inbound setting off", async () => {
    await syncMailbox(connection, MAIN);
    const [insert] = inserts();
    expect(insert.sql).not.toMatch(/Mailbox|InReplyTo|ReferenceIds/);
    expect(Object.keys(insert.params)).not.toEqual(expect.arrayContaining(["Mailbox"]));
    expect(statements.some((s) => /InReplyTo/.test(s.sql))).toBe(false);
    expect(lookup.findSendByInternetMessageId).not.toHaveBeenCalled();
  });

  it("starts from the newest stored email when it has no watermark, as it always did", async () => {
    await syncMailbox(connection, MAIN);
    expect(new URL(urls[0]).searchParams.get("$filter")).toBe(`receivedDateTime ge ${at(5)}`);
  });
});

describe("with an inbound setting on", () => {
  it.each([["INBOUND_TRIAGE_ENABLED", "true"], ["INBOUND_TRIAGE_DRY_RUN", "true"], ["INBOUND_EXTRA_MAILBOXES", EXTRA]])("%s makes each email record its mailbox and its reply headers", async (name, value) => {
    process.env[name] = value;
    page = [message(10, { internetMessageHeaders: [{ name: "In-Reply-To", value: "<Parent@X>" }, { name: "References", value: "<root@x> <parent@x>" }] })];
    await syncMailbox(connection, "Ops@Example.Test");
    const [insert] = inserts();
    expect(insert.sql).toMatch(/Mailbox, InReplyTo, ReferenceIds/);
    expect(insert.params).toMatchObject({ InReplyTo: "parent@x", Mailbox: "ops@example.test", ReferenceIds: "root@x parent@x" });
  });

  it("stores a message that is not a reply with no reply headers", async () => {
    process.env.INBOUND_EXTRA_MAILBOXES = EXTRA;
    await syncMailbox(connection, MAIN);
    expect(inserts()[0].params).toMatchObject({ InReplyTo: null, ReferenceIds: null });
  });
});

describe("reply linking", () => {
  const SEND = { buildingId: null, jobId: null, kind: "broadcast", recipientEmail: null, sendId: "b-1", sentByUserId: 3, subject: "Water shut-off", tenancyId: null };

  beforeEach(() => {
    process.env.INBOUND_EXTRA_MAILBOXES = EXTRA;
    page = [message(10, { internetMessageHeaders: [{ name: "In-Reply-To", value: "<sent1@randazzo>" }] })];
    storedReplies = [{ EmailID: 77, InReplyTo: "sent1@randazzo", ReferenceIds: null }];
  });

  it("links a stored reply to the send it answers, through the lookup, by the ids in its headers", async () => {
    lookup.findSendByInternetMessageId.mockResolvedValue(SEND);
    await syncMailbox(connection, MAIN);
    expect(lookup.findSendByInternetMessageId).toHaveBeenCalledWith(connection, ["sent1@randazzo"]);
    const link = statements.find((s) => /SET LinkedSendKind/.test(s.sql));
    expect(link?.params).toMatchObject({ EmailId: 77, Kind: "broadcast", SendId: "b-1", Subject: "Water shut-off" });
  });

  it("leaves the reply unlinked while the send core's lookup finds nothing", async () => {
    await syncMailbox(connection, MAIN);
    expect(statements.some((s) => /SET LinkedSendKind/.test(s.sql))).toBe(false);
    expect(inserts()).toHaveLength(1);
  });

  it("never lets a failed lookup fail the sync or hold back its watermark", async () => {
    const quiet = jest.spyOn(console, "error").mockImplementation(() => undefined);
    lookup.findSendByInternetMessageId.mockRejectedValue(new Error("send core is down"));
    await expect(syncMailbox(connection, MAIN)).resolves.toMatchObject({ fetched: 1 });
    expect(watermarkRows[MAIN]).toEqual(new Date(at(10)));
    expect(quiet).toHaveBeenCalledWith("[inbound] reply linking failed:", "send core is down");
    quiet.mockRestore();
  });
});

describe("an extra mailbox", () => {
  it("is read from the moment it is first synced, not from its history, and that moment is remembered at once", async () => {
    const before = Date.now();
    page = [];
    const result = await syncMailbox(connection, EXTRA, { startFromNow: true });
    const stored = statements.find((s) => /MERGE dbo\.EmailSyncState/.test(s.sql))?.params.LastReceivedAt as Date;
    expect(stored.getTime()).toBeGreaterThanOrEqual(before);
    expect(new URL(urls[0]).searchParams.get("$filter")).toBe(`receivedDateTime ge ${stored.toISOString()}`);
    expect(result.since).toBe(stored.toISOString());
    expect(statements.some((s) => /MAX\(ReceivedAt\)/.test(s.sql))).toBe(false);
  });

  it("carries on from its own watermark the next time, whatever the other mailboxes hold", async () => {
    watermarkRows[EXTRA] = new Date(at(30));
    watermarkRows[MAIN] = new Date(at(2));
    newestStored = new Date("2027-01-01T00:00:00Z");
    await syncMailbox(connection, EXTRA, { startFromNow: true });
    expect(new URL(urls[0]).searchParams.get("$filter")).toBe(`receivedDateTime ge ${at(30)}`);
    await syncMailbox(connection, MAIN);
    expect(new URL(urls[1]).searchParams.get("$filter")).toBe(`receivedDateTime ge ${at(2)}`);
  });

  it("moves only its own watermark, so two mailboxes never move each other's", async () => {
    watermarkRows[MAIN] = new Date(at(2));
    watermarkRows[EXTRA] = new Date(at(3));
    process.env.INBOUND_EXTRA_MAILBOXES = EXTRA;
    page = [message(20)];
    await syncMailbox(connection, EXTRA, { startFromNow: true });
    expect(watermarkRows[EXTRA]).toEqual(new Date(at(20)));
    expect(watermarkRows[MAIN]).toEqual(new Date(at(2)));
    expect(inserts()[0].params.Mailbox).toBe(EXTRA);
  });

  it("is not read at all when there is no watermark table to remember where it got to", async () => {
    db.executeQuery.mockImplementation(async (...call: unknown[]) => (/OBJECT_ID\(N'dbo\.EmailSyncState'/.test(String(call[1])) ? [{ HasState: 0 }] : []));
    expect(await syncMailbox(connection, EXTRA, { startFromNow: true })).toEqual({ fetched: 0, pages: 0, since: null });
    expect(urls).toHaveLength(0);
  });
});
