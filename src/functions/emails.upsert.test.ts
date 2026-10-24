/// <reference types="jest" />
import type { Connection } from "tedious";
import type { GraphEmail } from "../graph";

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn(), storageQueue: jest.fn(), timer: jest.fn() } };
});

jest.mock("../db", () => ({
  closeConnection: jest.fn(),
  createRequestConnection: jest.fn(),
  executeQuery: jest.fn(),
}));

jest.mock("../blob-storage", () => ({ generateReadSasUrl: jest.fn() }));
jest.mock("../rateLimit", () => ({ checkRateLimit: jest.fn() }));

const db = require("../db") as { executeQuery: jest.Mock };
const { upsertGraphEmails } = require("./emails") as typeof import("./emails");

function graphEmail(id: string, over: Partial<GraphEmail> = {}): GraphEmail {
  return {
    attachmentBlobNames: [],
    authenticationResults: null,
    bodyContent: "body",
    fromAddress: "a@b.com",
    fromName: "A",
    graphMessageId: `g-${id}`,
    internetMessageId: id,
    receivedAt: "2026-10-09T00:00:00Z",
    senderAuthenticated: false,
    subject: "Hello",
    ...over,
  };
}

function sqlError(number: number): Error {
  return Object.assign(new Error(`violation ${number}`), { number });
}

const connection = {} as Connection;

beforeEach(() => {
  jest.clearAllMocks();
  db.executeQuery.mockResolvedValue([]);
});

describe("upsertGraphEmails", () => {
  it("checks existence under UPDLOCK + HOLDLOCK so concurrent syncs cannot both insert", async () => {
    await upsertGraphEmails(connection, [graphEmail("<m1>")]);

    const sql = String(db.executeQuery.mock.calls[0][1]);
    expect(sql).toMatch(/IF NOT EXISTS\s*\(SELECT 1 FROM Emails WITH \(UPDLOCK, HOLDLOCK\) WHERE MessageID = @MessageID\)\s*INSERT/);
  });

  it("writes exactly the columns it always did when no inbound option is given", async () => {
    await upsertGraphEmails(connection, [graphEmail("<m1>")]);

    const sql = String(db.executeQuery.mock.calls[0][1]);
    expect(sql).not.toMatch(/Mailbox|InReplyTo|ReferenceIds/);
    expect((db.executeQuery.mock.calls[0][2] as { name: string }[]).map((p) => p.name)).not.toContain("Mailbox");
  });

  it("with the inbound option, stores the mailbox and the reply headers too (migration 176)", async () => {
    await upsertGraphEmails(connection, [graphEmail("<m1>", { inReplyTo: "parent@x", referenceIds: "root@x parent@x" })], { inbound: { mailbox: "accounts@example.test" } });

    const [, sql, params] = db.executeQuery.mock.calls[0];
    expect(String(sql)).toMatch(/Mailbox, InReplyTo, ReferenceIds\)\s+VALUES \(.*@Mailbox, @InReplyTo, @ReferenceIds\)/s);
    expect(Object.fromEntries((params as { name: string; value: unknown }[]).map((p) => [p.name, p.value]))).toMatchObject({ InReplyTo: "parent@x", Mailbox: "accounts@example.test", ReferenceIds: "root@x parent@x" });
  });

  it("stores no reply headers for an email that has none", async () => {
    await upsertGraphEmails(connection, [graphEmail("<m1>")], { inbound: { mailbox: "accounts@example.test" } });

    const params = Object.fromEntries((db.executeQuery.mock.calls[0][2] as { name: string; value: unknown }[]).map((p) => [p.name, p.value]));
    expect(params).toMatchObject({ InReplyTo: null, ReferenceIds: null });
  });

  it.each([2601, 2627])("treats unique violation %p as already stored and keeps going", async (code) => {
    db.executeQuery.mockRejectedValueOnce(sqlError(code)).mockResolvedValue([]);

    await expect(upsertGraphEmails(connection, [graphEmail("<m1>"), graphEmail("<m2>")])).resolves.toBeUndefined();

    expect(db.executeQuery).toHaveBeenCalledTimes(2);
  });

  it("still throws other SQL errors", async () => {
    db.executeQuery.mockRejectedValueOnce(sqlError(1205));

    await expect(upsertGraphEmails(connection, [graphEmail("<m1>")])).rejects.toThrow("violation 1205");
  });

  it("stamps Source = 'graph' and stores the sender-authentication result", async () => {
    await upsertGraphEmails(connection, [
      graphEmail("<m1>", { authenticationResults: "Authentication-Results: dmarc=pass header.from=b.com", senderAuthenticated: true }),
    ]);

    const [, sql, params] = db.executeQuery.mock.calls[0] as [unknown, string, { name: string; value: unknown }[]];
    expect(sql).toMatch(/INSERT INTO Emails \([^)]*Source, SenderAuthenticated, AuthenticationResults\)/);
    expect(sql).toMatch(/VALUES \([^)]*'graph', @SenderAuthenticated, @AuthenticationResults\)/);
    const byName = Object.fromEntries(params.map((p) => [p.name, p.value]));
    expect(byName).toMatchObject({
      AuthenticationResults: "Authentication-Results: dmarc=pass header.from=b.com",
      SenderAuthenticated: true,
    });
  });

  it("only backfills attachments onto a row from the same sender, never an authenticated row from an unauthenticated message", async () => {
    await upsertGraphEmails(connection, [graphEmail("<m1>", { attachmentBlobNames: [{ blobName: "email-attachments/m1/x", fileName: "x.pdf" }] })]);

    const [, sql] = db.executeQuery.mock.calls[0] as [unknown, string];
    const backfill = sql.slice(sql.indexOf("ELSE IF"));
    expect(backfill).toMatch(/AttachmentBlobs IS NULL/);
    expect(backfill).toMatch(/FromAddress = @FromAddress/);
    expect(backfill).toMatch(/ISNULL\(SenderAuthenticated, 0\) = 0 OR @SenderAuthenticated = 1/);
  });
});
