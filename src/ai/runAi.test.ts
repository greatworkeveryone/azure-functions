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
  process.env.AI_PURPOSES_ENABLED = "echo_test";
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
    // The person's recent calls are counted first, even switched off, so a loop of refused calls can be stopped.
    expect(counts()).toHaveLength(1);
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

  it("never stores prompt or answer text, whatever the environment says (review M2)", async () => {
    for (const value of [undefined, "true", "TRUE", "1"]) {
      query.mockClear();
      if (value === undefined) delete process.env.AI_LOG_CONTENT;
      else process.env.AI_LOG_CONTENT = value;
      await runAi(request({ input: "Contact jo@example.com about the lift in Building 7" }));
      const insert = query.mock.calls.find((call) => String(call[1]).includes("INSERT INTO dbo.AiCallLog"));
      const names = (insert?.[2] ?? []).map((param) => param.name);
      expect(names).not.toContain("InputText");
      expect(names).not.toContain("OutputText");
      expect(String(insert?.[1])).not.toMatch(/InputText|OutputText/);
      const row = JSON.stringify(inserts()[0]);
      for (const text of ["jo@example.com", "[EMAIL]", "Building 7", "lift"]) expect(row).not.toContain(text);
    }
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
    expect(counts()).toHaveLength(1);
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
    expect(counts()).toHaveLength(1);
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
    recentCalls = 20;
    delete process.env.AI_ENABLED;
    expect(await runAi(request({ input: "x".repeat(999), purpose: "nope" }))).toMatchObject({ refusal: { code: "disabled" } });
    process.env.AI_ENABLED = "true";
    expect(await runAi(request({ input: "x".repeat(999), purpose: "nope" }))).toMatchObject({ refusal: { code: "purpose_not_allowed" } });
    expect(await runAi(request({ input: "x".repeat(999) }))).toMatchObject({ refusal: { code: "input_too_large" } });
    expect(await runAi(request())).toMatchObject({ refusal: { code: "rate_limited" } });
  });
});

describe("AI_PURPOSES_ENABLED: each purpose is switched on separately (review L3)", () => {
  it("refuses every purpose when none is switched on, even with AI on and the purpose registered", async () => {
    delete process.env.AI_PURPOSES_ENABLED;
    const result = await runAi(request());
    expect(result).toMatchObject({ ok: false, refusal: { code: "purpose_not_allowed" } });
    expect(inserts()[0]).toMatchObject({ ErrorCode: "purpose_not_allowed", Outcome: "refused", Purpose: "echo_test", PromptVersion: "echo_test@1" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["", " ", "other_purpose", "ECHO_TEST", "echo_test_2", "echo", "*"])("refuses echo_test when the list is %j", async (value) => {
    process.env.AI_PURPOSES_ENABLED = value;
    expect(await runAi(request())).toMatchObject({ ok: false, refusal: { code: "purpose_not_allowed" } });
  });

  it("allows a purpose that is listed, alone or among others", async () => {
    for (const value of ["echo_test", "echo_test,quote_extraction", " other , echo_test "]) {
      process.env.AI_PURPOSES_ENABLED = value;
      expect(await runAi(request())).toMatchObject({ ok: true });
    }
  });

  it("is checked after AI_ENABLED: switched off says disabled, whatever the list holds", async () => {
    delete process.env.AI_ENABLED;
    delete process.env.AI_PURPOSES_ENABLED;
    expect(await runAi(request())).toMatchObject({ ok: false, refusal: { code: "disabled" } });
  });

  it("does not make an unknown purpose real by listing it", async () => {
    process.env.AI_PURPOSES_ENABLED = "write_my_emails";
    expect(await runAi(request({ purpose: "write_my_emails" }))).toMatchObject({ ok: false, refusal: { code: "purpose_not_allowed" } });
  });

  it("is checked before the size cap, so an unlisted purpose says so, not that its input was long", async () => {
    delete process.env.AI_PURPOSES_ENABLED;
    expect(await runAi(request({ input: "x".repeat(999) }))).toMatchObject({ refusal: { code: "purpose_not_allowed" } });
  });
});

describe("the per-minute limit counts every call, and stops writing rows when it is far exceeded", () => {
  it("counts rows of every outcome: refused calls count too", async () => {
    await runAi(request());
    expect(String(counts()[0][1])).not.toMatch(/Outcome/);
  });

  it("refuses at the limit and up to twice it, each with a row", async () => {
    for (const recent of [20, 21, 39, 40]) {
      query.mockClear();
      recentCalls = recent;
      const result = await runAi(request());
      expect({ recent, result }).toMatchObject({ recent, result: { ok: false, refusal: { code: "rate_limited" }, meta: { throttled: false } } });
      expect({ recent, rows: inserts().length }).toEqual({ recent, rows: 1 });
      expect(inserts()[0]).toMatchObject({ ErrorCode: "rate_limited", Outcome: "refused" });
    }
  });

  it("above twice the limit turns the call away without writing a row, or reaching a model", async () => {
    process.env.AI_PROVIDER = "openai_compatible";
    process.env.AI_BASE_URL = "https://llm.example";
    process.env.AI_MODEL = "m";
    for (const recent of [41, 500]) {
      query.mockClear();
      recentCalls = recent;
      const result = await runAi(request());
      expect(result).toMatchObject({ meta: { callId: null, throttled: true }, ok: false, refusal: { code: "rate_limited" } });
      expect(inserts()).toHaveLength(0);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("measures twice the limit from AI_RATE_PER_MINUTE", async () => {
    process.env.AI_RATE_PER_MINUTE = "5";
    recentCalls = 10;
    expect(await runAi(request())).toMatchObject({ meta: { throttled: false }, refusal: { code: "rate_limited" } });
    recentCalls = 11;
    expect(await runAi(request())).toMatchObject({ meta: { throttled: true }, refusal: { code: "rate_limited" } });
  });

  it("applies when AI is switched off: a loop of switched-off calls stops writing rows", async () => {
    delete process.env.AI_ENABLED;
    recentCalls = 5;
    expect(await runAi(request())).toMatchObject({ meta: { throttled: false }, refusal: { code: "disabled" } });
    expect(inserts()).toHaveLength(1);
    query.mockClear();
    recentCalls = 41;
    expect(await runAi(request())).toMatchObject({ meta: { callId: null, throttled: true }, refusal: { code: "rate_limited" } });
    expect(inserts()).toHaveLength(0);
  });

  it("applies to every kind of refusal before it: a purpose that isn't allowed, and an input that is too long", async () => {
    recentCalls = 41;
    expect(await runAi(request({ purpose: "nope" }))).toMatchObject({ meta: { throttled: true } });
    expect(await runAi(request({ input: "x".repeat(999) }))).toMatchObject({ meta: { throttled: true } });
    expect(inserts()).toHaveLength(0);
  });

  it("says so in a plain sentence", async () => {
    recentCalls = 41;
    const result = await runAi(request());
    expect(result.ok === false && result.refusal.message).toBe("That is too many AI requests in a minute. Wait a moment and try again.");
  });
});

describe("calls in flight", () => {
  beforeEach(() => {
    process.env.AI_PROVIDER = "openai_compatible";
    process.env.AI_BASE_URL = "https://llm.example";
    process.env.AI_MODEL = "m";
  });

  /** A provider that answers only when told to: each call to it waits on its own gate. */
  function heldProvider() {
    const gates: Array<() => void> = [];
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          gates.push(() => resolve(answer('{"echo":"ok"}')));
        }),
    );
    const reached = async (count: number) => {
      for (let turn = 0; turn < 200 && gates.length < count; turn++) await new Promise((resolve) => setImmediate(resolve));
      expect(gates).toHaveLength(count);
    };
    return { open: () => gates.splice(0).forEach((gate) => gate()), reached };
  }

  it("lets one person have two in flight, turns the third away without touching the database, and frees the slots as they finish", async () => {
    const provider = heldProvider();
    const first = runAi(request());
    const second = runAi(request());
    await provider.reached(2);
    query.mockClear();

    const third = await runAi(request());

    expect(third).toMatchObject({ meta: { callId: null, throttled: true }, ok: false, refusal: { code: "rate_limited" } });
    expect(query).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    provider.open();
    expect(await first).toMatchObject({ ok: true });
    expect(await second).toMatchObject({ ok: true });
    fetchMock.mockImplementation(async () => answer('{"echo":"ok"}'));
    expect(await runAi(request())).toMatchObject({ ok: true });
  });

  it("holds the slot until the row is written, not just until the model answers", async () => {
    const provider = heldProvider();
    const first = runAi(request());
    await provider.reached(1);
    const second = runAi(request());
    await provider.reached(2);
    expect(await runAi(request())).toMatchObject({ meta: { throttled: true } });
    provider.open();
    await Promise.all([first, second]);
    expect(inserts()).toHaveLength(2);
  });

  it("does not hold up someone else", async () => {
    const provider = heldProvider();
    const first = runAi(request());
    const second = runAi(request());
    await provider.reached(2);
    const ada: AiActor = { email: "ada@randazzo.example", kind: "user", name: "Ada Lovelace", role: "director", userId: 7 };
    const adas = runAi(request({ actor: ada }));
    await provider.reached(3);
    provider.open();
    expect(await adas).toMatchObject({ ok: true });
    await Promise.all([first, second]);
  });

  it("gives the slot back when the model fails, when the count fails and when the answer can't be recorded", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    for (let attempt = 0; attempt < 4; attempt++) expect(await runAi(request())).toMatchObject({ refusal: { code: "provider_error" } });

    countShouldFail = true;
    for (let attempt = 0; attempt < 4; attempt++) await expect(runAi(request())).rejects.toThrow("connection lost");
    countShouldFail = false;

    fetchMock.mockImplementation(async () => answer('{"echo":"ok"}'));
    insertShouldFail = true;
    for (let attempt = 0; attempt < 4; attempt++) await expect(runAi(request())).rejects.toBeInstanceOf(AiAuditError);
    insertShouldFail = false;

    expect(await runAi(request())).toMatchObject({ ok: true });
  });

  it("turns a flood of parallel calls away: of twenty at once, two reach the model and the rest get no row", async () => {
    const provider = heldProvider();
    const all = Array.from({ length: 20 }, () => runAi(request()));
    await provider.reached(2);
    for (let turn = 0; turn < 20; turn++) await new Promise((resolve) => setImmediate(resolve));
    provider.open();
    const results = await Promise.all(all);
    expect(results.filter((result) => result.ok)).toHaveLength(2);
    expect(results.filter((result) => !result.ok && result.meta.throttled)).toHaveLength(18);
    expect(inserts()).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
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
    expect(Object.keys(inserts()[0])).not.toContain("OutputText");
  });

  it("records how long a refused answer was, and keeps none of its text", async () => {
    process.env.AI_LOG_CONTENT = "true";
    const runaway = `{"echo":"${"x".repeat(5_000)}"}`;
    fetchMock.mockResolvedValue(answer(runaway));
    await runAi(request());
    const row = inserts()[0];
    expect(row).toMatchObject({ ErrorCode: "invalid_output", OutputChars: runaway.length });
    expect(Object.keys(row)).not.toContain("OutputText");
    expect(Object.keys(row)).not.toContain("InputText");
    expect(JSON.stringify(row)).not.toContain("xxxx");
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

  it.each([
    ["plain http to a public host", "http://llm.example", /AI_BASE_URL must use https\. Plain http is allowed only to localhost or a private address/],
    ["plain http to a host name that only looks internal", "http://vllm.internal:8000", /AI_BASE_URL must use https/],
    ["the cloud metadata address", "https://169.254.169.254", /link-local/],
    ["a key inside the address", "https://user:s3cret@llm.example", /user name or password/],
  ])("refuses %s before anything is sent, and the log line says why without repeating the address", async (_label, url, line) => {
    Object.assign(process.env, { AI_BASE_URL: url, AI_MODEL: "m", AI_PROVIDER: "openai_compatible" });
    const result = await runAi(request());
    expect(result).toMatchObject({ ok: false, refusal: { code: "provider_error" } });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(inserts()[0]).toMatchObject({ ErrorCode: "provider_error", Outcome: "failed", Provider: "openai_compatible" });
    const logged = jest.mocked(console.error).mock.calls.map((args) => args.join(" ")).join("\n");
    expect(logged).toMatch(/^\[ai\] provider call failed: AI_BASE_URL /);
    expect(logged).toMatch(line);
    expect(logged).not.toMatch(/s3cret|llm\.example|vllm\.internal|169\.254\.169\.254/);
  });

  it("calls an endpoint on a private address over plain http", async () => {
    Object.assign(process.env, { AI_BASE_URL: "http://10.4.0.7:8000", AI_MODEL: "m", AI_PROVIDER: "openai_compatible" });
    fetchMock.mockResolvedValue(answer('{"echo":"x"}'));
    expect(await runAi(request())).toMatchObject({ ok: true });
    expect(fetchMock.mock.calls[0][0]).toBe("http://10.4.0.7:8000/v1/chat/completions");
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
  const use = (purpose: ReturnType<typeof purposeNamed>) => {
    process.env.AI_PURPOSES_ENABLED = purpose.id;
    return jest.spyOn(registry, "getPurpose").mockReturnValue(purpose);
  };

  it("needs its own id in AI_PURPOSES_ENABLED: being registered is not enough", async () => {
    jest.spyOn(registry, "getPurpose").mockReturnValue(purposeNamed());
    expect(await runAi(request({ purpose: "probe" }))).toMatchObject({ ok: false, refusal: { code: "purpose_not_allowed" } });
    process.env.AI_PURPOSES_ENABLED = "echo_test";
    expect(await runAi(request({ purpose: "probe" }))).toMatchObject({ ok: false, refusal: { code: "purpose_not_allowed" } });
    process.env.AI_PURPOSES_ENABLED = "echo_test,probe";
    expect(await runAi(request({ purpose: "probe" }))).toMatchObject({ ok: true });
  });

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
