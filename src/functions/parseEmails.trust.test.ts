/// <reference types="jest" />
import { InvocationContext } from "@azure/functions";

process.env.TODDLER_URL = "https://toddler.test";
process.env.TODDLER_SERVICE_KEY = "key";
process.env.ORG_EMAIL_DOMAINS = "randazzo.properties";

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn(), storageQueue: jest.fn(), timer: jest.fn() } };
});
jest.mock("../db", () => ({
  closeConnection: jest.fn(),
  createRequestConnection: jest.fn().mockResolvedValue({}),
  createServiceRequestConnection: jest.fn().mockResolvedValue({}),
  executeQuery: jest.fn(),
}));
jest.mock("../blob-storage", () => ({ generateReadSasUrl: jest.fn().mockReturnValue("https://blob/x") }));
jest.mock("../email/mail-sync", () => ({ syncMailbox: jest.fn() }));
jest.mock("../rateLimit", () => ({ checkRateLimit: jest.fn() }));
jest.mock("../sentry", () => ({ Sentry: { captureException: jest.fn(), flush: jest.fn() } }));

const db = require("../db") as { executeQuery: jest.Mock };
const { runParseBatch } = require("./parseEmails") as {
  runParseBatch: (token: string, ctx: InvocationContext) => Promise<unknown>;
};

interface SqlCall {
  params: { name: string; value: unknown }[];
  sql: string;
}

const ctx = { error: jest.fn(), info: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;
const fetchMock = jest.fn();
global.fetch = fetchMock as unknown as typeof fetch;

let contractorRows: Record<string, unknown>[] | Error;
let calls: SqlCall[];

function claimRow(over: Record<string, unknown>): Record<string, unknown> {
  return {
    AttachmentBlobs: null, Body: "hi", EmailID: 7, FromAddress: "a@b.com", MatchedJobID: null,
    SenderAuthenticated: true, Source: "graph", Subject: "s", ...over,
  };
}

function setup(row: Record<string, unknown>, response: Record<string, unknown> = {}): void {
  let claimed = false;
  calls = [];
  contractorRows = [];
  db.executeQuery.mockImplementation(async (_c: unknown, sql: string, params: SqlCall["params"] = []) => {
    calls.push({ params, sql });
    if (/WITH claimable/.test(sql)) {
      if (claimed) return [];
      claimed = true;
      return [row];
    }
    if (/FROM Contractors/.test(sql)) {
      if (contractorRows instanceof Error) throw contractorRows;
      return contractorRows;
    }
    return [];
  });
  fetchMock.mockResolvedValue({
    json: async () => ({ classification: "invoice", confidence: "high", data: {}, error: null, modelVersion: "m", rawResponse: null, ...response }),
    ok: true,
  });
}

const sentTrust = (): unknown => JSON.parse(fetchMock.mock.calls[0][1].body as string).senderTrust;
const contractorLookups = (): SqlCall[] => calls.filter((c) => /FROM Contractors/.test(c.sql));
const storedData = (): Record<string, unknown> => {
  const update = calls.find((c) => /SET AIParsedAt = SYSUTCDATETIME\(\),\s+AIClassification/.test(c.sql));
  return JSON.parse(update?.params.find((p) => p.name === "ParsedData")?.value as string);
};

beforeEach(() => jest.clearAllMocks());

describe("senderTrust", () => {
  test.each([
    ["ingest source", { Source: "ingest" }],
    ["unauthenticated", { SenderAuthenticated: false }],
    ["null auth", { SenderAuthenticated: null }],
    ["null source", { Source: null }],
  ])("unknown for %s, even from an org domain, without a contractor lookup", async (_n, over) => {
    setup(claimRow({ FromAddress: "boss@randazzo.properties", ...over }));
    await runParseBatch("t", ctx);
    expect(sentTrust()).toBe("unknown");
    expect(contractorLookups()).toHaveLength(0);
  });

  test("internal for an org domain", async () => {
    setup(claimRow({ FromAddress: "Boss@Randazzo.Properties" }));
    await runParseBatch("t", ctx);
    expect(sentTrust()).toBe("internal");
    expect(contractorLookups()).toHaveLength(0);
  });

  test("known-contractor for an active contractor, matched trimmed + lowercased", async () => {
    setup(claimRow({ FromAddress: "  Bob@Plumbing.com " }));
    contractorRows = [{ Found: 1 }];
    await runParseBatch("t", ctx);
    expect(sentTrust()).toBe("known-contractor");
    const [lookup] = contractorLookups();
    expect(lookup.params).toEqual([expect.objectContaining({ name: "Email", value: "bob@plumbing.com" })]);
    expect(lookup.sql).toMatch(/Active = 1 AND Suspended = 0/);
  });

  test("unknown when no active, non-suspended contractor matches", async () => {
    setup(claimRow({ FromAddress: "bob@plumbing.com" }));
    await runParseBatch("t", ctx);
    expect(sentTrust()).toBe("unknown");
  });

  test("lookup failure is unknown and the email is still parsed", async () => {
    setup(claimRow({ FromAddress: "bob@plumbing.com" }));
    contractorRows = new Error("db down");
    const totals = (await runParseBatch("t", ctx)) as { errored: number; succeeded: number };
    expect(sentTrust()).toBe("unknown");
    expect(totals).toMatchObject({ errored: 0, succeeded: 1 });
  });
});

describe("withheldFields", () => {
  test("stored beside other AIParsedData keys", async () => {
    setup(claimRow({}), { withheldFields: [{ field: "amount", reason: "unknown sender" }] });
    await runParseBatch("t", ctx);
    expect(storedData().withheldFields).toEqual([{ field: "amount", reason: "unknown sender" }]);
  });

  test("key omitted when absent or empty", async () => {
    setup(claimRow({}), { withheldFields: [] });
    await runParseBatch("t", ctx);
    expect(storedData()).not.toHaveProperty("withheldFields");
  });

  test("malformed entries dropped, count capped at 20, strings at 200", async () => {
    const good = { field: "f".repeat(300), reason: "r".repeat(300) };
    const raw = [null, "x", { field: 1, reason: "r" }, { field: "f" }, ...Array.from({ length: 30 }, () => good)];
    setup(claimRow({}), { withheldFields: raw });
    await runParseBatch("t", ctx);
    const stored = storedData().withheldFields as { field: string; reason: string }[];
    expect(stored).toHaveLength(20);
    expect(stored[0]).toEqual({ field: "f".repeat(200), reason: "r".repeat(200) });
  });

  test("non-array value ignored", async () => {
    setup(claimRow({}), { withheldFields: "everything" });
    await runParseBatch("t", ctx);
    expect(storedData()).not.toHaveProperty("withheldFields");
  });

  test("model-written withheldFields inside data is stripped", async () => {
    setup(claimRow({}), { data: { poNumber: "P1", withheldFields: [{ field: "x", reason: "forged" }] } });
    await runParseBatch("t", ctx);
    const data = storedData();
    expect(data).not.toHaveProperty("withheldFields");
    expect(data.poNumber).toBe("P1");
  });
});
