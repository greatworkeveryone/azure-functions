/// <reference types="jest" />
import { HttpRequest, InvocationContext } from "@azure/functions";

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

jest.mock("../auth", () => {
  const actual = jest.requireActual("../auth");
  return { ...actual, extractToken: jest.fn().mockReturnValue("tok"), requireRole: jest.fn().mockResolvedValue(null) };
});

jest.mock("../blob-storage", () => ({
  generateReadSasUrl: jest.fn().mockReturnValue("https://acct.blob.core.windows.net/x?sig=1"),
}));

jest.mock("../rateLimit", () => ({
  checkRateLimit: jest.fn().mockReturnValue({ allowed: true, retryAfterMs: 0 }),
}));

jest.mock("../sentry", () => ({
  Sentry: { captureException: jest.fn(), flush: jest.fn().mockResolvedValue(true) },
}));

jest.mock("../email/mail-sync", () => ({
  syncMailbox: jest.fn().mockResolvedValue({ fetched: 2, since: null }),
}));

import { emailSyncQueueOutput } from "../email/sync-queue";

const db = require("../db") as { executeQuery: jest.Mock };
// Required here so isolated module loads reuse this same mock instance.
const mailSync = require("../email/mail-sync") as { syncMailbox: jest.Mock };
const { hydrateAttachmentRefs, positiveIntFromEnv } = require("./parseEmails") as typeof import("./parseEmails");
const blob = require("../blob-storage") as { generateReadSasUrl: jest.Mock };
const SAS = "https://acct.blob.core.windows.net/x?sig=1";

type ParseEmailsModule = typeof import("./parseEmails");
type RunParseBatch = ParseEmailsModule["runParseBatch"];

// TODDLER_* / AI_PARSE_* are read at module load, so each test loads a fresh copy.
function loadParseEmails(env: Record<string, string | undefined>): ParseEmailsModule {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  let mod: ParseEmailsModule | undefined;
  jest.isolateModules(() => {
    mod = require("./parseEmails") as ParseEmailsModule;
  });
  if (!mod) throw new Error("module failed to load");
  return mod;
}

function loadRunParseBatch(env: Record<string, string | undefined>): RunParseBatch {
  return loadParseEmails(env).runParseBatch;
}

const claimedEmail = {
  AttachmentBlobs: null,
  Body: "<p>Please quote Q-123</p>",
  EmailID: 42,
  FromAddress: "a@b.com",
  MatchedJobID: null as number | null,
  Subject: "Quote request",
};

const toddlerOk = {
  classification: "quote",
  confidence: "high",
  data: { quoteNumber: "Q-123" },
  error: null,
  modelVersion: "test",
  rawResponse: "{}",
};

function mockFetchJson(body: unknown, ok = true, status = 200): jest.Mock {
  const fetchMock = jest.fn().mockResolvedValue({
    json: async () => body,
    ok,
    status,
    text: async () => JSON.stringify(body),
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

interface FetchStub {
  body: unknown;
  ok?: boolean;
  status?: number;
}

// Routes fetch by URL path so a test can give /warmup and /parse-incoming
// different answers.
function mockFetchRoutes(routes: Record<string, FetchStub>): jest.Mock {
  const fetchMock = jest.fn().mockImplementation(async (url: string) => {
    const path = new URL(url).pathname;
    const stub = routes[path];
    if (!stub) throw new Error(`unexpected fetch ${url}`);
    return {
      json: async () => stub.body,
      ok: stub.ok ?? true,
      status: stub.status ?? 200,
      text: async () => JSON.stringify(stub.body),
    };
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function fetchedPaths(fetchMock: jest.Mock): string[] {
  return fetchMock.mock.calls.map((c: unknown[]) => new URL(String(c[0])).pathname);
}

function sqlOfCalls(): string[] {
  return db.executeQuery.mock.calls.map((c: unknown[]) => String(c[1]));
}

// Answers the claim UPDATE from a queue so each row is handed out once;
// `extra` answers any other statement by shape (undefined → no rows).
function stubClaims(emails: object[], extra?: (sql: string) => unknown[] | undefined): void {
  const queue = [...emails];
  db.executeQuery.mockImplementation(async (_c: unknown, sql: string) => {
    if (sql.includes("OUTPUT inserted")) return queue.splice(0, 1);
    return extra?.(sql) ?? [];
  });
}

// Queue check answers "rows waiting"; the claim hands out claimedEmail once.
function stubQueue(hasRows: boolean): void {
  stubClaims(hasRows ? [claimedEmail] : [], (sql) =>
    sql.includes("SELECT TOP (1) EmailID") ? (hasRows ? [{ EmailID: 42 }] : []) : undefined,
  );
}

const context = new InvocationContext();
const ENV = {
  AI_PARSE_SKIP_SENDERS: undefined,
  AI_PARSE_BATCH_SIZE: undefined,
  TODDLER_SERVICE_KEY: "test-key",
  TODDLER_TIMEOUT_MS: undefined,
  TODDLER_URL: "https://toddler.test",
};

beforeEach(() => {
  jest.clearAllMocks();
  stubClaims([claimedEmail]);
});

describe("runParseBatch → callToddler", () => {
  it("sends X-Service-Key on every toddler call", async () => {
    const fetchMock = mockFetchJson(toddlerOk);
    const run = loadRunParseBatch(ENV);

    await run("tok", context);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://toddler.test/parse-incoming");
    expect(init.headers).toMatchObject({
      "Content-Type": "application/json",
      "X-Service-Key": "test-key",
    });
  });

  it("skips the batch when TODDLER_SERVICE_KEY is unset instead of burning retries", async () => {
    const fetchMock = mockFetchJson(toddlerOk);
    const run = loadRunParseBatch({ ...ENV, TODDLER_SERVICE_KEY: undefined });

    const result = await run("tok", context);

    expect(result).toEqual({ claimed: 0, errored: 0, flagged: 0, succeeded: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.executeQuery).not.toHaveBeenCalled();
  });
});

describe("runParseBatch → result handling", () => {
  it("retries a model error even though toddler returns data: {}", async () => {
    mockFetchJson({
      ...toddlerOk,
      classification: "unknown",
      confidence: "low",
      data: {},
      error: "LLM returned invalid JSON: Expecting value",
    });
    const run = loadRunParseBatch(ENV);

    const result = await run("tok", context);

    expect(result).toEqual({ claimed: 1, errored: 1, flagged: 0, succeeded: 0 });
    const sql = sqlOfCalls();
    expect(sql.some((s) => s.includes("AIParsedAt = SYSUTCDATETIME()") && s.includes("AIClassification = @Classification"))).toBe(false);
    expect(sql.some((s) => s.includes("SET AIParseError = @Error"))).toBe(true);
  });

  it("writes a genuine unknown classification (no error) as success and leaves it visible", async () => {
    mockFetchJson({ ...toddlerOk, classification: "unknown", confidence: "low", data: {} });
    const run = loadRunParseBatch(ENV);

    const result = await run("tok", context);

    expect(result).toEqual({ claimed: 1, errored: 0, flagged: 0, succeeded: 1 });
    expect(sqlOfCalls().some((s) => s.includes("AIClassification = @Classification"))).toBe(true);
  });

  it("records a transient error when toddler responds non-2xx", async () => {
    mockFetchJson({ detail: "Missing credentials" }, false, 401);
    const run = loadRunParseBatch(ENV);

    const result = await run("tok", context);

    expect(result).toEqual({ claimed: 1, errored: 1, flagged: 0, succeeded: 0 });
    const errCall = db.executeQuery.mock.calls.find((c: unknown[]) =>
      String(c[1]).includes("SET AIParseError = @Error"),
    ) as unknown[] | undefined;
    const params = errCall?.[2] as { name: string; value: unknown }[];
    expect(params.find((p) => p.name === "Error")?.value).toMatch(/Toddler 401/);
  });
});

describe("runParseBatch → permanent toddler rejections", () => {
  it.each([[422], [400]])("finalises the row flagged on toddler %p without retrying", async (status) => {
    const fetchMock = mockFetchJson({ detail: "too long" }, false, status);
    stubClaims([claimedEmail, { ...claimedEmail, EmailID: 43 }]);
    const run = loadRunParseBatch(ENV);

    const result = await run("tok", context);

    expect(result).toMatchObject({ claimed: 2, errored: 2, succeeded: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const finalise = sqlOfCalls().find((s) => s.includes("AIParseError = @Error") && s.includes("AIFlaggedForReview = 1"));
    const call = db.executeQuery.mock.calls.find((c: unknown[]) => String(c[1]) === finalise) as unknown[];
    const params = call[2] as { name: string; value: unknown }[];
    expect(finalise).toBeDefined();
    expect(finalise).toContain("AIParsedAt = SYSUTCDATETIME()");
    expect(finalise).toContain("AIClaimedAt = NULL");
    expect(params.find((p) => p.name === "Error")?.value).toMatch(new RegExp(`Toddler ${status}`));
  });

  it("keeps a 503 transient (lease kept, row not finalised)", async () => {
    mockFetchJson({ detail: "down" }, false, 503);
    const run = loadRunParseBatch(ENV);

    await run("tok", context);

    expect(sqlOfCalls().some((s) => s.includes("AIParseError = @Error") && s.includes("AIFlaggedForReview"))).toBe(false);
    expect(callWith("SET AIParseError = @Error").sql).not.toContain("AIClaimedAt");
  });
});

describe("runParseBatch → toddler request caps", () => {
  function sentRequest(fetchMock: jest.Mock): { subject: string; fromAddress: string; attachments: { fileName: string }[] } {
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    return JSON.parse(String(init.body)) as { subject: string; fromAddress: string; attachments: { fileName: string }[] };
  }

  it("caps attachment fileName, subject and fromAddress to toddler's limits", async () => {
    const fetchMock = mockFetchJson(toddlerOk);
    stubClaims([
      {
        ...claimedEmail,
        AttachmentBlobs: JSON.stringify([{ blobName: "email-attachments/x/b.pdf", fileName: "a".repeat(5000) }]),
        FromAddress: "f".repeat(3000),
        Subject: "s".repeat(5000),
      },
    ]);
    const run = loadRunParseBatch(ENV);

    await run("tok", context);

    const body = sentRequest(fetchMock);
    expect(body.attachments[0].fileName).toHaveLength(255);
    expect(body.subject).toHaveLength(2000);
    expect(body.fromAddress).toHaveLength(1000);
  });
});

describe("hydrateAttachmentRefs", () => {
  it("accepts bare blob-name strings (ingestEmail shape)", () => {
    expect(hydrateAttachmentRefs(JSON.stringify(["emails/abc/quote.pdf"]))).toEqual([
      { fileName: "quote.pdf", sasUrl: SAS },
    ]);
    expect(blob.generateReadSasUrl).toHaveBeenCalledWith("emails/abc/quote.pdf", 3_600_000);
  });

  it("accepts { blobName, fileName } objects (Graph sync shape)", () => {
    const raw = JSON.stringify([{ blobName: "email-attachments/AAMk/9f2c-quote.pdf", fileName: "Quote 1042.pdf" }]);

    expect(hydrateAttachmentRefs(raw)).toEqual([{ fileName: "Quote 1042.pdf", sasUrl: SAS }]);
    expect(blob.generateReadSasUrl).toHaveBeenCalledWith("email-attachments/AAMk/9f2c-quote.pdf", 3_600_000);
  });

  it("handles a mixed array in order", () => {
    const raw = JSON.stringify(["emails/abc/a.pdf", { blobName: "email-attachments/x/b.pdf", fileName: "b.pdf" }]);

    expect(hydrateAttachmentRefs(raw).map((a) => a.fileName)).toEqual(["a.pdf", "b.pdf"]);
  });

  it("drops junk entries and falls back to the blob basename when fileName is missing", () => {
    const raw = JSON.stringify([null, 42, "", {}, { blobName: 7 }, { blobName: "" }, { blobName: "email-attachments/x/c.pdf" }]);

    expect(hydrateAttachmentRefs(raw)).toEqual([{ fileName: "c.pdf", sasUrl: SAS }]);
  });

  it("caps a 5,000-char fileName at 255", () => {
    const raw = JSON.stringify([{ blobName: "email-attachments/x/c.pdf", fileName: "n".repeat(5000) }]);

    expect(hydrateAttachmentRefs(raw)[0].fileName).toHaveLength(255);
  });

  it("returns [] for null, invalid JSON and non-array JSON", () => {
    expect(hydrateAttachmentRefs(null)).toEqual([]);
    expect(hydrateAttachmentRefs("not json")).toEqual([]);
    expect(hydrateAttachmentRefs(JSON.stringify({ blobName: "email-attachments/x/c.pdf" }))).toEqual([]);
  });
});

describe("runParseBatch → attachments", () => {
  it("sends Graph-shaped attachments to toddler", async () => {
    const fetchMock = mockFetchJson(toddlerOk);
    stubClaims([
      {
        ...claimedEmail,
        AttachmentBlobs: JSON.stringify([{ blobName: "email-attachments/x/b.pdf", fileName: "Invoice.pdf" }]),
      },
    ]);
    const run = loadRunParseBatch(ENV);

    await run("tok", context);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((JSON.parse(String(init.body)) as { attachments: unknown }).attachments).toEqual([
      { fileName: "Invoice.pdf", sasUrl: SAS },
    ]);
  });
});

describe("runParseBatch → deadline runner", () => {
  const claimSql = (): string[] => sqlOfCalls().filter((s) => s.includes("OUTPUT inserted"));

  it("claims one row per statement until the queue is empty", async () => {
    mockFetchJson(toddlerOk);
    stubClaims([claimedEmail, { ...claimedEmail, EmailID: 43 }]);
    const run = loadRunParseBatch(ENV);

    const result = await run("tok", context);

    expect(result).toEqual({ claimed: 2, errored: 0, flagged: 0, succeeded: 2 });
    // Two rows plus the empty claim that ends the run.
    expect(claimSql()).toHaveLength(3);
    expect(claimSql().every((s) => /SELECT TOP \(1\)/.test(s))).toBe(true);
  });

  it("stops at AI_PARSE_BATCH_SIZE even with rows left", async () => {
    const fetchMock = mockFetchJson(toddlerOk);
    stubClaims([1, 2, 3].map((n) => ({ ...claimedEmail, EmailID: n })));
    const run = loadRunParseBatch({ ...ENV, AI_PARSE_BATCH_SIZE: "2" });

    const result = await run("tok", context);

    expect(result.claimed).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("stops claiming once less than TODDLER_TIMEOUT_MS + 30 s remains", async () => {
    let now = 1_000_000;
    const nowSpy = jest.spyOn(Date, "now").mockImplementation(() => now);
    // Each toddler call takes 5 s of fake time.
    const fetchMock = jest.fn().mockImplementation(async () => {
      now += 5_000;
      return { json: async () => toddlerOk, ok: true, status: 200, text: async () => "" };
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    stubClaims([1, 2, 3, 4, 5].map((n) => ({ ...claimedEmail, EmailID: n })));
    // Per-email budget = 1 s timeout + 30 s margin = 31 s.
    // 40 s left → claim; 35 s → claim; 30 s → stop.
    const run = loadRunParseBatch({ ...ENV, AI_PARSE_BATCH_SIZE: "10", TODDLER_TIMEOUT_MS: "1000" });

    try {
      const result = await run("tok", context, now + 40_000);

      expect(result.claimed).toBe(2);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(claimSql()).toHaveLength(2);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("claims nothing when the deadline leaves less than one email's budget", async () => {
    const fetchMock = mockFetchJson(toddlerOk);
    const run = loadRunParseBatch(ENV);

    // Default budget: 180 s timeout + 30 s margin = 210 s; only 200 s left.
    const result = await run("tok", context, Date.now() + 200_000);

    expect(result.claimed).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(claimSql()).toHaveLength(0);
  });
});

// Finds the first call whose SQL contains `marker`.
function callWith(marker: string): { sql: string; params: { name: string; value: unknown }[] } {
  const call = db.executeQuery.mock.calls.find((c: unknown[]) => String(c[1]).includes(marker)) as unknown[] | undefined;
  if (!call) throw new Error(`no SQL containing ${marker}`);
  return { params: (call[2] ?? []) as { name: string; value: unknown }[], sql: String(call[1]) };
}

const LEASE_PREDICATE = "(AIClaimedAt IS NULL OR AIClaimedAt < DATEADD(SECOND, -@LeaseSeconds, SYSUTCDATETIME()))";

describe("runParseBatch → claim lease", () => {
  it("claims one unleased row with READPAST, in EmailID order, and stamps the lease", async () => {
    mockFetchJson(toddlerOk);
    const run = loadRunParseBatch(ENV);

    await run("tok", context);

    const { sql, params } = callWith("OUTPUT inserted");
    expect(sql).toContain("WITH (ROWLOCK, UPDLOCK, READPAST)");
    expect(sql).toContain("AIParsedAt IS NULL");
    expect(sql).toContain("AIParseAttempts < @MaxAttempts");
    expect(sql).toContain(LEASE_PREDICATE);
    expect(sql).toMatch(/ORDER BY EmailID/);
    expect(sql).toContain("AIParseAttempts = AIParseAttempts + 1");
    expect(sql).toContain("AIClaimedAt = SYSUTCDATETIME()");
    expect(sql).toContain("inserted.MatchedJobID");
    expect(sql).toMatch(/SELECT TOP \(1\)[\s\S]*?MatchedJobID[\s\S]*?FROM Emails/);
    expect(params).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "MaxAttempts", value: 3 }),
        expect.objectContaining({ name: "LeaseSeconds", value: 600 }),
      ]),
    );
  });

  it("never expires a row whose lease is still live", async () => {
    mockFetchJson(toddlerOk);
    const run = loadRunParseBatch(ENV);

    await run("tok", context);

    const { sql, params } = callWith("Max retries exhausted");
    expect(sql).toContain(LEASE_PREDICATE);
    expect(params).toEqual(expect.arrayContaining([expect.objectContaining({ name: "LeaseSeconds", value: 600 })]));
  });

  it("clears the lease on a successful write-back", async () => {
    mockFetchJson(toddlerOk);
    const run = loadRunParseBatch(ENV);

    await run("tok", context);

    expect(callWith("AIClassification = @Classification").sql).toContain("AIClaimedAt = NULL");
  });

  it("keeps the lease when recording a transient error so the retry waits for expiry", async () => {
    mockFetchJson({ detail: "down" }, false, 503);
    const run = loadRunParseBatch(ENV);

    await run("tok", context);

    const { sql } = callWith("AIParseError = @Error");
    expect(sql).not.toContain("AIClaimedAt");
    expect(sql).not.toContain("AIParsedAt");
  });

  it("keeps the lease when toddler reports a retryable model error", async () => {
    mockFetchJson({ ...toddlerOk, data: {}, error: "bad JSON" });
    const run = loadRunParseBatch(ENV);

    await run("tok", context);

    expect(callWith("AIParseError = @Error").sql).not.toContain("AIClaimedAt");
  });

  it("does not re-claim a row that just failed transiently in the same run", async () => {
    mockFetchJson({ detail: "down" }, false, 503);
    // Models the lease: a transient write only frees the row if it nulls AIClaimedAt.
    let leased = false;
    const handed: number[] = [];
    db.executeQuery.mockImplementation(async (_c: unknown, sql: string) => {
      if (sql.includes("OUTPUT inserted")) {
        if (leased) return [];
        leased = true;
        handed.push(claimedEmail.EmailID);
        return [claimedEmail];
      }
      if (sql.includes("AIParseError = @Error") && sql.includes("AIClaimedAt = NULL")) leased = false;
      return [];
    });
    const run = loadRunParseBatch(ENV);

    const result = await run("tok", context);

    expect(handed).toEqual([42]);
    expect(result.claimed).toBe(1);
  });
});

describe("runParseBatch → claim failure", () => {
  it("logs how far the run got and rethrows", async () => {
    mockFetchJson(toddlerOk);
    let claims = 0;
    db.executeQuery.mockImplementation(async (_c: unknown, sql: string) => {
      if (!sql.includes("OUTPUT inserted")) return [];
      claims++;
      if (claims === 1) return [claimedEmail];
      throw new Error("deadlock victim");
    });
    const errorSpy = jest.spyOn(context, "error").mockImplementation(() => undefined);
    const run = loadRunParseBatch(ENV);

    try {
      await expect(run("tok", context)).rejects.toThrow("deadlock victim");
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("runParseBatch: claim failed after 1 email(s)"), "deadlock victim");
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe("positiveIntFromEnv", () => {
  it.each([
    [undefined, 7],
    ["", 7],
    ["abc", 7],
    ["0", 7],
    ["-5", 7],
    ["Infinity", 7],
    ["2.5", 7],
    ["12", 12],
  ])("%p → %p", (raw, expected) => {
    expect(positiveIntFromEnv(raw, 7)).toBe(expected);
  });
});

describe("runParseBatch → config parsing", () => {
  it("falls back to the default batch size when AI_PARSE_BATCH_SIZE is not a number", async () => {
    const fetchMock = mockFetchJson(toddlerOk);
    stubClaims([1, 2, 3, 4, 5, 6].map((n) => ({ ...claimedEmail, EmailID: n })));
    const run = loadRunParseBatch({ ...ENV, AI_PARSE_BATCH_SIZE: "five" });

    const result = await run("tok", context);

    expect(result.claimed).toBe(5);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("falls back to the 180 s timeout when TODDLER_TIMEOUT_MS is not a number", async () => {
    mockFetchJson(toddlerOk);
    const run = loadRunParseBatch({ ...ENV, TODDLER_TIMEOUT_MS: "3 minutes" });

    // Default per-email budget is 210 s: 220 s left claims, 200 s would not.
    const result = await run("tok", context, Date.now() + 220_000);

    expect(result.claimed).toBe(1);
  });

  it("warns once when one email's budget exceeds the whole run", async () => {
    mockFetchJson(toddlerOk);
    const warnSpy = jest.spyOn(context, "warn").mockImplementation(() => undefined);
    const run = loadRunParseBatch({ ...ENV, TODDLER_TIMEOUT_MS: "600000" });

    try {
      await run("tok", context);
      await run("tok", context);

      const warnings = warnSpy.mock.calls.filter((c) => String(c[0]).includes("never claim"));
      expect(warnings).toHaveLength(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("does not warn with the default budget", async () => {
    mockFetchJson(toddlerOk);
    const warnSpy = jest.spyOn(context, "warn").mockImplementation(() => undefined);
    const run = loadRunParseBatch(ENV);

    try {
      await run("tok", context);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("parseEmailsTimer", () => {
  const TIMER_ENV = { ...ENV, MYBUILDINGS_BEARER_TOKEN: "sql-tok" };
  const warmupOk = { elapsedMs: 1200, loaded: true, model: "qwen3:14b" };

  it("returns without calling toddler when no unparsed rows are queued", async () => {
    const fetchMock = mockFetchRoutes({ "/parse-incoming": { body: toddlerOk }, "/warmup": { body: warmupOk } });
    stubQueue(false);
    const { parseEmailsTimer } = loadParseEmails(TIMER_ENV);

    await parseEmailsTimer(null, context);

    expect(fetchMock).not.toHaveBeenCalled();
    // Expire sweep, then the queue check; no claim, no write-back.
    expect(sqlOfCalls()).toEqual([
      expect.stringContaining("Max retries exhausted"),
      expect.stringContaining("SELECT TOP (1) EmailID"),
    ]);
  });

  it("flags an exhausted row on an idle tick without calling toddler", async () => {
    const fetchMock = mockFetchRoutes({ "/parse-incoming": { body: toddlerOk }, "/warmup": { body: warmupOk } });
    stubQueue(false);
    const { parseEmailsTimer } = loadParseEmails(TIMER_ENV);

    await parseEmailsTimer(null, context);

    const { sql, params } = callWith("Max retries exhausted");
    expect(sql).toContain("AIFlaggedForReview = 1");
    expect(params).toEqual(expect.arrayContaining([expect.objectContaining({ name: "MaxAttempts", value: 3 })]));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("queue check only counts rows a runner could claim (lease predicate)", async () => {
    mockFetchRoutes({});
    stubQueue(false);
    const { parseEmailsTimer } = loadParseEmails(TIMER_ENV);

    await parseEmailsTimer(null, context);

    const queueCheck = sqlOfCalls().find((s) => s.includes("SELECT TOP (1) EmailID") && !s.includes("OUTPUT"));
    expect(queueCheck).toContain(LEASE_PREDICATE);
    const call = db.executeQuery.mock.calls.find((c: unknown[]) => String(c[1]) === queueCheck) as unknown[];
    expect(call[2]).toEqual(expect.arrayContaining([expect.objectContaining({ name: "LeaseSeconds", value: 600 })]));
  });

  it("skips warm-up when the queue check leaves no time for warm-up plus one email", async () => {
    let now = 1_000_000;
    const nowSpy = jest.spyOn(Date, "now").mockImplementation(() => now);
    const warnSpy = jest.spyOn(context, "warn").mockImplementation(() => undefined);
    const fetchMock = mockFetchRoutes({ "/parse-incoming": { body: toddlerOk }, "/warmup": { body: warmupOk } });
    // Queue check burns 340 s of the 540 s budget → 200 s left < 210 s per-email budget.
    db.executeQuery.mockImplementation(async (_c: unknown, sql: string) => {
      if (!sql.includes("SELECT TOP (1) EmailID")) return [];
      now += 340_000;
      return [{ EmailID: 42 }];
    });
    const { parseEmailsTimer } = loadParseEmails(TIMER_ENV);

    try {
      await parseEmailsTimer(null, context);

      expect(fetchMock).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("no time left"));
    } finally {
      nowSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it("logs toddler's own elapsedMs from the warm-up body", async () => {
    mockFetchRoutes({ "/parse-incoming": { body: toddlerOk }, "/warmup": { body: warmupOk } });
    stubQueue(true);
    const logSpy = jest.spyOn(context, "log").mockImplementation(() => undefined);
    const { parseEmailsTimer } = loadParseEmails(TIMER_ENV);

    try {
      await parseEmailsTimer(null, context);

      expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/model ready after \d+ms \(toddler 1200ms\)/));
    } finally {
      logSpy.mockRestore();
    }
  });

  it("still succeeds when the warm-up body is not JSON or lacks elapsedMs", async () => {
    const fetchMock = jest.fn().mockImplementation(async (url: string) => ({
      json: async () => {
        if (new URL(url).pathname === "/warmup") throw new Error("not json");
        return toddlerOk;
      },
      ok: true,
      status: 200,
      text: async () => "",
    }));
    global.fetch = fetchMock as unknown as typeof fetch;
    stubQueue(true);
    const logSpy = jest.spyOn(context, "log").mockImplementation(() => undefined);
    const { parseEmailsTimer } = loadParseEmails(TIMER_ENV);

    try {
      await parseEmailsTimer(null, context);

      expect(fetchedPaths(fetchMock)).toEqual(["/warmup", "/parse-incoming"]);
      expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/^warmUpToddler: model ready after \d+ms$/));
    } finally {
      logSpy.mockRestore();
    }
  });

  it("flushes Sentry only when the tick fails", async () => {
    const sentry = (require("../sentry") as { Sentry: { flush: jest.Mock; captureException: jest.Mock } }).Sentry;
    mockFetchRoutes({});
    stubQueue(false);
    const { parseEmailsTimer } = loadParseEmails(TIMER_ENV);

    await parseEmailsTimer(null, context);
    expect(sentry.flush).not.toHaveBeenCalled();

    db.executeQuery.mockRejectedValue(new Error("db down"));
    const errorSpy = jest.spyOn(context, "error").mockImplementation(() => undefined);
    try {
      await parseEmailsTimer(null, context);
      expect(sentry.captureException).toHaveBeenCalled();
      expect(sentry.flush).toHaveBeenCalledWith(2000);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it.each([
    [503, "model load failed"],
    [429, "rate limited"],
    [401, "bad key"],
  ])("aborts the tick on warm-up %p without touching any row", async (status, error) => {
    const fetchMock = mockFetchRoutes({
      "/parse-incoming": { body: toddlerOk },
      "/warmup": { body: { error }, ok: false, status },
    });
    stubQueue(true);
    const { parseEmailsTimer } = loadParseEmails(TIMER_ENV);

    await parseEmailsTimer(null, context);

    expect(fetchedPaths(fetchMock)).toEqual(["/warmup"]);
    // Only the idempotent expire sweep may write; no claim, no write-back.
    expect(sqlOfCalls().filter((s) => /UPDATE/i.test(s) && !s.includes("Max retries exhausted"))).toEqual([]);
  });

  it("runs the batch after a successful warm-up", async () => {
    const fetchMock = mockFetchRoutes({ "/parse-incoming": { body: toddlerOk }, "/warmup": { body: warmupOk } });
    stubQueue(true);
    const { parseEmailsTimer } = loadParseEmails(TIMER_ENV);

    await parseEmailsTimer(null, context);

    expect(fetchedPaths(fetchMock)).toEqual(["/warmup", "/parse-incoming"]);
    const [, warmupInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(warmupInit.method).toBe("POST");
    expect(warmupInit.headers).toMatchObject({ "X-Service-Key": "test-key" });
    expect(sqlOfCalls().some((s) => s.includes("AIClassification = @Classification"))).toBe(true);
  });

  it("skips entirely when TODDLER_URL is unset", async () => {
    const fetchMock = mockFetchRoutes({});
    stubQueue(true);
    const { parseEmailsTimer } = loadParseEmails({ ...TIMER_ENV, TODDLER_URL: undefined });

    await parseEmailsTimer(null, context);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.executeQuery).not.toHaveBeenCalled();
  });
});

describe("triggerEmailParse", () => {
  function adminRequest(query = ""): HttpRequest {
    return { headers: { get: () => null }, query: new URLSearchParams(query) } as unknown as HttpRequest;
  }

  it("enqueues an admin sync and returns 202 without calling toddler or SQL", async () => {
    const fetchMock = mockFetchRoutes({});
    const { adminTriggerEmailParse } = loadParseEmails(ENV);
    const invocation = new InvocationContext();

    const res = await adminTriggerEmailParse(adminRequest(), invocation);

    expect(res.status).toBe(202);
    expect(invocation.extraOutputs.get(emailSyncQueueOutput)).toMatchObject({ source: "admin" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.executeQuery).not.toHaveBeenCalled();
  });

  it("?reset=true resets failed rows inline, then enqueues", async () => {
    mockFetchRoutes({});
    const { adminTriggerEmailParse } = loadParseEmails(ENV);
    const invocation = new InvocationContext();

    const res = await adminTriggerEmailParse(adminRequest("reset=true"), invocation);

    expect(res.status).toBe(202);
    expect(sqlOfCalls()).toHaveLength(1);
    expect(sqlOfCalls()[0]).toMatch(/AIParseAttempts\s+= 0/);
    expect(invocation.extraOutputs.get(emailSyncQueueOutput)).toMatchObject({ source: "admin" });
  });

  it("returns 503 and enqueues nothing when toddler is not configured", async () => {
    const { adminTriggerEmailParse } = loadParseEmails({ ...ENV, TODDLER_URL: undefined });
    const invocation = new InvocationContext();

    const res = await adminTriggerEmailParse(adminRequest(), invocation);

    expect(res.status).toBe(503);
    expect(invocation.extraOutputs.get(emailSyncQueueOutput)).toBeUndefined();
  });
});

describe("processEmailSync", () => {
  const QUEUE_ENV = { ...ENV, GRAPH_MAILBOX_DEV: "inbox@example.test", MYBUILDINGS_BEARER_TOKEN: "sql-tok" };

  it("syncs the mailbox, then warms up and runs the deadline runner", async () => {
    const fetchMock = mockFetchRoutes({ "/parse-incoming": { body: toddlerOk }, "/warmup": { body: { loaded: true } } });
    stubQueue(true);
    const { processEmailSync } = loadParseEmails(QUEUE_ENV);

    await processEmailSync({ requestedAt: "2026-10-07T00:00:00.000Z", source: "graph" }, context);

    expect(mailSync.syncMailbox).toHaveBeenCalledWith({}, "inbox@example.test");
    expect(fetchedPaths(fetchMock)).toEqual(["/warmup", "/parse-incoming"]);
    expect(mailSync.syncMailbox.mock.invocationCallOrder[0]).toBeLessThan(fetchMock.mock.invocationCallOrder[0]);
  });

  it("rethrows a sync failure so the queue retries, without calling toddler", async () => {
    const fetchMock = mockFetchRoutes({});
    mailSync.syncMailbox.mockRejectedValueOnce(new Error("Graph fetch emails failed: 503"));
    const { processEmailSync } = loadParseEmails(QUEUE_ENV);

    await expect(
      processEmailSync({ requestedAt: "2026-10-07T00:00:00.000Z", source: "manual" }, context),
    ).rejects.toThrow("Graph fetch emails failed: 503");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports a sync failure to Sentry (and flushes) before rethrowing", async () => {
    const sentry = (require("../sentry") as { Sentry: { flush: jest.Mock; captureException: jest.Mock } }).Sentry;
    mockFetchRoutes({});
    const failure = new Error("Graph fetch emails failed: 503");
    mailSync.syncMailbox.mockRejectedValueOnce(failure);
    const { processEmailSync } = loadParseEmails(QUEUE_ENV);

    await expect(
      processEmailSync({ requestedAt: "2026-10-07T00:00:00.000Z", source: "graph" }, context),
    ).rejects.toThrow(failure);

    expect(sentry.captureException).toHaveBeenCalledWith(failure, expect.anything());
    expect(sentry.flush).toHaveBeenCalledWith(2000);
  });

  it("without GRAPH_MAILBOX_DEV logs an error, skips the sync and still parses", async () => {
    const fetchMock = mockFetchRoutes({ "/parse-incoming": { body: toddlerOk }, "/warmup": { body: { loaded: true } } });
    stubQueue(true);
    const errorSpy = jest.spyOn(context, "error").mockImplementation(() => undefined);
    const { processEmailSync } = loadParseEmails({ ...QUEUE_ENV, GRAPH_MAILBOX_DEV: undefined });

    try {
      await processEmailSync({ requestedAt: "2026-10-07T00:00:00.000Z", source: "graph" }, context);

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("GRAPH_MAILBOX_DEV not configured"));
      expect(mailSync.syncMailbox).not.toHaveBeenCalled();
      expect(fetchedPaths(fetchMock)).toEqual(["/warmup", "/parse-incoming"]);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("resolves (so the message is not re-dequeued) when toddler warm-up fails after a good sync", async () => {
    mockFetchRoutes({ "/warmup": { body: { error: "down" }, ok: false, status: 503 } });
    stubQueue(true);
    const errorSpy = jest.spyOn(context, "error").mockImplementation(() => undefined);
    const { processEmailSync } = loadParseEmails(QUEUE_ENV);

    try {
      await expect(
        processEmailSync({ requestedAt: "2026-10-07T00:00:00.000Z", source: "graph" }, context),
      ).resolves.toBeUndefined();
      expect(mailSync.syncMailbox).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("resolves when the parse step itself throws (DB down after the sync)", async () => {
    mockFetchRoutes({});
    db.executeQuery.mockRejectedValue(new Error("db down"));
    const errorSpy = jest.spyOn(context, "error").mockImplementation(() => undefined);
    const { processEmailSync } = loadParseEmails(QUEUE_ENV);

    try {
      await expect(
        processEmailSync({ requestedAt: "2026-10-07T00:00:00.000Z", source: "graph" }, context),
      ).resolves.toBeUndefined();
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe("parseEmailsDailyRetry", () => {
  const DAILY_ENV = { ...ENV, MYBUILDINGS_BEARER_TOKEN: "sql-tok" };

  it("enqueues a timer sync message as the low-frequency backstop, and still parses", async () => {
    mockFetchRoutes({ "/parse-incoming": { body: toddlerOk }, "/warmup": { body: { loaded: true } } });
    stubQueue(true);
    const invocation = new InvocationContext();
    const { parseEmailsDailyRetry } = loadParseEmails(DAILY_ENV);

    await parseEmailsDailyRetry(null, invocation);

    expect(invocation.extraOutputs.get(emailSyncQueueOutput)).toMatchObject({ source: "timer" });
    expect(sqlOfCalls().some((s) => s.includes("AIClassification = @Classification"))).toBe(true);
  });

  it("enqueues the sync even when the parse finds nothing to do", async () => {
    mockFetchRoutes({});
    stubQueue(false);
    const invocation = new InvocationContext();
    const { parseEmailsDailyRetry } = loadParseEmails(DAILY_ENV);

    await parseEmailsDailyRetry(null, invocation);

    expect(invocation.extraOutputs.get(emailSyncQueueOutput)).toMatchObject({ source: "timer" });
  });
});

describe("runParseBatch → knownJob", () => {
  interface JobRow {
    AwaitingQuoteAmount: number | null;
    AwaitingQuoteID: number | null;
    AwaitingQuoteNumber: string | null;
    ContractorName: string;
    JobID: number;
    Status: string;
    Title: string;
  }

  const knownJobRow: JobRow = {
    AwaitingQuoteAmount: 1234,
    AwaitingQuoteID: 7,
    AwaitingQuoteNumber: "260419-QT-42-ACM-1",
    ContractorName: "Acme Plumbing",
    JobID: 42,
    Status: "Work",
    Title: "Leaking tap L2 kitchen",
  };

  function stubClaim(email: typeof claimedEmail, jobRow: JobRow | null): void {
    stubClaims([email], (sql) => (sql.includes("FROM Jobs j") ? (jobRow ? [jobRow] : []) : undefined));
  }

  function sentBody(fetchMock: jest.Mock): Record<string, unknown> {
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    return JSON.parse(String(init.body)) as Record<string, unknown>;
  }

  it("sends knownJob when the email is matched to a job", async () => {
    const fetchMock = mockFetchJson(toddlerOk);
    stubClaim({ ...claimedEmail, MatchedJobID: 42 }, knownJobRow);
    const run = loadRunParseBatch(ENV);

    await run("tok", context);

    expect(sentBody(fetchMock).knownJob).toEqual({
      awaitingDirectorQuote: { amount: 1234, quoteId: 7, quoteNumber: "260419-QT-42-ACM-1" },
      contractorName: "Acme Plumbing",
      jobId: 42,
      status: "Work",
      title: "Leaking tap L2 kitchen",
    });
  });

  it("falls back awaiting quote -> PO -> awaiting-director quote for contractorName, with PK tiebreaks", async () => {
    mockFetchJson(toddlerOk);
    stubClaim({ ...claimedEmail, MatchedJobID: 42 }, knownJobRow);
    const run = loadRunParseBatch(ENV);

    await run("tok", context);

    const sql = callWith("FROM Jobs j").sql;
    expect(sql).toContain("COALESCE(aq.ContractorName, po.ContractorName, dq.ContractorName)");
    expect(sql).toContain("ORDER BY p.CreatedAt DESC, p.PurchaseOrderID DESC");
    expect(sql).toContain("ORDER BY q.CreatedAt DESC, q.QuoteID DESC");
  });

  it("sends awaitingDirectorQuote: null when no quote is awaiting the director", async () => {
    const fetchMock = mockFetchJson(toddlerOk);
    stubClaim(
      { ...claimedEmail, MatchedJobID: 42 },
      { ...knownJobRow, AwaitingQuoteAmount: null, AwaitingQuoteID: null, AwaitingQuoteNumber: null },
    );
    const run = loadRunParseBatch(ENV);

    await run("tok", context);

    const knownJob = sentBody(fetchMock).knownJob as { awaitingDirectorQuote: unknown };
    expect(knownJob.awaitingDirectorQuote).toBeNull();
  });

  it("omits knownJob and skips the lookup when MatchedJobID is null", async () => {
    const fetchMock = mockFetchJson(toddlerOk);
    stubClaim(claimedEmail, knownJobRow);
    const run = loadRunParseBatch(ENV);

    await run("tok", context);

    expect("knownJob" in sentBody(fetchMock)).toBe(false);
    expect(sqlOfCalls().some((s) => s.includes("FROM Jobs j"))).toBe(false);
  });

  it("still parses (without knownJob) when the matched job no longer exists", async () => {
    const fetchMock = mockFetchJson(toddlerOk);
    stubClaim({ ...claimedEmail, MatchedJobID: 999 }, null);
    const run = loadRunParseBatch(ENV);

    const result = await run("tok", context);

    expect(result.succeeded).toBe(1);
    expect("knownJob" in sentBody(fetchMock)).toBe(false);
  });

  it("still parses (without knownJob) when the lookup throws", async () => {
    const fetchMock = mockFetchJson(toddlerOk);
    stubClaims([{ ...claimedEmail, MatchedJobID: 42 }], (sql) => {
      if (sql.includes("FROM Jobs j")) throw new Error("sql down");
      return undefined;
    });
    const run = loadRunParseBatch(ENV);

    const result = await run("tok", context);

    expect(result.succeeded).toBe(1);
    expect("knownJob" in sentBody(fetchMock)).toBe(false);
  });
});

describe("runParseBatch → AI_PARSE_SKIP_SENDERS", () => {
  it("short-circuits a matching sender to unknown/high without calling toddler", async () => {
    const fetchMock = mockFetchJson(toddlerOk);
    stubClaims([{ ...claimedEmail, FromAddress: "No-Reply@MyBuildings.com.au" }]);
    const run = loadRunParseBatch({ ...ENV, AI_PARSE_SKIP_SENDERS: "no-reply@, bounces@" });

    const result = await run("tok", context);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toEqual({ claimed: 1, errored: 0, flagged: 0, succeeded: 1 });
    const write = db.executeQuery.mock.calls.find((c: unknown[]) =>
      String(c[1]).includes("AIClassification = @Classification"),
    ) as unknown[] | undefined;
    const params = Object.fromEntries(
      ((write?.[2] as { name: string; value: unknown }[]) ?? []).map((p) => [p.name, p.value]),
    );
    expect(params).toMatchObject({
      Classification: "unknown",
      Confidence: "high",
      Flagged: 0,
      ModelVersion: "skip-sender@v5",
    });
  });

  it("records the error on the row when the skip-sender write fails", async () => {
    mockFetchJson(toddlerOk);
    stubClaims([{ ...claimedEmail, FromAddress: "no-reply@x.com" }], (sql) => {
      if (sql.includes("AIClassification = @Classification")) throw new Error("write failed");
      return undefined;
    });
    const errorSpy = jest.spyOn(context, "error").mockImplementation(() => undefined);
    const run = loadRunParseBatch({ ...ENV, AI_PARSE_SKIP_SENDERS: "no-reply@" });

    try {
      const result = await run("tok", context);

      expect(result.errored).toBe(1);
      const { params } = callWith("SET AIParseError = @Error");
      expect(params.find((p) => p.name === "Error")?.value).toBe("write failed");
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("calls toddler as normal when the setting is empty", async () => {
    const fetchMock = mockFetchJson(toddlerOk);
    const run = loadRunParseBatch({ ...ENV, AI_PARSE_SKIP_SENDERS: undefined });

    await run("tok", context);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("runParseBatch → documentFields", () => {
  const fields = { total: { confidence: 0.93, value: 1234.5 }, vendor: { confidence: 0.8, value: null } };

  function storedParsedData(): Record<string, unknown> {
    const write = db.executeQuery.mock.calls.find((c: unknown[]) =>
      String(c[1]).includes("AIClassification = @Classification"),
    ) as unknown[] | undefined;
    const p = ((write?.[2] as { name: string; value: unknown }[]) ?? []).find((x) => x.name === "ParsedData");
    return JSON.parse(String(p?.value)) as Record<string, unknown>;
  }

  it("stores documentFields alongside data in AIParsedData", async () => {
    mockFetchJson({ ...toddlerOk, documentFields: fields });
    const run = loadRunParseBatch(ENV);

    await run("tok", context);

    expect(storedParsedData()).toEqual({ documentFields: fields, quoteNumber: "Q-123" });
  });

  it("drops a model-written documentFields key from data when toddler sent none", async () => {
    mockFetchJson({ ...toddlerOk, data: { quoteNumber: "Q-123", documentFields: { evil: { confidence: 1, value: "x" } } } });
    const run = loadRunParseBatch(ENV);

    await run("tok", context);

    expect(storedParsedData()).toEqual({ quoteNumber: "Q-123" });
  });

  it.each([[undefined], [null]])("leaves the stored shape unchanged when documentFields is %s", async (value) => {
    mockFetchJson({ ...toddlerOk, documentFields: value });
    const run = loadRunParseBatch(ENV);

    await run("tok", context);

    expect(storedParsedData()).toEqual({ quoteNumber: "Q-123" });
  });
});

describe("runParseBatch → flagging and unknown handling", () => {
  const fields = { total: { confidence: 0.9, value: 10 } };

  function stored(): { flagged: unknown; data: Record<string, unknown> } {
    const write = db.executeQuery.mock.calls.find((c: unknown[]) =>
      String(c[1]).includes("AIClassification = @Classification"),
    ) as unknown[] | undefined;
    const params = (write?.[2] ?? []) as { name: string; value: unknown }[];
    const byName = (n: string): unknown => params.find((x) => x.name === n)?.value;
    return { data: JSON.parse(String(byName("ParsedData"))) as Record<string, unknown>, flagged: byName("Flagged") };
  }

  it.each([["high"], ["low"]])("never flags unknown/%s and stores an empty data object", async (confidence) => {
    mockFetchJson({ ...toddlerOk, classification: "unknown", confidence, data: { title: "model guess" } });
    const result = await loadRunParseBatch(ENV)("tok", context);

    expect(result.flagged).toBe(0);
    expect(stored()).toEqual({ data: {}, flagged: 0 });
  });

  it("keeps documentFields provenance on an unknown", async () => {
    mockFetchJson({ ...toddlerOk, classification: "unknown", confidence: "high", data: { title: "x" }, documentFields: fields });
    await loadRunParseBatch(ENV)("tok", context);

    expect(stored().data).toEqual({ documentFields: fields });
  });

  it("still flags job/low", async () => {
    mockFetchJson({ ...toddlerOk, classification: "job", confidence: "low", data: { title: "t" } });
    const result = await loadRunParseBatch(ENV)("tok", context);

    expect(result.flagged).toBe(1);
    expect(stored().flagged).toBe(1);
  });

  it("does not flag job/high", async () => {
    mockFetchJson({ ...toddlerOk, classification: "job", confidence: "high", data: { title: "t" } });
    const result = await loadRunParseBatch(ENV)("tok", context);

    expect(result.flagged).toBe(0);
    expect(stored().flagged).toBe(0);
  });
});

describe("runParseBatch → suspicious emails", () => {
  function stored(): { flagged: unknown; data: Record<string, unknown> } {
    const write = db.executeQuery.mock.calls.find((c: unknown[]) =>
      String(c[1]).includes("AIClassification = @Classification"),
    ) as unknown[] | undefined;
    const params = (write?.[2] ?? []) as { name: string; value: unknown }[];
    const byName = (n: string): unknown => params.find((x) => x.name === n)?.value;
    return { data: JSON.parse(String(byName("ParsedData"))) as Record<string, unknown>, flagged: byName("Flagged") };
  }

  it("stores suspicious + reasons and keeps a low-confidence job visible", async () => {
    mockFetchJson({ ...toddlerOk, confidence: "low", data: {}, suspicious: true, suspicionReasons: ["asks to ignore instructions"] });
    const result = await loadRunParseBatch(ENV)("tok", context);

    expect(result.flagged).toBe(0);
    expect(result.succeeded).toBe(1);
    expect(stored()).toEqual({
      data: { suspicionReasons: ["asks to ignore instructions"], suspicious: true },
      flagged: 0,
    });
  });

  it("strips model-written suspicious keys from data without a top-level flag", async () => {
    mockFetchJson({ ...toddlerOk, data: { quoteNumber: "Q-123", suspicionReasons: ["x"], suspicious: true } });
    await loadRunParseBatch(ENV)("tok", context);

    expect(stored().data).toEqual({ quoteNumber: "Q-123" });
  });

  it("strips model-written suspicious keys even when the top-level flag is set", async () => {
    mockFetchJson({ ...toddlerOk, data: { quoteNumber: "Q-123", suspicious: false, suspicionReasons: ["fake"] }, suspicious: true, suspicionReasons: ["real"] });
    await loadRunParseBatch(ENV)("tok", context);

    expect(stored().data).toEqual({ quoteNumber: "Q-123", suspicionReasons: ["real"], suspicious: true });
  });

  it.each([["true"], [1], [null]])("treats suspicious=%p as false", async (value) => {
    mockFetchJson({ ...toddlerOk, suspicionReasons: ["x"], suspicious: value });
    await loadRunParseBatch(ENV)("tok", context);

    expect(stored().data).toEqual({ quoteNumber: "Q-123" });
  });

  it("caps reasons at 5 string items of 200 chars", async () => {
    const reasons = ["a".repeat(300), 42, "b", "c", "d", "e", "f"];
    mockFetchJson({ ...toddlerOk, suspicious: true, suspicionReasons: reasons });
    await loadRunParseBatch(ENV)("tok", context);

    expect(stored().data.suspicionReasons).toEqual(["a".repeat(200), "b", "c", "d", "e"]);
  });

  it("stores an empty reasons list when reasons are missing", async () => {
    mockFetchJson({ ...toddlerOk, suspicious: true });
    await loadRunParseBatch(ENV)("tok", context);

    expect(stored().data).toEqual({ quoteNumber: "Q-123", suspicionReasons: [], suspicious: true });
  });

  it("stores only the suspicious keys for an unknown", async () => {
    mockFetchJson({ ...toddlerOk, classification: "unknown", confidence: "low", data: { title: "x" }, suspicious: true, suspicionReasons: ["r"] });
    const result = await loadRunParseBatch(ENV)("tok", context);

    expect(result.flagged).toBe(0);
    expect(stored().data).toEqual({ suspicionReasons: ["r"], suspicious: true });
  });

  it("logs one info line with the email id and reason count, never the reasons", async () => {
    mockFetchJson({ ...toddlerOk, suspicious: true, suspicionReasons: ["secret reason text", "b"] });
    const infoSpy = jest.spyOn(context, "info").mockImplementation(() => undefined);
    try {
      await loadRunParseBatch(ENV)("tok", context);

      const lines = infoSpy.mock.calls.map((c) => c.join(" ")).filter((l) => l.includes("suspicious"));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(`#${claimedEmail.EmailID}`);
      expect(lines[0]).toContain("2");
      expect(lines[0]).not.toContain("secret reason text");
    } finally {
      infoSpy.mockRestore();
    }
  });

  it("does not log for a non-suspicious email", async () => {
    mockFetchJson(toddlerOk);
    const infoSpy = jest.spyOn(context, "info").mockImplementation(() => undefined);
    try {
      await loadRunParseBatch(ENV)("tok", context);

      expect(infoSpy.mock.calls.filter((c) => c.join(" ").includes("suspicious"))).toHaveLength(0);
    } finally {
      infoSpy.mockRestore();
    }
  });
});
