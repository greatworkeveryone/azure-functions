/// <reference types="jest" />
import { HttpRequest, InvocationContext } from "@azure/functions";

// SEC-07 / decisions 2–3: a director's emailed reply is filed on the job and
// answered with the job's link — never applied as a decision unless
// EMAIL_REPLY_DECISIONS_ENABLED is exactly "true". Approval emails go to the
// active directors in AppUsers; the env list stands in only when there are
// none, and that is reported as system.health.

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn(), storageQueue: jest.fn(), timer: jest.fn() } };
});
jest.mock("../db", () => ({
  beginTransaction: jest.fn().mockResolvedValue(undefined),
  closeConnection: jest.fn(),
  commitTransaction: jest.fn().mockResolvedValue(undefined),
  createRequestConnection: jest.fn().mockResolvedValue({}),
  executeQuery: jest.fn(),
  rollbackTransaction: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../auth", () => ({
  ...jest.requireActual("../auth"),
  errorResponse: jest.fn().mockReturnValue({ status: 500, jsonBody: { error: "Error" } }),
  extractToken: jest.fn().mockReturnValue("mock-token"),
  requireRole: jest.fn().mockResolvedValue(null),
  rolesForRequest: jest.fn().mockResolvedValue(["accounts_manager"]),
  unauthorizedResponse: jest.fn().mockReturnValue({ status: 401, jsonBody: { error: "Unauthorized" } }),
  verifiedIdentityFromRequest: jest.fn().mockResolvedValue({ email: "ops@rp", name: "Olive Ops", oid: "olive-oid" }),
}));
jest.mock("../blob-storage", () => ({ generateReadSasUrl: jest.fn().mockReturnValue("https://sas") }));
jest.mock("../graph", () => ({ graphFetchEmails: jest.fn(), graphSendMail: jest.fn().mockResolvedValue(undefined) }));
jest.mock("../rateLimit", () => ({ checkRateLimit: jest.fn().mockReturnValue({ allowed: true, retryAfterMs: 0 }) }));
jest.mock("../sentry", () => ({ Sentry: { captureException: jest.fn(), captureMessage: jest.fn() } }));
jest.mock("../jobStatusHelpers", () => ({ advanceJobStatus: jest.fn() }));
jest.mock("../planner", () => ({ resolveActivePlannerTasks: jest.fn().mockResolvedValue(undefined) }));
jest.mock("../quote-decisions", () => ({ approveDirectorQuote: jest.fn(), rejectQuote: jest.fn() }));
jest.mock("../pdf/job-packet-loader", () => ({
  loadJobPacketInputs: jest
    .fn()
    .mockResolvedValue({ job: { buildingName: "Harbour House", title: "Leak" }, jobAttachments: [], sourcePointAttachments: [] }),
}));
jest.mock("../pdf/job-packet", () => ({
  buildJobPacket: jest.fn().mockResolvedValue(Buffer.from("pdf")),
  nonMergeableAttachments: jest.fn().mockReturnValue([]),
}));

type Handler = (req: HttpRequest, ctx: InvocationContext) => Promise<{ status?: number; jsonBody?: any }>;
type Param = { name: string; value: unknown };

const db = require("../db") as { beginTransaction: jest.Mock; commitTransaction: jest.Mock; executeQuery: jest.Mock };
const decisions = require("../quote-decisions") as { approveDirectorQuote: jest.Mock; rejectQuote: jest.Mock };
const graph = require("../graph") as { graphSendMail: jest.Mock };
const { Sentry } = require("../sentry") as { Sentry: { captureMessage: jest.Mock } };
const { recordEmailQuoteDecision } = require("../functions/emails") as { recordEmailQuoteDecision: Handler };
const { resolveRoleRecipients } = require("../email/role-recipients") as {
  resolveRoleRecipients: (c: unknown, role: string, fallback: string[], report?: (m: string) => void) => Promise<{ addresses: string[]; source: string }>;
};
const { sendDirectorApprovalEmail } = require("../email/director-emails") as {
  sendDirectorApprovalEmail: (a: Record<string, unknown>) => Promise<{ sentTo: string[] }>;
};

const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;
const post = (body: unknown) =>
  ({ headers: { get: () => null }, json: jest.fn().mockResolvedValue(body), query: new URLSearchParams() }) as unknown as HttpRequest;
const calls = () =>
  db.executeQuery.mock.calls.map((c: unknown[]) => ({
    params: Object.fromEntries(((c[2] as Param[] | undefined) ?? []).map((p) => [p.name, p.value])),
    sql: String(c[1]),
  }));

const EMAIL = { EmailID: 42, FromAddress: "carlo@randazzo.properties", MatchedJobID: 9, Status: "new" };
const QUOTE = { JobID: 9, QuoteNumber: "QT-9-ACM-1", Status: "awaiting_director" };
const USERS = [
  { DisplayName: "Carlo", Email: "carlo@randazzo.properties", IsActive: 1, Role: "director", UserID: 1 },
  { DisplayName: "Paolo", Email: " Paolo@Randazzo.properties ", IsActive: 1, Role: "Director", UserID: 2 },
  { DisplayName: "Fay", Email: "fay@randazzo.properties", IsActive: 1, Role: "facilities_manager", UserID: 3 },
];

function routeSql(email: Record<string, unknown> | null, users: Record<string, unknown>[] = USERS): void {
  db.executeQuery.mockImplementation(async (_c: unknown, sql: string) => {
    if (/FROM Emails WHERE EmailID/.test(sql)) return email ? [email] : [];
    if (/FROM Quotes WHERE QuoteID/.test(sql)) return [QUOTE];
    if (/INSERT INTO JobEvents/.test(sql)) return [{ JobEventID: 77 }];
    if (/UPDATE Emails/.test(sql)) return [{ EmailID: 42 }];
    if (/FROM dbo\.AppUsers/.test(sql)) return users;
    return [];
  });
}

const savedEnv = { ...process.env };
beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...savedEnv, APP_BASE_URL: "https://floorplan.example" };
  delete process.env.EMAIL_REPLY_DECISIONS_ENABLED;
  delete process.env.DEV_EMAIL_OVERRIDE;
  delete process.env.DIRECTOR_APPROVAL_EMAILS;
});
afterAll(() => {
  process.env = savedEnv;
});

describe("a director's emailed reply, with reply-to-approve off (the default)", () => {
  it.each([undefined, "false", "", "1", "TRUE"])("files the reply on the job and applies no decision (switch %p)", async (value) => {
    if (value !== undefined) process.env.EMAIL_REPLY_DECISIONS_ENABLED = value;
    routeSql(EMAIL);

    const res = await recordEmailQuoteDecision(post({ Decision: "approved", EmailID: 42, QuoteID: 7 }), ctx);

    expect(res.status).toBe(403);
    expect(res.jsonBody).toMatchObject({
      code: "EMAIL_REPLY_DECISIONS_DISABLED",
      jobId: 9,
      jobUrl: "https://floorplan.example/jobs?jobId=9&step=quotes",
      linked: true,
    });
    const event = calls().find((c: { sql: string }) => /INSERT INTO JobEvents/.test(c.sql))!;
    expect(event.sql).toContain("'email.reply_linked'");
    expect(event.params).toMatchObject({ CreatedBy: "Olive Ops", EmailID: 42, JobID: 9, QuoteID: 7 });
    expect(calls().some((c: { sql: string }) => /UPDATE Emails SET Status = 'promoted'/.test(c.sql))).toBe(true);
    expect(db.commitTransaction).toHaveBeenCalledTimes(1);
    expect(decisions.approveDirectorQuote).not.toHaveBeenCalled();
    expect(decisions.rejectQuote).not.toHaveBeenCalled();
    expect(calls().some((c: { sql: string }) => /DecisionLedger/.test(c.sql))).toBe(false);
  });

  it("refuses to file a reply matched to another job, and writes nothing", async () => {
    routeSql({ ...EMAIL, MatchedJobID: 3 });

    const res = await recordEmailQuoteDecision(post({ Decision: "approved", EmailID: 42, QuoteID: 7 }), ctx);

    expect(res.status).toBe(422);
    expect(calls().some((c: { sql: string }) => /INSERT|UPDATE/.test(c.sql))).toBe(false);
  });

  it("answers 404 for an unknown email", async () => {
    routeSql(null);

    const res = await recordEmailQuoteDecision(post({ Decision: "rejected", EmailID: 42, QuoteID: 7 }), ctx);

    expect(res.status).toBe(404);
    expect(db.beginTransaction).not.toHaveBeenCalled();
  });

  it("still applies the decision when the switch is exactly true", async () => {
    process.env.EMAIL_REPLY_DECISIONS_ENABLED = "true";
    routeSql(EMAIL);

    await recordEmailQuoteDecision(post({ Decision: "approved", EmailID: 42, QuoteID: 7 }), ctx);

    expect(calls().some((c: { sql: string }) => /email\.reply_linked/.test(c.sql))).toBe(false);
  });
});

describe("director approval recipients", () => {
  it("are the active directors in AppUsers, whatever the case of their role", async () => {
    routeSql(null);
    const report = jest.fn();

    const result = await resolveRoleRecipients({}, "director", ["fallback@gwe.example"], report);

    expect(result).toEqual({ addresses: ["carlo@randazzo.properties", "Paolo@Randazzo.properties"], source: "roles" });
    expect(report).not.toHaveBeenCalled();
  });

  it("fall back to the env list only when no director exists, reported as system.health", async () => {
    routeSql(null, [USERS[2]]);

    const result = await resolveRoleRecipients({}, "director", ["fallback@gwe.example"]);

    expect(result).toEqual({ addresses: ["fallback@gwe.example"], source: "env_fallback" });
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      expect.stringContaining("system.health"),
      expect.objectContaining({ tags: expect.objectContaining({ category: "system.health" }) }),
    );
  });

  it("the packet goes to the role's directors, through DEV_EMAIL_OVERRIDE", async () => {
    routeSql(null);
    process.env.DIRECTOR_APPROVAL_EMAILS = "someone-else@gwe.example";

    const sent = await sendDirectorApprovalEmail({ amount: 4840, connection: {}, currency: "AUD", jobId: 9, stage: "quote" });

    expect(graph.graphSendMail.mock.calls[0][0]).toEqual(["carlo@randazzo.properties", "Paolo@Randazzo.properties"]);
    expect(sent.sentTo).toEqual(["carlo@randazzo.properties", "Paolo@Randazzo.properties"]);

    jest.clearAllMocks();
    process.env.DEV_EMAIL_OVERRIDE = "staging@gwe.example";
    await sendDirectorApprovalEmail({ amount: 4840, connection: {}, currency: "AUD", jobId: 9, stage: "quote" });
    expect(graph.graphSendMail.mock.calls[0][0]).toEqual(["staging@gwe.example"]);
  });

  it("refuses to send when there is neither a director nor a fallback", async () => {
    routeSql(null, []);

    await expect(
      sendDirectorApprovalEmail({ amount: 1, connection: {}, currency: "AUD", jobId: 9, stage: "invoice" }),
    ).rejects.toThrow(/no director/i);
    expect(graph.graphSendMail).not.toHaveBeenCalled();
  });
});

describe("facilities-manager escalation recipients", () => {
  const { targetAddresses } = require("../escalation/notifier") as {
    targetAddresses: (row: Record<string, unknown>, users: Record<string, unknown>[], env: NodeJS.ProcessEnv) => string[];
  };
  const row = {
    context: null, noIndependentTarget: false, raisedByUserId: null, targetRole: "facilities_manager", targetUserId: null,
  };
  const env = { FACILITIES_MANAGER_EMAILS: "boss@gwe.example" } as NodeJS.ProcessEnv;

  it("come from the role, with no health report", () => {
    expect(targetAddresses(row, [{ email: "fay@rp", name: "Fay", role: "facilities_manager", userId: 3 }], env)).toEqual(["fay@rp"]);
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });

  it("fall back to the env list only when nobody holds the role, reported as system.health", () => {
    expect(targetAddresses(row, [], env)).toEqual(["boss@gwe.example"]);
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      expect.stringContaining("facilities_manager"),
      expect.objectContaining({ tags: { category: "system.health" } }),
    );
  });
});
