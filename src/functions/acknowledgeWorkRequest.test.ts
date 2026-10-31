import { HttpRequest, type InvocationContext } from "@azure/functions";
import { AppRole } from "../auth";
import * as recordsModule from "../comms/recipientRecords";
import * as jobStore from "../comms/store";
import * as userStore from "../comms/userSignatureStore";
import * as flags from "../features/flags";
import * as templateModule from "../intake/template";
import { executeQuery } from "../db";
import { record } from "../ledger";
import { _resetRateLimitForTests } from "../rateLimit";
import { acknowledgeWorkRequest } from "./acknowledgeWorkRequest";

jest.mock("@azure/functions", () => ({ ...jest.requireActual("@azure/functions"), app: { http: jest.fn() } }));
let roles: string[] = [AppRole.FACILITIES];
jest.mock("../auth", () => ({
  ...jest.requireActual("../auth"),
  extractToken: () => "token",
  requireRole: async (_r: unknown, allowed: string[]) => (jest.requireActual("../auth").rolesPassGate(roles, allowed) ? null : { status: 403 }),
  rolesForRequest: async () => roles,
  verifiedIdentityFromRequest: async () => ({ email: "fay@randazzo.properties", name: "Fay Facilities", oid: "fay-oid" }),
}));
jest.mock("../db", () => ({
  beginTransaction: jest.fn().mockResolvedValue(undefined),
  closeConnection: jest.fn(),
  commitTransaction: jest.fn().mockResolvedValue(undefined),
  createRequestConnection: jest.fn(async () => ({})),
  executeQuery: jest.fn(),
  rollbackTransaction: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../ledger", () => ({ record: jest.fn() }));
jest.mock("../comms/idempotency", () => ({ ...jest.requireActual("../comms/idempotency"), findJobByKey: jest.fn().mockResolvedValue(null), takeKeyLock: jest.fn().mockResolvedValue(true) }));
jest.mock("../comms/events", () => ({ appendEvent: jest.fn() }));
jest.mock("../comms/recipientRecords", () => ({ resolveRecipientRecord: jest.fn() }));
jest.mock("../comms/store", () => ({ insertJob: jest.fn(), insertRecipient: jest.fn(), readJob: jest.fn(), recentRecipientCount: jest.fn() }));
jest.mock("../comms/userSignatureStore", () => ({ findUserByOid: jest.fn(), readUserSignature: jest.fn() }));
jest.mock("../features/flags", () => ({ isFeatureEnabledForRoles: jest.fn() }));
jest.mock("../intake/template", () => ({ ...jest.requireActual("../intake/template"), loadAckTemplate: jest.fn() }));

const context = { error: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;
const post = (body: unknown) => new HttpRequest({ body: { string: JSON.stringify(body) }, headers: { "Content-Type": "application/json" }, method: "POST", url: "http://localhost/api/acknowledgeWorkRequest" });
const query = jest.mocked(executeQuery);
const jobs = jest.mocked(jobStore);

const requestRow = (over: Record<string, unknown> = {}) => ({
  BuildingID: 4, BuildingName: "Tower A", ContactEmail: "pat@tenant.example", ContactName: "Pat", HasJob: 0, IntakeState: null, JobCode: "WR-31",
  LevelName: "Level 2", RequestType: "Leak", TenantName: "Acme", ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  _resetRateLimitForTests();
  roles = [AppRole.FACILITIES];
  delete process.env.COMMS_SEND_ENABLED;
  delete process.env.COMMS_SEND_DRY_RUN;
  jest.mocked(flags.isFeatureEnabledForRoles).mockResolvedValue(true);
  jest.mocked(templateModule.loadAckTemplate).mockResolvedValue({ approved: true, bodyMarkdown: "Dear {{tenant.addressee}},\n\nWe have {{request.reference}} about {{request.summary}} at {{building.name}}.", subject: "We have your request {{request.reference}}", version: 1 });
  jest.mocked(userStore.findUserByOid).mockResolvedValue({ displayName: "Fay Facilities", email: "fay@randazzo.properties", userId: 7 });
  jest.mocked(userStore.readUserSignature).mockResolvedValue({ jobTitle: "Facilities officer", phone: null, updatedAt: null });
  jest.mocked(recordsModule.resolveRecipientRecord).mockResolvedValue({ ok: true });
  jobs.insertJob.mockResolvedValue(55);
  jobs.recentRecipientCount.mockResolvedValue(0);
  jobs.insertRecipient.mockResolvedValue(1);
  query.mockImplementation(async (_c: unknown, sql: string) => (/^\s*SELECT/i.test(sql) ? [requestRow()] : /UPDATE dbo\.WorkRequests/.test(sql) ? [{ WorkRequestID: 31 }] : []));
});

const updates = () => query.mock.calls.filter(([, sql]) => /UPDATE dbo\.WorkRequests/.test(String(sql)));

describe("acknowledgeWorkRequest", () => {
  it("queues the request_ack email to the request's contact, then records who and when", async () => {
    const response = await acknowledgeWorkRequest(post({ workRequestId: 31 }), context);
    expect(response.status).toBe(200);
    expect(response.jsonBody).toMatchObject({ acknowledgedVia: "email", correspondenceId: 55, workRequestId: 31 });
    const job = jobs.insertJob.mock.calls[0][1];
    expect(job).toMatchObject({ kind: "letter", subject: "We have your request {{request.reference}}", templateId: "request_ack", templateVersion: 1 });
    expect(job.recipients).toEqual([expect.objectContaining({ address: "pat@tenant.example", recipientType: "manual", mergeValues: expect.objectContaining({ "request.reference": "WR-31" }) })]);
    expect(updates()).toHaveLength(1);
    expect(jest.mocked(record).mock.calls.at(-1)?.[1]).toMatchObject({ action: "work_request.acknowledge", subject: { id: 31, type: "work_request" } });
  });

  it("does not touch the request when the email cannot be queued (a test contact is refused)", async () => {
    jest.mocked(recordsModule.resolveRecipientRecord).mockResolvedValue({ code: "test_record", detail: "That address belongs to a test record", ok: false });
    const response = await acknowledgeWorkRequest(post({ workRequestId: 31 }), context);
    expect(response.status).toBe(400);
    expect(jobs.insertJob).not.toHaveBeenCalled();
    expect(updates()).toHaveLength(0);
  });

  it("refuses an unapproved template when sends are live, but allows it while sends are off", async () => {
    jest.mocked(templateModule.loadAckTemplate).mockResolvedValue({ approved: false, bodyMarkdown: "Hello {{tenant.addressee}}", subject: "Hi", version: 1 });
    process.env.COMMS_SEND_ENABLED = "true";
    expect((await acknowledgeWorkRequest(post({ workRequestId: 31 }), context)).status).toBe(409);
    delete process.env.COMMS_SEND_ENABLED;
    expect((await acknowledgeWorkRequest(post({ workRequestId: 31 }), context)).status).toBe(200);
  });

  it("acknowledges without an email, sending nothing", async () => {
    const response = await acknowledgeWorkRequest(post({ withoutEmail: true, workRequestId: 31 }), context);
    expect(response.status).toBe(200);
    expect(response.jsonBody).toMatchObject({ acknowledgedVia: "other", correspondenceId: null });
    expect(jobs.insertJob).not.toHaveBeenCalled();
  });

  it("asks for a way forward when the request has no contact email", async () => {
    query.mockImplementation(async (_c: unknown, sql: string) => (/^\s*SELECT/i.test(sql) ? [requestRow({ ContactEmail: null })] : []));
    expect((await acknowledgeWorkRequest(post({ workRequestId: 31 }), context)).status).toBe(400);
  });

  it("acknowledges once: a second click, a closed request or one with a job is a 409", async () => {
    for (const row of [requestRow({ AcknowledgedBy: "Sam", IntakeState: "acknowledged" }), requestRow({ IntakeState: "closed_duplicate" }), requestRow({ HasJob: 1 })]) {
      query.mockImplementation(async (_c: unknown, sql: string) => (/^\s*SELECT/i.test(sql) ? [row] : []));
      expect((await acknowledgeWorkRequest(post({ workRequestId: 31 }), context)).status).toBe(409);
    }
    expect(jobs.insertJob).not.toHaveBeenCalled();
  });

  it("is 404 while the tenantRequests flag is hidden for the caller, and 403 for roles that may not", async () => {
    jest.mocked(flags.isFeatureEnabledForRoles).mockResolvedValue(false);
    expect((await acknowledgeWorkRequest(post({ workRequestId: 31 }), context)).status).toBe(404);
    roles = [AppRole.ADMIN];
    expect((await acknowledgeWorkRequest(post({ workRequestId: 31 }), context)).status).toBe(403);
    roles = [AppRole.USER];
    expect((await acknowledgeWorkRequest(post({ workRequestId: 31 }), context)).status).toBe(403);
  });

  it("accepts a request raised in Floorplan, whose id is negative", async () => {
    expect((await acknowledgeWorkRequest(post({ workRequestId: -1, withoutEmail: true }), context)).status).toBe(200);
  });

  it("rejects a malformed body", async () => {
    for (const body of [{}, { workRequestId: "31" }, { workRequestId: 0 }, { workRequestId: 31, to: "x" }, { workRequestId: 31, withoutEmail: "yes" }]) {
      expect((await acknowledgeWorkRequest(post(body), context)).status).toBe(400);
    }
  });
});
