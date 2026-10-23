/// <reference types="jest" />
// runAi end to end, with the database and the network mocked: the order of its
// checks, what a provider is ever sent, and the one row each call leaves.

jest.mock("../db", () => ({
  closeConnection: jest.fn(),
  createServiceRequestConnection: jest.fn(),
  executeQuery: jest.fn(),
}));
jest.mock("../sentry", () => ({ Sentry: { captureException: jest.fn(), captureMessage: jest.fn() } }));

import { closeConnection, createServiceRequestConnection, executeQuery } from "../db";
import { Sentry } from "../sentry";
import { AiAuditError } from "./refusals";
import * as registry from "./registry";
import { runAi } from "./runAi";
import { definePurpose, type AiActor, type AiRequest } from "./types";

const query = jest.mocked(executeQuery);
const fetchMock = jest.fn();
const saved = { ...process.env };

const ACTOR: AiActor = { email: "jo@randazzo.example", kind: "user", name: "Jo Bloggs", role: "facilities", userId: 41 };
const request = (over: Partial<AiRequest> = {}): AiRequest => ({ actor: ACTOR, input: "Floorplan AI health check", purpose: "echo_test", ...over });

type Row = Record<string, unknown>;
let recentCalls = 0;
let insertShouldFail = false;
let countShouldFail = false;

const inserts = (): Row[] =>
  query.mock.calls
    .filter((call) => String(call[1]).includes("INSERT INTO dbo.AiCallLog"))
    .map((call) => Object.fromEntries((call[2] ?? []).map((param) => [param.name, param.value])));
const counts = () => query.mock.calls.filter((call) => String(call[1]).includes("SELECT COUNT(*)"));

function answer(content: string, status = 200): Response {
  const body = status === 200 ? { choices: [{ message: { content } }] } : { error: { message: `prompt was ${content}` } };
  return new Response(JSON.stringify(body), { status });
}

beforeEach(() => {
  jest.clearAllMocks();
  recentCalls = 0;
  insertShouldFail = false;
  countShouldFail = false;
  process.env = { ...saved, AI_ENABLED: "true" };
  for (const name of ["AI_PROVIDER", "AI_BASE_URL", "AI_MODEL", "AI_API_KEY", "AI_LOG_CONTENT", "AI_TIMEOUT_MS", "AI_RATE_PER_MINUTE"]) delete process.env[name];
  jest.mocked(createServiceRequestConnection).mockResolvedValue({} as never);
  query.mockImplementation(async (_connection, sql) => {
    if (sql.includes("INSERT INTO dbo.AiCallLog")) {
      if (insertShouldFail) throw new Error("Invalid object name 'dbo.AiCallLog'.");
      return [{ Id: "101" }];
    }
    if (countShouldFail) throw new Error("connection lost");
    return [{ Calls: recentCalls }];
  });
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
  jest.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(() => {
  process.env = saved;
});

describe("the switch", () => {
  it.each([undefined, "", "false", "TRUE", "True", "1", "yes", " true "])("refuses as disabled when AI_ENABLED is %j, and sends nothing anywhere", async (value) => {
    if (value === undefined) delete process.env.AI_ENABLED;
    else process.env.AI_ENABLED = value;
    process.env.AI_PROVIDER = "openai_compatible";
    process.env.AI_BASE_URL = "https://llm.example";
    process.env.AI_MODEL = "m";

    const result = await runAi(request());

    expect(result).toMatchObject({ ok: false, refusal: { code: "disabled" } });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(counts()).toHaveLength(0);
    expect(inserts()).toHaveLength(1);
    expect(inserts()[0]).toMatchObject({ ErrorCode: "disabled", Model: null, Outcome: "refused", LatencyMs: null, OutputChars: null });
  });

  it("says so in a plain sentence, with no provider text", async () => {
    delete process.env.AI_ENABLED;
    const result = await runAi(request());
    expect(result.ok === false && result.refusal.message).toBe("AI is switched off, so nothing was sent to a model.");
  });

  it("still answers disabled when the row cannot be written", async () => {
    delete process.env.AI_ENABLED;
    insertShouldFail = true;
    const result = await runAi(request());
    expect(result).toMatchObject({ meta: { callId: null }, ok: false, refusal: { code: "disabled" } });
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });
});

describe("the mock provider (the default)", () => {
  it("answers an allowed purpose with schema-valid output and writes one row", async () => {
    const result = await runAi(request());

    expect(result).toMatchObject({ ok: true, output: { echo: "Floorplan AI health check" } });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(inserts()).toHaveLength(1);
    expect(inserts()[0]).toMatchObject({
      ActorEmail: "jo@randazzo.example",
      ActorKind: "user",
      ActorName: "Jo Bloggs",
      ActorRole: "facilities",
      ActorUserId: 41,
      ErrorCode: null,
      InputChars: 25,
      Model: "mock",
      Outcome: "ok",
      OutputChars: JSON.stringify({ echo: "Floorplan AI health check" }).length,
      PromptVersion: "echo_test@1",
      Provider: "mock",
      Purpose: "echo_test",
      RedactionCount: 0,
    });
    expect(typeof inserts()[0].LatencyMs).toBe("number");
    expect(inserts()[0].InputSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.meta).toMatchObject({ callId: 101, model: "mock", promptVersion: "echo_test@1", provider: "mock", purpose: "echo_test", redactionCount: 0 });
  });

  it("keeps no text in the log unless AI_LOG_CONTENT is exactly true", async () => {
    for (const value of [undefined, "false", "TRUE", "1"]) {
      query.mockClear();
      if (value === undefined) delete process.env.AI_LOG_CONTENT;
      else process.env.AI_LOG_CONTENT = value;
      await runAi(request({ input: "Contact jo@example.com" }));
      expect(inserts()[0]).toMatchObject({ InputText: null, OutputText: null });
      expect(JSON.stringify(inserts()[0])).not.toContain("jo@example.com");
    }
  });

  it("keeps the redacted text, never the original, when AI_LOG_CONTENT is true", async () => {
    process.env.AI_LOG_CONTENT = "true";
    await runAi(request({ input: "Contact jo@example.com" }));
    const row = inserts()[0];
    expect(row.InputText).toBe("Contact [EMAIL]");
    expect(row.OutputText).toBe('{"echo":"Contact [EMAIL]"}');
    expect(JSON.stringify(row)).not.toContain("jo@example.com");
    expect(row.RedactionCount).toBe(1);
  });

  it("hashes the redacted input, so the same text with a different address gives the same hash", async () => {
    await runAi(request({ input: "Contact jo@example.com" }));
    await runAi(request({ input: "Contact al@example.org" }));
    const [first, second] = inserts();
    expect(first.InputSha256).toBe(second.InputSha256);
  });

  it("records the call against its record and correlation id", async () => {
    const correlationId = "0f9e8d7c-6b5a-4f3e-9d2c-1b0a99887766";
    const result = await runAi(request({ correlationId, recordId: "42", recordType: "quote" }));
    expect(inserts()[0]).toMatchObject({ CorrelationId: correlationId, RecordId: "42", RecordType: "quote" });
    expect(result.meta.correlationId).toBe(correlationId);
  });

  it("makes its own correlation id when none, or one that is not a UUID, is given", async () => {
    const a = await runAi(request());
    const b = await runAi(request({ correlationId: "not-a-uuid" }));
    expect(a.meta.correlationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(b.meta.correlationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(a.meta.correlationId).not.toBe(b.meta.correlationId);
  });
});

describe("refusals before anything is sent", () => {
  it("refuses a purpose that is not on the allowlist, logging the id it asked for", async () => {
    const result = await runAi(request({ purpose: "write_my_emails" }));
    expect(result).toMatchObject({ ok: false, refusal: { code: "purpose_not_allowed" } });
    expect(counts()).toHaveLength(0);
    expect(inserts()[0]).toMatchObject({ ErrorCode: "purpose_not_allowed", Outcome: "refused", Purpose: "write_my_emails", PromptVersion: "unknown", Model: null });
  });

  it.each([undefined, null, 42, {}, "__proto__", "constructor", "toString", ""])("refuses the purpose %j", async (purpose) => {
    const result = await runAi(request({ purpose: purpose as never }));
    expect(result).toMatchObject({ ok: false, refusal: { code: "purpose_not_allowed" } });
  });

  it("refuses an input over the purpose's cap, whole, and logs its size", async () => {
    const result = await runAi(request({ input: "x".repeat(201) }));
    expect(result).toMatchObject({ ok: false, refusal: { code: "input_too_large" } });
    expect(inserts()[0]).toMatchObject({ ErrorCode: "input_too_large", InputChars: 201, Outcome: "refused" });
    expect(counts()).toHaveLength(0);
  });

  it("lets an input of exactly the cap through", async () => {
    expect(await runAi(request({ input: "x".repeat(200) }))).toMatchObject({ ok: true });
  });

  it("refuses when this person has made as many calls as the limit allows in the last minute", async () => {
    recentCalls = 20;
    const result = await runAi(request());
    expect(result).toMatchObject({ ok: false, refusal: { code: "rate_limited" } });
    expect(inserts()[0]).toMatchObject({ ErrorCode: "rate_limited", Outcome: "refused" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows the call one under the limit, and follows AI_RATE_PER_MINUTE", async () => {
    recentCalls = 19;
    expect(await runAi(request())).toMatchObject({ ok: true });
    process.env.AI_RATE_PER_MINUTE = "5";
    recentCalls = 5;
    expect(await runAi(request())).toMatchObject({ ok: false, refusal: { code: "rate_limited" } });
    recentCalls = 4;
    expect(await runAi(request())).toMatchObject({ ok: true });
  });

  it("counts by the person asking: the count query is given their id and email", async () => {
    await runAi(request());
    const params = Object.fromEntries((counts()[0][2] ?? []).map((param) => [param.name, param.value]));
    expect(params).toMatchObject({ Email: "jo@randazzo.example", Kind: "user", Name: "Jo Bloggs", UserId: 41 });
  });

  it("does not make the call when it cannot count (it is not read as zero)", async () => {
    countShouldFail = true;
    await expect(runAi(request())).rejects.toThrow("connection lost");
    expect(inserts()).toHaveLength(0);
  });

  it("applies the checks in order: switch, then purpose, then size, then rate", async () => {
    recentCalls = 99;
    delete process.env.AI_ENABLED;
    expect(await runAi(request({ input: "x".repeat(999), purpose: "nope" }))).toMatchObject({ refusal: { code: "disabled" } });
    process.env.AI_ENABLED = "true";
    expect(await runAi(request({ input: "x".repeat(999), purpose: "nope" }))).toMatchObject({ refusal: { code: "purpose_not_allowed" } });
    expect(await runAi(request({ input: "x".repeat(999) }))).toMatchObject({ refusal: { code: "input_too_large" } });
    expect(await runAi(request())).toMatchObject({ refusal: { code: "rate_limited" } });
  });
});

describe("the openai_compatible provider", () => {
  beforeEach(() => {
    process.env.AI_PROVIDER = "openai_compatible";
    process.env.AI_BASE_URL = "https://llm.randazzo.example/";
    process.env.AI_MODEL = "llama-3.1-8b";
  });

  it("sends the redacted input only, and never the original", async () => {
    fetchMock.mockResolvedValue(answer('{"echo":"ok"}'));
    await runAi(request({ input: "Call Jo on 0412 345 678 or jo@example.com" }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://llm.randazzo.example/v1/chat/completions");
    const body = JSON.parse(init.body);
    expect(body.messages).toEqual([
      { content: expect.stringContaining("health check"), role: "system" },
      { content: "Call Jo on [PHONE] or [EMAIL]", role: "user" },
    ]);
    expect(init.body).not.toContain("0412");
    expect(init.body).not.toContain("jo@example.com");
    expect(inserts()[0]).toMatchObject({ Model: "llama-3.1-8b", Provider: "openai_compatible", RedactionCount: 2 });
  });

  it("answers with the validated output and logs the model it used", async () => {
    fetchMock.mockResolvedValue(answer('{"echo":"all good"}'));
    const result = await runAi(request());
    expect(result).toMatchObject({ meta: { model: "llama-3.1-8b" }, ok: true, output: { echo: "all good" } });
    expect(inserts()[0]).toMatchObject({ ErrorCode: null, Outcome: "ok", OutputChars: '{"echo":"all good"}'.length });
  });

  it("refuses as timeout when the endpoint does not answer in AI_TIMEOUT_MS, and logs it as failed", async () => {
    process.env.AI_TIMEOUT_MS = "30";
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })))),
    );
    const result = await runAi(request());
    expect(result).toMatchObject({ ok: false, refusal: { code: "timeout" } });
    expect(inserts()[0]).toMatchObject({ ErrorCode: "timeout", Model: "llama-3.1-8b", Outcome: "failed" });
    expect(inserts()[0].LatencyMs as number).toBeGreaterThanOrEqual(20);
  });

  it("refuses as provider_error on an error status, and tells the client nothing the endpoint said", async () => {
    fetchMock.mockResolvedValue(answer("Call Jo on [PHONE]", 500));
    const result = await runAi(request({ input: "secret sentence about Building 7" }));
    expect(result).toMatchObject({ ok: false, refusal: { code: "provider_error" } });
    expect(JSON.stringify(result)).not.toContain("prompt was");
    expect(JSON.stringify(result)).not.toContain("secret sentence");
    expect(JSON.stringify(inserts())).not.toContain("prompt was");
    expect(inserts()[0]).toMatchObject({ ErrorCode: "provider_error", Outcome: "failed" });
  });

  it("refuses as provider_error when the endpoint cannot be reached", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed: ECONNREFUSED 10.0.0.4:8000"));
    const result = await runAi(request());
    expect(result).toMatchObject({ ok: false, refusal: { code: "provider_error" } });
    expect(JSON.stringify(result)).not.toContain("ECONNREFUSED");
  });

  it.each([
    ["not JSON", "I cannot do that"],
    ["JSON that is not an object", "[1,2]"],
    ["an object with a field it should not have", '{"echo":"x","run":"rm -rf /"}'],
    ["an object with no echo", '{"answer":"x"}'],
    ["an echo that is not a string", '{"echo":42}'],
    ["an empty echo", '{"echo":"  "}'],
    ["an answer far too long", `{"echo":"${"x".repeat(2_000)}"}`],
  ])("refuses as invalid_output for %s", async (_label, content) => {
    fetchMock.mockResolvedValue(answer(content));
    const result = await runAi(request());
    expect(result).toMatchObject({ ok: false, refusal: { code: "invalid_output" } });
    expect(inserts()[0]).toMatchObject({ ErrorCode: "invalid_output", Outcome: "failed" });
    expect(inserts()[0].OutputChars).toBe(content.length);
    expect(inserts()[0].OutputText).toBeNull();
  });

  it("stores no more of a runaway answer than the purpose could have asked for, and records its full length", async () => {
    process.env.AI_LOG_CONTENT = "true";
    const runaway = `{"echo":"${"x".repeat(5_000)}"}`;
    fetchMock.mockResolvedValue(answer(runaway));
    await runAi(request());
    const row = inserts()[0];
    expect(row).toMatchObject({ ErrorCode: "invalid_output", OutputChars: runaway.length });
    expect(String(row.OutputText)).toHaveLength(100 * 8);
  });

  it("keeps a refused answer's text, redacted, when AI_LOG_CONTENT is true", async () => {
    process.env.AI_LOG_CONTENT = "true";
    fetchMock.mockResolvedValue(answer("Ring jo@example.com"));
    await runAi(request());
    expect(inserts()[0]).toMatchObject({ ErrorCode: "invalid_output", OutputText: "Ring [EMAIL]" });
  });

  it.each([
    ["no base URL", { AI_BASE_URL: "" }],
    ["no model", { AI_MODEL: "" }],
    ["a base URL that is not a URL", { AI_BASE_URL: "llm dot example" }],
    ["a base URL that is not http", { AI_BASE_URL: "file:///etc/passwd" }],
  ])("refuses as provider_error with %s, before anything is sent", async (_label, env) => {
    Object.assign(process.env, env);
    const result = await runAi(request());
    expect(result).toMatchObject({ ok: false, refusal: { code: "provider_error" } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses as provider_error for a provider name it does not know", async () => {
    process.env.AI_PROVIDER = "openai";
    const result = await runAi(request());
    expect(result).toMatchObject({ ok: false, refusal: { code: "provider_error" } });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(inserts()[0]).toMatchObject({ Provider: "openai" });
  });
});

describe("a failure to write the row", () => {
  it("withholds an answer: no AI output leaves the gateway unrecorded", async () => {
    insertShouldFail = true;
    await expect(runAi(request())).rejects.toBeInstanceOf(AiAuditError);
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });

  it("does not hold up a refusal", async () => {
    insertShouldFail = true;
    recentCalls = 20;
    expect(await runAi(request())).toMatchObject({ ok: false, refusal: { code: "rate_limited" } });
  });
});

describe("a purpose of its own", () => {
  const purposeNamed = (over: Partial<Parameters<typeof definePurpose>[0]> = {}) =>
    definePurpose({
      expectsJson: true,
      id: "probe",
      maxInputChars: 100,
      maxOutputTokens: 50,
      mock: () => '{"n":1}',
      promptVersion: "probe@3",
      systemPrompt: "x",
      validate: (value) => ((value as { n?: unknown })?.n === 1 ? { ok: true, value: { n: 1 } } : { ok: false, reason: "n must be 1" }),
      ...over,
    });
  const use = (purpose: ReturnType<typeof purposeNamed>) => jest.spyOn(registry, "getPurpose").mockReturnValue(purpose);

  it("logs the purpose's own prompt version", async () => {
    use(purposeNamed());
    await runAi(request({ purpose: "probe" }));
    expect(inserts()[0]).toMatchObject({ Outcome: "ok", PromptVersion: "probe@3", Purpose: "probe" });
  });

  it("refuses schema-invalid output from the mock provider like any other", async () => {
    use(purposeNamed({ mock: () => '{"n":2}' }));
    expect(await runAi(request({ purpose: "probe" }))).toMatchObject({ ok: false, refusal: { code: "invalid_output" } });
    expect(inserts()[0]).toMatchObject({ ErrorCode: "invalid_output", Outcome: "failed", Provider: "mock" });
  });

  it("refuses as invalid_output when the validator throws", async () => {
    use(purposeNamed({ validate: () => { throw new Error("boom"); } }));
    expect(await runAi(request({ purpose: "probe" }))).toMatchObject({ ok: false, refusal: { code: "invalid_output" } });
  });

  it("refuses as provider_error when the mock responder throws, and says nothing of why", async () => {
    use(purposeNamed({ mock: () => { throw new Error("secret detail"); } }));
    const result = await runAi(request({ purpose: "probe" }));
    expect(result).toMatchObject({ ok: false, refusal: { code: "provider_error" } });
    expect(JSON.stringify(result)).not.toContain("secret detail");
  });

  it("accepts a text purpose and hands its validator the trimmed text", async () => {
    use(purposeNamed({ expectsJson: false, mock: () => "  Hello  ", validate: (value) => ({ ok: true, value: String(value) }) }));
    expect(await runAi(request({ purpose: "probe" }))).toMatchObject({ ok: true, output: "Hello" });
  });

  it("hands its validator the redacted input the provider was sent, never the original", async () => {
    const seen: unknown[] = [];
    use(purposeNamed({ validate: (value, input) => (seen.push(input), { ok: true, value }) }));
    await runAi(request({ input: "Ring jo@example.com", purpose: "probe" }));
    expect(seen).toEqual(["Ring [EMAIL]"]);
  });

  it("asks the provider for JSON only when the purpose expects it", async () => {
    process.env.AI_PROVIDER = "openai_compatible";
    process.env.AI_BASE_URL = "https://llm.example";
    process.env.AI_MODEL = "m";
    fetchMock.mockResolvedValue(answer("hi"));
    use(purposeNamed({ expectsJson: false, validate: (value) => ({ ok: true, value: String(value) }) }));
    await runAi(request({ purpose: "probe" }));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).not.toHaveProperty("response_format");

    fetchMock.mockResolvedValue(answer('{"n":1}'));
    use(purposeNamed());
    await runAi(request({ purpose: "probe" }));
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({ response_format: { type: "json_object" } });
  });
});

describe("connections", () => {
  it("gives every connection back, and holds none while a model answers", async () => {
    process.env.AI_PROVIDER = "openai_compatible";
    process.env.AI_BASE_URL = "https://llm.example";
    process.env.AI_MODEL = "m";
    let openDuringFetch = -1;
    fetchMock.mockImplementation(async () => {
      openDuringFetch = jest.mocked(createServiceRequestConnection).mock.calls.length - jest.mocked(closeConnection).mock.calls.length;
      return answer('{"echo":"ok"}');
    });
    await runAi(request());
    expect(openDuringFetch).toBe(0);
    expect(jest.mocked(closeConnection).mock.calls.length).toBe(jest.mocked(createServiceRequestConnection).mock.calls.length);
  });
});
