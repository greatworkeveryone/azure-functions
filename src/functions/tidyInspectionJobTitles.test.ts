/// <reference types="jest" />
import { HttpRequest, type InvocationContext } from "@azure/functions";
import { ACTION_ROLES } from "../action-roles";
import { AppRole } from "../auth";
import { TIDY_LIMITS } from "../ai/inspectionTitles/input";
import { tidyInspectionJobTitles } from "./tidyInspectionJobTitles";

jest.mock("@azure/functions", () => ({
  ...jest.requireActual("@azure/functions"),
  app: { http: jest.fn() },
}));
let roles: string[] = [AppRole.FACILITIES];
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

const KITCHEN = { findings: ["Light flickering", "Corridor lights out", "Switch loose"], title: "Electrical: Level 2 kitchen and corridor (3 findings)" };
const PLANT = { title: "  Ground   floor / plant room  " };
const goodBody = (over: Record<string, unknown> = {}) => ({ titles: [KITCHEN, PLANT], ...over });
const post = (value: unknown) => new HttpRequest({ body: { string: JSON.stringify(value) }, method: "POST", url: "http://localhost/api/tidyInspectionJobTitles" });
const call = (value: unknown = goodBody()) => tidyInspectionJobTitles(post(value), ctx);
const body = (r: { jsonBody?: unknown }) => r.jsonBody as Record<string, any>;
const sentToModel = () => JSON.parse(fetchMock.mock.calls[0][1].body) as { messages: { content: string; role: string }[]; response_format?: unknown; temperature: number };
const modelSays = (content: string) => new Response(JSON.stringify({ choices: [{ message: { content } }] }));
const modelTitles = (...titles: string[]) => modelSays(JSON.stringify({ titles }));
const useEndpoint = () => Object.assign(process.env, { AI_BASE_URL: "http://10.4.0.7:8000", AI_MODEL: "llama", AI_PROVIDER: "openai_compatible" });
const INVALID = { code: "invalid_output", message: "The AI's answer didn't pass Floorplan's checks, so it was not used." };

beforeEach(() => {
  jest.clearAllMocks();
  roles = [AppRole.FACILITIES];
  token = "token";
  insertFails = false;
  recentCalls = 0;
  process.env = { ...saved };
  for (const name of ["AI_ENABLED", "AI_PROVIDER", "AI_BASE_URL", "AI_MODEL", "AI_API_KEY", "AI_LOG_CONTENT", "AI_TIMEOUT_MS", "AI_RATE_PER_MINUTE"]) delete process.env[name];
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
  it("is a route of editInspections, the capability that gates raising jobs from an inspection", () => {
    expect(ACTION_ROLES.editInspections.routes).toContain("tidyInspectionJobTitles");
    expect(ACTION_ROLES.editInspections.routes).toContain("raiseJobsFromInspection");
    expect(ACTION_ROLES.editInspections.gate).toEqual([AppRole.ADMIN, AppRole.DIRECTOR, AppRole.FACILITIES, AppRole.FACILITIES_APPROVAL]);
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

  it.each([AppRole.ACCOUNTS, AppRole.ACCOUNTS_APPROVAL, AppRole.CFO, AppRole.USER])("returns 403 for %s, who cannot raise jobs from an inspection, and runs nothing", async (role) => {
    roles = [role];
    process.env.AI_ENABLED = "true";
    expect((await call()).status).toBe(403);
    expect(createRequestConnection).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([AppRole.ADMIN, AppRole.DIRECTOR, AppRole.FACILITIES, AppRole.FACILITIES_APPROVAL])("lets %s in", async (role) => {
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
  const job = (over: Record<string, unknown> = {}) => ({ findings: ["Light flickering"], title: "Electrical: Level 2 kitchen", ...over });
  const BAD: [string, unknown][] = [
    ["no titles", {}],
    ["no jobs in the list", { titles: [] }],
    ["too many jobs", { titles: Array.from({ length: TIDY_LIMITS.maxTitles + 1 }, () => job()) }],
    ["a job with no title", { titles: [job({ title: undefined })] }],
    ["a blank title", { titles: [job({ title: "  " })] }],
    ["a title that is too long", { titles: [job({ title: "t".repeat(TIDY_LIMITS.titleChars + 1) })] }],
    ["too many findings", { titles: [job({ findings: Array.from({ length: TIDY_LIMITS.maxFindings + 1 }, () => "f") })] }],
    ["a finding that is too long", { titles: [job({ findings: ["f".repeat(TIDY_LIMITS.findingChars + 1)] })] }],
    ["a finding that is not text", { titles: [job({ findings: [4] })] }],
    ["more text than one call takes", { titles: Array.from({ length: TIDY_LIMITS.maxTitles }, () => job({ findings: Array.from({ length: TIDY_LIMITS.maxFindings }, () => "f".repeat(TIDY_LIMITS.findingChars)) })) }],
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
    const response = await tidyInspectionJobTitles(new HttpRequest({ body: { string: "{not json" }, method: "POST", url: "http://localhost/api/tidyInspectionJobTitles" }), ctx);
    expect(response.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });
});

describe("with AI switched off (the default)", () => {
  it("answers 200 with a disabled refusal, sends nothing anywhere, and logs the attempt under inspection_job_titles", async () => {
    const response = await call();
    expect(response.status).toBe(200);
    expect(body(response)).toEqual({ ok: false, refusal: { code: "disabled", message: "AI is switched off, so nothing was sent to a model." } });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(inserts()).toHaveLength(1);
    expect(row()).toMatchObject({ ActorName: "Jo Bloggs", ActorUserId: 41, ErrorCode: "disabled", Outcome: "refused", Purpose: "inspection_job_titles", RecordType: "inspection_job_titles" });
  });
});

describe("with AI switched on, on the mock", () => {
  beforeEach(() => {
    process.env.AI_ENABLED = "true";
  });

  it("answers one tidied title for each job, in the order sent, and logs one ok row", async () => {
    const response = await call();
    expect(response.status).toBe(200);
    expect(response.headers).toMatchObject({ "Cache-Control": "no-store" });
    expect(body(response)).toEqual({ ok: true, titles: ["Electrical: Level 2 kitchen and corridor", "Ground floor / plant room"] });
    expect(inserts()).toHaveLength(1);
    expect(row()).toMatchObject({
      ErrorCode: null,
      Model: "mock",
      Outcome: "ok",
      PromptVersion: "inspection_job_titles@1",
      Provider: "mock",
      Purpose: "inspection_job_titles",
      RecordId: null,
      RecordType: "inspection_job_titles",
    });
  });

  it("answers as many titles as jobs, whatever the number", async () => {
    const jobs = Array.from({ length: TIDY_LIMITS.maxTitles }, (_, index) => ({ title: `Job number ${index} (${index} findings)` }));
    const response = await call({ titles: jobs });
    expect(body(response).titles).toHaveLength(TIDY_LIMITS.maxTitles);
    expect(body(response).titles[7]).toBe("Job number 7");
  });

  it("takes a title with no findings, and the largest request, as readily as a small one", async () => {
    expect(body(await call({ titles: [{ title: "Just a title" }] }))).toEqual({ ok: true, titles: ["Just a title"] });
    const biggest = Array.from({ length: TIDY_LIMITS.maxTitles }, () => ({ title: "t".repeat(TIDY_LIMITS.titleChars) }));
    expect(body(await call({ titles: biggest })).ok).toBe(true);
  });

  it("keeps no text in the log unless AI_LOG_CONTENT is true, and then only the redacted text", async () => {
    const withContact = goodBody({ titles: [{ findings: ["Ring ops@example.com on 0412 345 678"], title: "Level 2 kitchen" }] });
    await call(withContact);
    expect(row()).toMatchObject({ InputText: null, OutputText: null });
    query.mockClear();

    process.env.AI_LOG_CONTENT = "true";
    await call(withContact);
    expect(String(row().InputText)).toBe("Job 1: Level 2 kitchen\nFinding: Ring [EMAIL] on [PHONE]");
    expect(JSON.stringify(row())).not.toContain("ops@example.com");
    expect(row().RedactionCount).toBe(2);
  });

  it("gives the browser nothing but the titles: no input, no log row", async () => {
    const response = await call();
    expect(Object.keys(body(response)).sort()).toEqual(["ok", "titles"]);
    expect(JSON.stringify(response)).not.toContain("Light flickering");
  });

  it("never lets the browser choose the purpose", async () => {
    await call(goodBody({ purpose: "echo_test", titles: [PLANT] }));
    expect(row()).toMatchObject({ Purpose: "inspection_job_titles" });
    expect(inserts()).toHaveLength(1);
  });
});

describe("with a real endpoint", () => {
  beforeEach(() => {
    process.env.AI_ENABLED = "true";
    useEndpoint();
  });

  it("sends the prompt and the numbered jobs with their findings, in JSON mode, with nothing the browser did not mean it to", async () => {
    fetchMock.mockResolvedValue(modelTitles("Fix kitchen and corridor lights", "Plant room"));
    await call(goodBody({ titles: [{ ...KITCHEN, findings: ["Ring ops@example.com [urgent] about it"] }, PLANT] }));
    const sent = sentToModel();
    expect(sent.temperature).toBe(0);
    expect(sent.response_format).toEqual({ type: "json_object" });
    expect(sent.messages[0]).toMatchObject({ role: "system" });
    expect(sent.messages[0].content).toContain("under 80 characters");
    expect(sent.messages[1].content).toBe(
      ["Job 1: Electrical: Level 2 kitchen and corridor (3 findings)", "Finding: Ring [EMAIL] (urgent) about it", "Job 2: Ground floor / plant room"].join("\n"),
    );
    expect(JSON.stringify(sent)).not.toContain("ops@example.com");
  });

  it("returns the model's titles, one for each job, when they pass the checks", async () => {
    fetchMock.mockResolvedValue(modelTitles("Fix kitchen and corridor lights", "Plant room"));
    const response = await call();
    expect(body(response)).toEqual({ ok: true, titles: ["Fix kitchen and corridor lights", "Plant room"] });
    expect(row()).toMatchObject({ Model: "llama", Outcome: "ok", Provider: "openai_compatible", Purpose: "inspection_job_titles" });
  });

  it("takes the JSON in one code fence, as models often send it", async () => {
    fetchMock.mockResolvedValue(modelSays(`\`\`\`json\n${JSON.stringify({ titles: ["A", "B"] })}\n\`\`\``));
    expect(body(await call())).toEqual({ ok: true, titles: ["A", "B"] });
  });

  it.each([
    ["a title too few", JSON.stringify({ titles: ["Only one"] })],
    ["a title too many", JSON.stringify({ titles: ["One", "Two", "Three"] })],
    ["a field it should not have", JSON.stringify({ note: "hi", titles: ["One", "Two"] })],
    ["a title that is not text", JSON.stringify({ titles: ["One", 2] })],
    ["an empty title", JSON.stringify({ titles: ["One", ""] })],
    ["a title over 80 characters", JSON.stringify({ titles: ["One", "t".repeat(81)] })],
    ["markup", JSON.stringify({ titles: ["One", "<b>Two</b>"] })],
    ["a link", JSON.stringify({ titles: ["One", "See https://evil.example"] })],
    ["a line break", JSON.stringify({ titles: ["One", "Two\nthree"] })],
    ["prose round the JSON", `Here you go: ${JSON.stringify({ titles: ["One", "Two"] })}`],
    ["text that is not JSON", "One, Two"],
  ])("refuses an answer with %s as invalid_output, logs it as failed, and says nothing of what the model wrote", async (_label, text) => {
    fetchMock.mockResolvedValue(modelSays(text));
    const response = await call();
    expect(response.status).toBe(200);
    expect(body(response)).toEqual({ ok: false, refusal: INVALID });
    expect(JSON.stringify(response)).not.toContain("evil.example");
    expect(row()).toMatchObject({ ErrorCode: "invalid_output", Outcome: "failed", Purpose: "inspection_job_titles" });
  });

  it("holds an answer to the jobs of this request: two titles are right for two jobs and wrong for one", async () => {
    fetchMock.mockImplementation(async () => modelTitles("One", "Two"));
    expect(body(await call(goodBody())).ok).toBe(true);
    expect(body(await call({ titles: [PLANT] }))).toMatchObject({ ok: false, refusal: { code: "invalid_output" } });
  });

  it("reports a failing endpoint as ok: false with a plain sentence, and none of what the endpoint said", async () => {
    fetchMock.mockResolvedValue(new Response("prompt: Light flickering; key=s3cret", { status: 500 }));
    const response = await call();
    expect(response.status).toBe(200);
    expect(body(response)).toMatchObject({ ok: false, refusal: { code: "provider_error" } });
    for (const leak of ["s3cret", "prompt:", "10.4.0.7", "Light flickering"]) expect(JSON.stringify(response)).not.toContain(leak);
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
    expect(row()).toMatchObject({ ErrorCode: "timeout", Outcome: "failed" });
  });

  it("gives the request connection back before the model is called", async () => {
    let openDuringCall = -1;
    fetchMock.mockImplementation(async () => {
      openDuringCall = jest.mocked(createRequestConnection).mock.calls.length + jest.mocked(createServiceRequestConnection).mock.calls.length - jest.mocked(closeConnection).mock.calls.length;
      return modelTitles("One", "Two");
    });
    await call();
    expect(openDuringCall).toBe(0);
  });
});

describe("limits and failures", () => {
  beforeEach(() => {
    process.env.AI_ENABLED = "true";
  });

  it("reports a rate limit as ok: false, not as an HTTP error, and sends nothing", async () => {
    useEndpoint();
    recentCalls = 20;
    const response = await call();
    expect(response.status).toBe(200);
    expect(body(response)).toMatchObject({ ok: false, refusal: { code: "rate_limited" } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("withholds the titles and answers a plain 500 when the call could not be recorded, and says nothing of why", async () => {
    insertFails = true;
    const response = await call();
    expect(response.status).toBe(500);
    expect(JSON.stringify(response)).not.toContain("AiCallLog");
    expect(body(response)).toEqual({ error: "The titles could not be tidied" });
    expect(ctx.error).toHaveBeenCalled();
  });

  it("answers a plain 500 when it cannot count recent calls, and makes no call", async () => {
    useEndpoint();
    query.mockRejectedValue(new Error("connection lost"));
    expect((await call()).status).toBe(500);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
