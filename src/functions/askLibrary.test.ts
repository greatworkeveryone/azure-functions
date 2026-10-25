/// <reference types="jest" />
import { HttpRequest, type InvocationContext } from "@azure/functions";
import { ACTION_ROLES, exportActionRoles } from "../action-roles";
import { AppRole } from "../auth";
import { ASK_LIMITS } from "../ai/libraryAsk/input";
import { askLibrary } from "./askLibrary";

jest.mock("@azure/functions", () => ({
  ...jest.requireActual("@azure/functions"),
  app: { http: jest.fn() },
}));
let roles: string[] = [AppRole.USER];
let token: string | null = "token";
jest.mock("../auth", () => ({
  ...jest.requireActual("../auth"),
  extractToken: () => token,
  requireRole: async (_r: unknown, allowed: string[]) =>
    jest.requireActual("../auth").rolesPassGate(roles, allowed) ? null : { status: 403 },
  userInfoFromToken: () => ({ email: "jo@randazzo.example", name: "Jo Bloggs" }),
}));
jest.mock("../db", () => ({
  closeConnection: jest.fn(),
  createRequestConnection: jest.fn(),
  createServiceRequestConnection: jest.fn(),
  executeQuery: jest.fn(),
}));
jest.mock("../ledger/actor", () => ({ resolveLedgerActor: jest.fn() }));
jest.mock("../sentry", () => ({ Sentry: { captureException: jest.fn(), captureMessage: jest.fn() } }));

import { closeConnection, createRequestConnection, createServiceRequestConnection, executeQuery } from "../db";
import { resolveLedgerActor } from "../ledger/actor";

const query = jest.mocked(executeQuery);
const fetchMock = jest.fn();
const ctx = { error: jest.fn() } as unknown as InvocationContext;
const saved = { ...process.env };
const inserts = () => query.mock.calls.filter((c) => String(c[1]).includes("INSERT INTO dbo.AiCallLog"));
const row = () => Object.fromEntries((inserts()[0][2] ?? []).map((p) => [p.name, p.value]));
let insertFails = false;
let recentCalls = 0;

const KEYS = { heading: "What you do in it", id: "key-register:12", text: "Mostly two things: check out and check in.\nChecking in is the same in reverse, with a photo.", title: "Key Register" };
const OFFLINE = { heading: "Offline", id: "inspections:3", text: "Inspections work with no signal and sync when you are back in range.", title: "Inspections" };
const goodBody = (over: Record<string, unknown> = {}) => ({ passages: [KEYS, OFFLINE], question: "How do I check a key in?", ...over });
const post = (value: unknown) => new HttpRequest({ body: { string: JSON.stringify(value) }, method: "POST", url: "http://localhost/api/askLibrary" });
const call = (value: unknown = goodBody()) => askLibrary(post(value), ctx);
const body = (r: { jsonBody?: unknown }) => r.jsonBody as Record<string, any>;
const sentToModel = () => JSON.parse(fetchMock.mock.calls[0][1].body) as { messages: { content: string; role: string }[]; temperature: number };
const modelSays = (content: string) => new Response(JSON.stringify({ choices: [{ message: { content } }] }));
const useEndpoint = () => Object.assign(process.env, { AI_BASE_URL: "http://10.4.0.7:8000", AI_MODEL: "llama", AI_PROVIDER: "openai_compatible" });
// AI is on and this purpose is switched on: each purpose has to be listed in AI_PURPOSES_ENABLED (review L3).
const switchOn = (purposes = "library_answer") => Object.assign(process.env, { AI_ENABLED: "true", AI_PURPOSES_ENABLED: purposes });
const until = async (done: () => boolean) => {
  for (let turn = 0; turn < 500 && !done(); turn += 1) await new Promise((resolve) => setImmediate(resolve));
  expect(done()).toBe(true);
};

beforeEach(() => {
  jest.clearAllMocks();
  roles = [AppRole.USER];
  token = "token";
  insertFails = false;
  recentCalls = 0;
  process.env = { ...saved };
  for (const name of ["AI_ENABLED", "AI_PROVIDER", "AI_BASE_URL", "AI_MODEL", "AI_API_KEY", "AI_PURPOSES_ENABLED", "AI_TIMEOUT_MS", "AI_RATE_PER_MINUTE"]) delete process.env[name];
  jest.mocked(createRequestConnection).mockResolvedValue({} as never);
  jest.mocked(createServiceRequestConnection).mockResolvedValue({} as never);
  jest.mocked(resolveLedgerActor).mockResolvedValue({ kind: "user", name: "Jo Bloggs", role: "facilities", userId: 41 });
  query.mockImplementation(async (_c, sql) => {
    if (sql.includes("INSERT INTO dbo.AiCallLog")) {
      if (insertFails) throw new Error("Invalid object name 'dbo.AiCallLog'.");
      return [{ Id: "77" }];
    }
    return [{ Calls: recentCalls }];
  });
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
  jest.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => jest.restoreAllMocks());
afterAll(() => {
  process.env = saved;
});

describe("access", () => {
  it("is open to anyone who can use the Library: it is a route of viewDocumentation", () => {
    expect(ACTION_ROLES.viewDocumentation.routes).toContain("askLibrary");
    expect(ACTION_ROLES.viewDocumentation.gate).toEqual([AppRole.USER]);
    expect(exportActionRoles().viewDocumentation).toEqual(expect.arrayContaining(Object.values(AppRole)));
  });

  it("returns 401 with no token, before anything else", async () => {
    token = null;
    expect((await call()).status).toBe(401);
    expect(createRequestConnection).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it("returns 403 for someone with no role, and runs nothing", async () => {
    roles = [];
    process.env.AI_ENABLED = "true";
    expect((await call()).status).toBe(403);
    expect(query).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(Object.values(AppRole))("lets %s in", async (role) => {
    roles = [role];
    expect((await call()).status).toBe(200);
  });

  it("returns 401 when the token's person cannot be identified, and writes no row", async () => {
    process.env.AI_ENABLED = "true";
    jest.mocked(resolveLedgerActor).mockResolvedValueOnce(null);
    expect((await call()).status).toBe(401);
    expect(inserts()).toHaveLength(0);
  });
});

describe("a request that is not valid", () => {
  const BAD: [string, unknown][] = [
    ["no question", goodBody({ question: undefined })],
    ["a question that is too short", goodBody({ question: "hi" })],
    ["a question that is too long", goodBody({ question: "q".repeat(ASK_LIMITS.questionMaxChars + 1) })],
    ["no passages", goodBody({ passages: [] })],
    ["too many passages", goodBody({ passages: Array.from({ length: ASK_LIMITS.maxPassages + 1 }, () => KEYS) })],
    ["a passage with no text", goodBody({ passages: [{ ...KEYS, text: "" }] })],
    ["a passage with too much text", goodBody({ passages: [{ ...KEYS, text: "t".repeat(ASK_LIMITS.textChars + 1) }] })],
    ["a passage with no title", goodBody({ passages: [{ ...KEYS, title: undefined }] })],
    ["a body that is not an object", "just text"],
  ];

  it.each(BAD)("answers 400 with a sentence for %s, and touches no connection, no model and no log", async (_label, value) => {
    process.env.AI_ENABLED = "true";
    const response = await call(value);
    expect(response.status).toBe(400);
    expect(typeof body(response).error).toBe("string");
    expect(createRequestConnection).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it("answers 400 for a body that is not JSON", async () => {
    const response = await askLibrary(new HttpRequest({ body: { string: "{not json" }, method: "POST", url: "http://localhost/api/askLibrary" }), ctx);
    expect(response.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });
});

describe("with AI switched off (the default)", () => {
  it("answers 200 with a disabled refusal, sends nothing anywhere, and logs the attempt under library_answer", async () => {
    const response = await call();
    expect(response.status).toBe(200);
    expect(body(response)).toEqual({ ok: false, refusal: { code: "disabled", message: "AI is switched off, so nothing was sent to a model." } });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(inserts()).toHaveLength(1);
    expect(row()).toMatchObject({ ActorName: "Jo Bloggs", ActorUserId: 41, ErrorCode: "disabled", Outcome: "refused", Purpose: "library_answer", RecordType: "library_question" });
  });
});

describe("with AI switched on, on the mock", () => {
  beforeEach(() => {
    switchOn();
  });

  it("answers from the passages, citing the one it used, and logs one ok row under library_answer", async () => {
    const response = await call();
    expect(response.status).toBe(200);
    expect(response.headers).toMatchObject({ "Cache-Control": "no-store" });
    expect(body(response)).toEqual({
      answer: { covered: true, sentences: [{ cites: [1], text: "Mostly two things: check out and check in." }] },
      ok: true,
    });
    expect(inserts()).toHaveLength(1);
    expect(row()).toMatchObject({
      ErrorCode: null,
      Model: "mock",
      Outcome: "ok",
      PromptVersion: "library_answer@1",
      Provider: "mock",
      Purpose: "library_answer",
      RecordId: null,
      RecordType: "library_question",
    });
  });

  it("says the library does not cover it when the passages do not answer the question", async () => {
    const response = await call(goodBody({ question: "Who arranges after hours leak repairs for a tenant?" }));
    expect(body(response)).toEqual({ answer: { covered: false }, ok: true });
    expect(row()).toMatchObject({ Outcome: "ok", Purpose: "library_answer" });
  });

  it("sends the person's own passages in the order given, and takes a small request as readily as the largest", async () => {
    const biggest = { heading: "h".repeat(ASK_LIMITS.headingChars), text: "t".repeat(ASK_LIMITS.textChars), title: "T".repeat(ASK_LIMITS.titleChars) };
    const response = await call({ passages: Array.from({ length: ASK_LIMITS.maxPassages }, () => biggest), question: "q".repeat(ASK_LIMITS.questionMaxChars) });
    expect(body(response).ok).toBe(true);
  });

  it("never keeps the question or the passages in the log, whatever AI_LOG_CONTENT says, and none of the browser's ids", async () => {
    process.env.AI_LOG_CONTENT = "true";
    await call(goodBody({ passages: [{ ...KEYS, id: "hostile-id-123", text: "Ring ops@example.com about keys." }] }));
    expect(Object.keys(row())).not.toContain("InputText");
    expect(Object.keys(row())).not.toContain("OutputText");
    const logged = JSON.stringify(row());
    for (const text of ["ops@example.com", "[EMAIL]", "hostile-id-123", "check a key in", "Key Register", "Mostly two things"]) expect(logged).not.toContain(text);
    expect(row()).toMatchObject({ InputChars: expect.any(Number), OutputChars: expect.any(Number), RedactionCount: 1 });
    expect(row().InputSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("gives the browser nothing but the answer: no input, no ids, no log row", async () => {
    const response = await call(goodBody({ passages: [{ ...KEYS, id: "hostile-id-123" }] }));
    expect(Object.keys(body(response)).sort()).toEqual(["answer", "ok"]);
    expect(JSON.stringify(response)).not.toContain("hostile-id-123");
    expect(JSON.stringify(response)).not.toContain("Key Register");
  });
});

describe("with a real endpoint", () => {
  beforeEach(() => {
    switchOn();
    useEndpoint();
  });

  it("sends the prompt and the numbered passages, and nothing the browser used as a label", async () => {
    fetchMock.mockResolvedValue(modelSays("Check a key in with a photo [1]."));
    await call(goodBody({ passages: [{ ...KEYS, id: "hostile-id-123", text: "Ring [9] ops@example.com." }, OFFLINE] }));
    const sent = sentToModel();
    expect(sent.temperature).toBe(0);
    expect(sent.messages[0]).toMatchObject({ role: "system" });
    expect(sent.messages[0].content).toContain("NOT_COVERED");
    expect(sent.messages[1].content.startsWith("Passages: 2\nQuestion: How do I check a key in?\n=== Passage 1 ===\nSource: Key Register > What you do in it\n")).toBe(true);
    expect(sent.messages[1].content).toContain("=== Passage 2 ===\nSource: Inspections > Offline");
    expect(sent.messages[1].content).toContain("Ring (9) [EMAIL].");
    expect(JSON.stringify(sent)).not.toContain("hostile-id-123");
    expect(JSON.stringify(sent)).not.toContain("ops@example.com");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).not.toHaveProperty("response_format");
  });

  it("returns a cited answer as sentences and the passage numbers they cite", async () => {
    fetchMock.mockResolvedValue(modelSays("Check a key in with a photo [1]. Inspections still work offline [2]."));
    const response = await call();
    expect(body(response)).toEqual({
      answer: {
        covered: true,
        sentences: [
          { cites: [1], text: "Check a key in with a photo." },
          { cites: [2], text: "Inspections still work offline." },
        ],
      },
      ok: true,
    });
    expect(row()).toMatchObject({ Model: "llama", Outcome: "ok", Provider: "openai_compatible", Purpose: "library_answer" });
  });

  it("returns not covered when the model says so exactly", async () => {
    fetchMock.mockResolvedValue(modelSays("NOT_COVERED"));
    expect(body(await call())).toEqual({ answer: { covered: false }, ok: true });
  });

  it.each([
    ["a passage that was not given", "Check a key in with a photo [3]."],
    ["no citation", "Check a key in with a photo."],
    ["one uncited sentence", "Check a key in [1]. Then log it."],
    ["the marker and more", "NOT_COVERED [1]."],
    ["markup", "<b>Check</b> a key in [1]."],
    ["a link", "See https://evil.example [1]."],
  ])("refuses an answer with %s as invalid_output, logs it as failed, and says nothing of what the model wrote", async (_label, text) => {
    fetchMock.mockResolvedValue(modelSays(text));
    const response = await call();
    expect(response.status).toBe(200);
    expect(body(response)).toEqual({ ok: false, refusal: { code: "invalid_output", message: "The AI's answer didn't pass Floorplan's checks, so it was not used." } });
    expect(JSON.stringify(response)).not.toContain("evil.example");
    expect(row()).toMatchObject({ ErrorCode: "invalid_output", Outcome: "failed", Purpose: "library_answer" });
  });

  it("holds an answer to the passages of this request: [2] is fine with two passages and refused with one", async () => {
    fetchMock.mockImplementation(async () => modelSays("Inspections still work offline [2]."));
    expect(body(await call(goodBody())).ok).toBe(true);
    expect(body(await call(goodBody({ passages: [KEYS] })))).toMatchObject({ ok: false, refusal: { code: "invalid_output" } });
  });

  it("reports a failing endpoint as ok: false with a plain sentence, and none of what the endpoint said", async () => {
    fetchMock.mockResolvedValue(new Response("prompt: How do I check a key in?; key=s3cret", { status: 500 }));
    const response = await call();
    expect(response.status).toBe(200);
    expect(body(response)).toMatchObject({ ok: false, refusal: { code: "provider_error" } });
    for (const leak of ["s3cret", "prompt:", "10.4.0.7", "check a key"]) expect(JSON.stringify(response)).not.toContain(leak);
    expect(row()).toMatchObject({ ErrorCode: "provider_error", Outcome: "failed" });
  });

  it("reports an endpoint that cannot be reached as a provider error", async () => {
    fetchMock.mockRejectedValue(new Error("connect ECONNREFUSED 10.4.0.7:8000"));
    const response = await call();
    expect(body(response)).toMatchObject({ ok: false, refusal: { code: "provider_error" } });
    expect(JSON.stringify(response)).not.toContain("ECONNREFUSED");
  });

  it("reports a slow endpoint as a timeout", async () => {
    process.env.AI_TIMEOUT_MS = "20";
    fetchMock.mockImplementation((_url: string, init: { signal: AbortSignal }) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted")))));
    expect(body(await call())).toMatchObject({ ok: false, refusal: { code: "timeout" } });
  });

  it("gives the request connection back before the model is called", async () => {
    let openDuringCall = -1;
    fetchMock.mockImplementation(async () => {
      openDuringCall = jest.mocked(createRequestConnection).mock.calls.length + jest.mocked(createServiceRequestConnection).mock.calls.length - jest.mocked(closeConnection).mock.calls.length;
      return modelSays("Check a key in with a photo [1].");
    });
    await call();
    expect(openDuringCall).toBe(0);
  });
});

describe("AI_PURPOSES_ENABLED: library_answer is switched on on its own", () => {
  it.each([
    ["no purpose listed", ""],
    ["only other purposes listed", "quote_extraction,invoice_extraction,echo_test"],
  ])("refuses with %s, sends nothing, and logs it as refused under library_answer", async (_label, purposes) => {
    useEndpoint();
    switchOn(purposes);
    const response = await call();
    expect(response.status).toBe(200);
    expect(body(response)).toEqual({ ok: false, refusal: { code: "purpose_not_allowed", message: "Floorplan isn't set up to use AI for that." } });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(row()).toMatchObject({ ErrorCode: "purpose_not_allowed", Outcome: "refused", Purpose: "library_answer" });
  });

  it("answers once it is listed, alone or among others", async () => {
    for (const purposes of ["library_answer", "echo_test, library_answer"]) {
      switchOn(purposes);
      expect(body(await call())).toMatchObject({ ok: true });
    }
  });

  it("says AI is off before it says the purpose is not listed", async () => {
    process.env.AI_PURPOSES_ENABLED = "";
    expect(body(await call())).toMatchObject({ ok: false, refusal: { code: "disabled" } });
  });
});

describe("limits and failures", () => {
  beforeEach(() => {
    switchOn();
  });

  it("reports a rate limit as ok: false, not as an HTTP error, and sends nothing", async () => {
    useEndpoint();
    recentCalls = 20;
    const response = await call();
    expect(response.status).toBe(200);
    expect(body(response)).toMatchObject({ ok: false, refusal: { code: "rate_limited" } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("logs the refusal at the limit, under library_answer", async () => {
    recentCalls = 20;
    await call();
    expect(inserts()).toHaveLength(1);
    expect(row()).toMatchObject({ ErrorCode: "rate_limited", Outcome: "refused", Purpose: "library_answer" });
  });

  it("still answers 200 with a logged refusal at exactly twice the limit", async () => {
    recentCalls = 40;
    const response = await call();
    expect(response.status).toBe(200);
    expect(body(response)).toMatchObject({ ok: false, refusal: { code: "rate_limited" } });
    expect(inserts()).toHaveLength(1);
  });

  it("answers 429 with Retry-After above twice the limit, with only the code and a sentence, and writes no row and sends nothing", async () => {
    useEndpoint();
    recentCalls = 41;
    const response = await call();
    expect(response.status).toBe(429);
    expect(response.headers).toMatchObject({ "Cache-Control": "no-store", "Retry-After": "60" });
    expect(body(response)).toEqual({ code: "rate_limited", error: "That is too many AI requests in a minute. Wait a moment and try again." });
    expect(inserts()).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads twice the limit from AI_RATE_PER_MINUTE", async () => {
    process.env.AI_RATE_PER_MINUTE = "5";
    recentCalls = 10;
    expect((await call()).status).toBe(200);
    recentCalls = 11;
    expect((await call()).status).toBe(429);
  });

  it("answers 429 to a third call while two of this person's calls are still waiting on the model, and writes no row for it", async () => {
    useEndpoint();
    const answers: Array<() => void> = [];
    fetchMock.mockImplementation(() => new Promise<Response>((resolve) => answers.push(() => resolve(modelSays("Check a key in with a photo [1]")))));
    const first = call();
    const second = call();
    try {
      await until(() => fetchMock.mock.calls.length === 2);

      const third = await call();
      expect(third.status).toBe(429);
      expect(third.headers).toMatchObject({ "Retry-After": "60" });
      expect(body(third)).toMatchObject({ code: "rate_limited" });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(inserts()).toHaveLength(0);
    } finally {
      // Always let the two go, so a failure above cannot leave their slots held for the tests after it.
      for (const answer of answers) answer();
    }
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
    expect(inserts()).toHaveLength(2);

    fetchMock.mockImplementation(async () => modelSays("Check a key in with a photo [1]"));
    expect(body(await call())).toMatchObject({ ok: true });
  });

  it("answers a plain 500 when the answer could not be recorded, and says nothing of why", async () => {
    insertFails = true;
    const response = await call();
    expect(response.status).toBe(500);
    expect(JSON.stringify(response)).not.toContain("AiCallLog");
    expect(ctx.error).toHaveBeenCalled();
  });

  it("answers a plain 500 when it cannot count recent calls, and makes no call", async () => {
    useEndpoint();
    query.mockRejectedValue(new Error("connection lost"));
    expect((await call()).status).toBe(500);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
