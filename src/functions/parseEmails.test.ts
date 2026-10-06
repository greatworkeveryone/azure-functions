/// <reference types="jest" />
import { InvocationContext } from "@azure/functions";

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn(), timer: jest.fn() } };
});

jest.mock("../db", () => ({
  closeConnection: jest.fn(),
  createRequestConnection: jest.fn().mockResolvedValue({}),
  executeQuery: jest.fn(),
}));

jest.mock("../auth", () => {
  const actual = jest.requireActual("../auth");
  return { ...actual, requireRole: jest.fn().mockResolvedValue(null) };
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

const db = require("../db") as { executeQuery: jest.Mock };

type RunParseBatch = typeof import("./parseEmails").runParseBatch;

// TODDLER_* are read at module load, so each test loads a fresh copy.
function loadRunParseBatch(env: Record<string, string | undefined>): RunParseBatch {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  let fn: RunParseBatch | undefined;
  jest.isolateModules(() => {
    fn = (require("./parseEmails") as { runParseBatch: RunParseBatch }).runParseBatch;
  });
  if (!fn) throw new Error("module failed to load");
  return fn;
}

const claimedEmail = {
  AttachmentBlobs: null,
  Body: "<p>Please quote Q-123</p>",
  EmailID: 42,
  FromAddress: "a@b.com",
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

function sqlOfCalls(): string[] {
  return db.executeQuery.mock.calls.map((c: unknown[]) => String(c[1]));
}

const context = new InvocationContext();
const ENV = { TODDLER_SERVICE_KEY: "test-key", TODDLER_URL: "https://toddler.test" };

beforeEach(() => {
  jest.clearAllMocks();
  // claimBatch runs two UPDATEs; only the OUTPUT one yields rows.
  db.executeQuery.mockImplementation(async (_c: unknown, sql: string) =>
    sql.includes("OUTPUT inserted") ? [claimedEmail] : [],
  );
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
    expect(sql.some((s) => s.includes("SET AIParseError = @Error WHERE EmailID = @Id"))).toBe(true);
  });

  it("writes a genuine unknown classification (no error) as success and flags it", async () => {
    mockFetchJson({ ...toddlerOk, classification: "unknown", confidence: "low", data: {} });
    const run = loadRunParseBatch(ENV);

    const result = await run("tok", context);

    expect(result).toEqual({ claimed: 1, errored: 0, flagged: 1, succeeded: 1 });
    expect(sqlOfCalls().some((s) => s.includes("AIClassification = @Classification"))).toBe(true);
  });

  it("records a transient error when toddler responds non-2xx", async () => {
    mockFetchJson({ detail: "Missing credentials" }, false, 401);
    const run = loadRunParseBatch(ENV);

    const result = await run("tok", context);

    expect(result).toEqual({ claimed: 1, errored: 1, flagged: 0, succeeded: 0 });
    const errCall = db.executeQuery.mock.calls.find((c: unknown[]) =>
      String(c[1]).includes("SET AIParseError = @Error WHERE EmailID = @Id"),
    ) as unknown[] | undefined;
    const params = errCall?.[2] as { name: string; value: unknown }[];
    expect(params.find((p) => p.name === "Error")?.value).toMatch(/Toddler 401/);
  });
});
