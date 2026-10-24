import { HttpRequest, type InvocationContext } from "@azure/functions";
import { AppRole } from "../auth";
import * as events from "../comms/events";
import type { AdminIdentity } from "../comms/identityStore";
import * as identityStore from "../comms/identityStore";
import * as records from "../comms/recipientRecords";
import * as jobStore from "../comms/store";
import * as userStore from "../comms/userSignatureStore";
import { record } from "../ledger";
import { _resetRateLimitForTests } from "../rateLimit";
import { previewCorrespondence } from "./previewCorrespondence";
import { queueCorrespondence } from "./queueCorrespondence";

jest.mock("@azure/functions", () => ({ ...jest.requireActual("@azure/functions"), app: { http: jest.fn() } }));
let roles: string[] = [AppRole.ACCOUNTS_APPROVAL];
let token: string | null = "token";
let email = "fay@randazzo.properties";
jest.mock("../auth", () => ({
  ...jest.requireActual("../auth"),
  extractToken: () => token,
  requireRole: async (_r: unknown, allowed: string[]) => (jest.requireActual("../auth").rolesPassGate(roles, allowed) ? null : { status: 403 }),
  rolesForRequest: async () => roles,
  verifiedIdentityFromRequest: async () => (token ? { email, name: "Fay Facilities", oid: "fay-oid" } : null),
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
jest.mock("../comms/events", () => ({ appendEvent: jest.fn() }));
jest.mock("../comms/recipientRecords", () => ({ resolveRecipientRecord: jest.fn() }));
jest.mock("../comms/store", () => ({ insertJob: jest.fn(), insertRecipient: jest.fn(), readJob: jest.fn(), readRecipient: jest.fn(), recentRecipientCount: jest.fn() }));
jest.mock("../comms/identityStore", () => ({ ...jest.requireActual("../comms/identityStore"), readIdentity: jest.fn() }));
jest.mock("../comms/userSignatureStore", () => ({ findUserByOid: jest.fn(), readUserSignature: jest.fn() }));

const idStore = { ...jest.mocked(identityStore), ...jest.mocked(userStore) };
const jobs = jest.mocked(jobStore);
const context = { error: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;
const post = (body: unknown) => new HttpRequest({ body: { string: typeof body === "string" ? body : JSON.stringify(body) }, headers: { "Content-Type": "application/json" }, method: "POST", url: "http://localhost/api/x" });

const identity = (over: Partial<AdminIdentity> = {}): AdminIdentity => ({
  address: "accounts@randazzo.properties", allowedRoles: [AppRole.ACCOUNTS], archivedAt: null, archivedBy: null, createdAt: "2026-10-24T00:00:00.000Z",
  createdBy: "Will", displayName: "Randazzo Accounts", identityId: 3, isActive: true, rowVersion: "0000000000000A01",
  signature: { email: "accounts@randazzo.properties", lines: ["Accounts team"], phone: "08 8900 1111" }, teamLabel: "Accounts", updatedAt: null, updatedBy: null,
  ...over,
});
const recipient = (n: number, over: Record<string, unknown> = {}) => ({ address: `pat${n}@example.com`, mergeValues: { "tenant.name": `Tenant ${n}` }, name: `Pat ${n}`, recipientRefId: n, recipientType: "tenancy", ...over });
const request = (over: Record<string, unknown> = {}, count = 2) => ({
  bodyMarkdown: "Dear {{tenant.name}},\n\nWater is off Tuesday.",
  kind: "broadcast",
  recipients: Array.from({ length: count }, (_, i) => recipient(i + 1)),
  replyTo: { identityId: 3, type: "identity" },
  signatureMode: "role",
  subject: "Water shut-off",
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  _resetRateLimitForTests();
  roles = [AppRole.ACCOUNTS_APPROVAL];
  token = "token";
  email = "fay@randazzo.properties";
  delete process.env.COMMS_APPROVAL_THRESHOLD;
  idStore.readIdentity.mockResolvedValue(identity());
  idStore.findUserByOid.mockResolvedValue({ displayName: "Fay Facilities", email, userId: 7 });
  idStore.readUserSignature.mockResolvedValue({ jobTitle: "Accounts officer", phone: "08 8900 0000", updatedAt: null });
  jobs.insertJob.mockResolvedValue(41);
  jobs.recentRecipientCount.mockResolvedValue(0);
  jest.mocked(records.resolveRecipientRecord).mockResolvedValue({ ok: true });
  jobs.insertRecipient.mockResolvedValue(1);
});

describe("queueCorrespondence: who may", () => {
  it.each([AppRole.ACCOUNTS_APPROVAL, AppRole.FACILITIES_APPROVAL, AppRole.CFO, AppRole.DIRECTOR])("lets %s queue a broadcast", async (role) => {
    roles = [role];
    // the identity is for accounts roles; use the sender's own address so every role has a valid reply-to
    const response = await queueCorrespondence(post(request({ replyTo: { type: "own" }, signatureMode: "personal" })), context);
    expect(response.status).toBe(201);
  });

  it.each([AppRole.ACCOUNTS, AppRole.FACILITIES])("lets %s queue a letter but not a broadcast, which is for managers and directors", async (role) => {
    roles = [role];
    const own = { replyTo: { type: "own" }, signatureMode: "personal" };
    expect((await queueCorrespondence(post(request({ ...own, kind: "letter" })), context)).status).toBe(201);
    jobs.insertJob.mockClear();
    const refused = await queueCorrespondence(post(request(own)), context);
    expect(refused.status).toBe(403);
    expect(JSON.stringify(refused.jsonBody)).toContain("managers and directors");
    expect(jobs.insertJob).not.toHaveBeenCalled();
  });

  it("refuses admin, which sends nothing real, and a baseline user, before reading anything", async () => {
    for (const role of [AppRole.ADMIN, AppRole.USER]) {
      roles = [role];
      expect((await queueCorrespondence(post(request()), context)).status).toBe(403);
    }
    expect(jobs.insertJob).not.toHaveBeenCalled();
    expect(idStore.readIdentity).not.toHaveBeenCalled();
  });

  it("refuses a request with no token", async () => {
    token = null;
    expect((await queueCorrespondence(post(request()), context)).status).toBe(401);
  });
});

describe("queueCorrespondence: the job", () => {
  it("queues a small send from notices@ with the identity's reply-to and team signature, created by the token's person", async () => {
    const response = await queueCorrespondence(post(request()), context);
    expect(response.status).toBe(201);
    expect(response.jsonBody).toMatchObject({ blocked: 0, correspondenceId: 41, queued: 2, requiresApproval: false, status: "queued" });
    const job = jobs.insertJob.mock.calls[0][1];
    expect(job).toMatchObject({
      createdBy: { email: "fay@randazzo.properties", name: "Fay Facilities", oid: "fay-oid", role: "accounts_manager" },
      fromAddress: "notices@randazzo.properties",
      fromName: "Randazzo Properties",
      replyTo: { address: "accounts@randazzo.properties", identityId: 3, name: "Randazzo Accounts" },
      signature: { email: "accounts@randazzo.properties", lines: ["Accounts team"], phone: "08 8900 1111" },
      signatureMode: "role",
    });
    expect(jobs.insertJob.mock.calls[0][2]).toBe("queued");
    expect(jobs.insertRecipient).toHaveBeenCalledTimes(2);
  });

  it("composes a personal signature from the verified name, title and phone", async () => {
    await queueCorrespondence(post(request({ replyTo: { type: "own" }, signatureMode: "personal" })), context);
    expect(jobs.insertJob.mock.calls[0][1]).toMatchObject({
      replyTo: { address: "fay@randazzo.properties", identityId: null, name: "Fay Facilities" },
      signature: { email: "fay@randazzo.properties", lines: ["Fay Facilities", "Accounts officer"], phone: "08 8900 0000" },
    });
  });

  it("writes the job, its recipients, its first event and a ledger row together in one transaction", async () => {
    const db = jest.requireMock("../db") as { beginTransaction: jest.Mock; commitTransaction: jest.Mock };
    await queueCorrespondence(post(request()), context);
    expect(db.beginTransaction).toHaveBeenCalledTimes(1);
    expect(db.commitTransaction).toHaveBeenCalledTimes(1);
    expect(jest.mocked(events.appendEvent)).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ actor: { kind: "user", name: "Fay Facilities", oid: "fay-oid" }, correspondenceId: 41, fromStatus: null, toStatus: "queued", type: "job" }));
    expect(jest.mocked(record)).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "correspondence.queue", actor: expect.objectContaining({ kind: "user", name: "Fay Facilities", role: "accounts_manager", userId: 7 }), subject: { id: 41, type: "correspondence" } }));
  });

  it("rolls everything back when the ledger row can't be written", async () => {
    const db = jest.requireMock("../db") as { commitTransaction: jest.Mock; rollbackTransaction: jest.Mock };
    jest.mocked(record).mockRejectedValueOnce(new Error("ledger down"));
    expect((await queueCorrespondence(post(request()), context)).status).toBe(500);
    expect(db.rollbackTransaction).toHaveBeenCalled();
    expect(db.commitTransaction).not.toHaveBeenCalled();
  });
});

describe("queueCorrespondence: the approval threshold", () => {
  it("puts a send over 20 recipients to a manager, and one of exactly 20 straight to the queue", async () => {
    const over = await queueCorrespondence(post(request({}, 21)), context);
    expect(over.jsonBody).toMatchObject({ requiresApproval: true, status: "awaiting_approval" });
    expect(jobs.insertJob.mock.calls[0][2]).toBe("awaiting_approval");
    expect(jobs.insertJob.mock.calls[0][3]).toBe(true);
    jobs.insertJob.mockClear();
    const exact = await queueCorrespondence(post(request({}, 20)), context);
    expect(exact.jsonBody).toMatchObject({ requiresApproval: false, status: "queued" });
    expect(jobs.insertJob.mock.calls[0][2]).toBe("queued");
  });

  it("uses COMMS_APPROVAL_THRESHOLD when set", async () => {
    process.env.COMMS_APPROVAL_THRESHOLD = "2";
    expect((await queueCorrespondence(post(request({}, 3)), context)).jsonBody).toMatchObject({ status: "awaiting_approval" });
    expect((await queueCorrespondence(post(request({}, 2)), context)).jsonBody).toMatchObject({ status: "queued" });
  });

  it("records a duplicate address once and says so", async () => {
    const response = await queueCorrespondence(post(request({ recipients: [recipient(1), recipient(1)] })), context);
    expect(response.jsonBody).toMatchObject({ duplicatesDropped: 1, queued: 1 });
  });
});

describe("queueCorrespondence: the threshold counts a sender's last 24 hours, so a send can't be split", () => {
  it("asks for the creator's own total, from the token, inside the job's transaction", async () => {
    await queueCorrespondence(post(request()), context);
    expect(jobs.recentRecipientCount).toHaveBeenCalledWith(expect.anything(), "fay-oid");
    expect(jobs.recentRecipientCount.mock.invocationCallOrder[0]).toBeLessThan(jobs.insertJob.mock.invocationCallOrder[0]);
    const db = jest.requireMock("../db") as { beginTransaction: jest.Mock };
    expect(db.beginTransaction.mock.invocationCallOrder[0]).toBeLessThan(jobs.recentRecipientCount.mock.invocationCallOrder[0]);
  });

  it("puts a small send to a manager when this sender's earlier sends in the last 24 hours take them over", async () => {
    jobs.recentRecipientCount.mockResolvedValue(18);
    const response = await queueCorrespondence(post(request({}, 5)), context);
    expect(response.jsonBody).toMatchObject({ approvalReason: "recent", recentRecipients: 18, requiresApproval: true, status: "awaiting_approval" });
    expect((response.jsonBody as { approvalNote: string }).approvalNote).toBe(
      "You have already sent to 18 people in the last 24 hours. With these 5 that is over 20, so a manager approves this one first.",
    );
    expect(jobs.insertJob.mock.calls[0][2]).toBe("awaiting_approval");
    expect(jobs.insertJob.mock.calls[0][3]).toBe(true);
    expect(jest.mocked(events.appendEvent)).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ detail: expect.stringContaining("18 in the last 24 hours"), toStatus: "awaiting_approval" }));
  });

  it("queues it when the total is exactly the threshold, and says nothing about approval", async () => {
    jobs.recentRecipientCount.mockResolvedValue(15);
    const response = await queueCorrespondence(post(request({}, 5)), context);
    expect(response.jsonBody).toMatchObject({ approvalNote: null, approvalReason: null, requiresApproval: false, status: "queued" });
  });

  it("gives the size reason, not the 24 hour one, for a single large send", async () => {
    const response = await queueCorrespondence(post(request({}, 21)), context);
    expect(response.jsonBody).toMatchObject({ approvalReason: "size", requiresApproval: true });
    expect((response.jsonBody as { approvalNote: string }).approvalNote).toBe("This goes to 21 people, which is over 20, so a manager approves it first.");
  });

  it("follows COMMS_APPROVAL_THRESHOLD", async () => {
    process.env.COMMS_APPROVAL_THRESHOLD = "30";
    jobs.recentRecipientCount.mockResolvedValue(25);
    expect((await queueCorrespondence(post(request({}, 6)), context)).jsonBody).toMatchObject({ approvalReason: "recent", status: "awaiting_approval" });
    expect((await queueCorrespondence(post(request({}, 5)), context)).jsonBody).toMatchObject({ status: "queued" });
  });

  it("records the reason in the ledger row", async () => {
    jobs.recentRecipientCount.mockResolvedValue(18);
    await queueCorrespondence(post(request({}, 5)), context);
    expect(jest.mocked(record)).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ after: expect.objectContaining({ approvalReason: "recent", recentRecipients: 18, status: "awaiting_approval" }) }));
  });
});

describe("queueCorrespondence: recipients are resolved from the server's records (review M3)", () => {
  const resolve = () => jest.mocked(records.resolveRecipientRecord);

  it("asks about each recipient by the type, id and address in the request, before storing anything", async () => {
    await queueCorrespondence(post(request({ recipients: [recipient(1), recipient(2, { recipientRefId: 9, recipientType: "contractor" }), recipient(3, { recipientRefId: undefined, recipientType: "manual" })] })), context);
    expect(resolve().mock.calls.map(([, claim]) => ({ address: claim.address, recipientRefId: claim.recipientRefId, recipientType: claim.recipientType }))).toEqual([
      { address: "pat1@example.com", recipientRefId: "1", recipientType: "tenancy" },
      { address: "pat2@example.com", recipientRefId: "9", recipientType: "contractor" },
      { address: "pat3@example.com", recipientRefId: null, recipientType: "manual" },
    ]);
    expect(resolve().mock.invocationCallOrder[0]).toBeLessThan(jobs.insertRecipient.mock.invocationCallOrder[0]);
  });

  it("stores a recipient whose address isn't the record's contact blocked, with the reason, and queues the rest", async () => {
    resolve().mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ code: "address_mismatch", detail: "That address isn't the recorded contact for that record", ok: false });
    const response = await queueCorrespondence(post(request()), context);
    expect(response.jsonBody).toMatchObject({ blocked: 1, queued: 1, status: "queued" });
    expect(jobs.insertRecipient.mock.calls[1][3]).toEqual({ detail: "That address isn't the recorded contact for that record", errorCode: "address_mismatch", status: "blocked" });
  });

  it("refuses a typed address that is a test record's contact, and a test tenancy, the same way", async () => {
    resolve().mockResolvedValueOnce({ code: "test_record", detail: "That address belongs to a test record", ok: false }).mockResolvedValueOnce({ code: "test_record", detail: "That tenancy is a test record", ok: false });
    expect((await queueCorrespondence(post(request({}, 3)), context)).jsonBody).toMatchObject({ blocked: 2, queued: 1 });
    expect(jobs.insertRecipient.mock.calls.map((call) => call[3].errorCode)).toEqual(["test_record", "test_record", null]);
  });

  it("creates nothing when no recipient resolves, and says why", async () => {
    resolve().mockResolvedValue({ code: "address_mismatch", detail: "That address isn't the recorded contact for that record", ok: false });
    const response = await queueCorrespondence(post(request()), context);
    expect(response.status).toBe(400);
    expect(JSON.stringify(response.jsonBody)).toContain("recorded contact");
    expect(jobs.insertJob).not.toHaveBeenCalled();
  });
});

describe("queueCorrespondence: reply-to and signature are checked on the server", () => {
  it("refuses an identity the role may not use", async () => {
    roles = [AppRole.FACILITIES_APPROVAL];
    const response = await queueCorrespondence(post(request()), context);
    expect(response.status).toBe(403);
    expect(jobs.insertJob).not.toHaveBeenCalled();
  });

  it("refuses an inactive, an archived and a missing identity", async () => {
    idStore.readIdentity.mockResolvedValueOnce(identity({ isActive: false }));
    expect((await queueCorrespondence(post(request()), context)).status).toBe(403);
    idStore.readIdentity.mockResolvedValueOnce(identity({ archivedAt: "2026-10-01T00:00:00.000Z" }));
    expect((await queueCorrespondence(post(request()), context)).status).toBe(403);
    idStore.readIdentity.mockResolvedValueOnce(null);
    expect((await queueCorrespondence(post(request()), context)).status).toBe(404);
    expect(jobs.insertJob).not.toHaveBeenCalled();
  });

  it("refuses the person's own address when it isn't on the company domain", async () => {
    email = "fay@gmail.com";
    expect((await queueCorrespondence(post(request({ replyTo: { type: "own" }, signatureMode: "personal" })), context)).status).toBe(403);
  });

  it("refuses a team signature with the own-address reply-to: there is no identity to take it from", async () => {
    const response = await queueCorrespondence(post(request({ replyTo: { type: "own" }, signatureMode: "role" })), context);
    expect(response.status).toBe(400);
    expect(JSON.stringify(response.jsonBody)).toContain("team signature needs a reply-to identity");
  });

  it.each([
    { signature: "Kind regards, Someone Else" },
    { signatureText: "x" },
    { fromAddress: "ceo@randazzo.properties" },
    { senderName: "Someone Else" },
    { replyTo: { address: "boss@randazzo.properties", type: "own" } },
  ])("refuses a request carrying %j", async (extra) => {
    const response = await queueCorrespondence(post(request(extra)), context);
    expect(response.status).toBe(400);
    expect(jobs.insertJob).not.toHaveBeenCalled();
    expect(idStore.readIdentity).not.toHaveBeenCalled();
  });
});

describe("queueCorrespondence: merge fields fail closed", () => {
  it("stores a recipient with a missing field blocked, names the field, and queues the rest", async () => {
    const response = await queueCorrespondence(post(request({ recipients: [recipient(1), recipient(2, { mergeValues: {} })] })), context);
    expect(response.jsonBody).toMatchObject({ blocked: 1, queued: 1, status: "queued" });
    expect(jobs.insertRecipient.mock.calls[0][3]).toEqual({ detail: null, errorCode: null, status: "queued" });
    expect(jobs.insertRecipient.mock.calls[1][3]).toEqual({ detail: "Missing: Tenant name", errorCode: "missing_field", status: "blocked" });
  });

  it("creates nothing when no recipient can be sent, and says which field", async () => {
    const response = await queueCorrespondence(post(request({ recipients: [recipient(1, { mergeValues: {} })] })), context);
    expect(response.status).toBe(400);
    expect(JSON.stringify(response.jsonBody)).toContain("Tenant name");
    expect(jobs.insertJob).not.toHaveBeenCalled();
  });
});

describe("queueCorrespondence: invalid input and failure", () => {
  it.each([["not JSON", "nope"], ["no recipients", request({ recipients: [] })], ["no subject", request({ subject: "" })], ["an unknown field in the wording", request({ bodyMarkdown: "Hi {{what.is.this}}" })]])("refuses %s", async (_name, body) => {
    expect((await queueCorrespondence(post(body), context)).status).toBe(400);
    expect(jobs.insertJob).not.toHaveBeenCalled();
  });

  it("turns away a flood of sends", async () => {
    let last = 0;
    for (let i = 0; i < 12; i += 1) last = (await queueCorrespondence(post(request()), context)).status ?? 0;
    expect(last).toBe(429);
  });

  it("answers 500 without the database's words", async () => {
    jobs.insertJob.mockRejectedValue(new Error("Violation of UNIQUE KEY constraint on dbo.Correspondence"));
    const response = await queueCorrespondence(post(request()), context);
    expect(response.status).toBe(500);
    expect(JSON.stringify(response.jsonBody)).not.toContain("UNIQUE");
  });
});

describe("previewCorrespondence", () => {
  const draft = (over: Record<string, unknown> = {}) => ({
    bodyMarkdown: "Dear {{tenant.name}},\n\nSee you {{today}}.", kind: "broadcast", recipient: recipient(1), replyTo: { identityId: 3, type: "identity" }, signatureMode: "role", subject: "Hello {{tenant.name}}", ...over,
  });

  it("renders one recipient's email as they will receive it, with the team signature and the reply-to", async () => {
    const response = await previewCorrespondence(post(draft()), context);
    expect(response.status).toBe(200);
    const body = response.jsonBody as { html: string; missing: unknown[]; ready: boolean; replyTo: unknown; subject: string; text: string };
    expect(body).toMatchObject({ missing: [], ready: true, replyTo: { address: "accounts@randazzo.properties", name: "Randazzo Accounts" }, subject: "Hello Tenant 1" });
    expect(body.html).toContain("Dear Tenant 1,");
    expect(body.html).toContain("Accounts team");
    expect(body.html).toContain("You are receiving this notice because you are a listed contact");
    expect(body.text).toContain("Kind regards,\nAccounts team");
    expect(jobs.insertJob).not.toHaveBeenCalled();
  });

  it("names a missing field and gives no email, rather than a blank one", async () => {
    const response = await previewCorrespondence(post(draft({ recipient: recipient(1, { mergeValues: {} }) })), context);
    expect(response.status).toBe(200);
    expect(response.jsonBody).toMatchObject({ html: null, missing: [{ label: "Tenant name", path: "tenant.name", reason: "blank" }], ready: false, text: null });
  });

  it("previews the personal signature", async () => {
    const body = (await previewCorrespondence(post(draft({ replyTo: { type: "own" }, signatureMode: "personal" })), context)).jsonBody as { text: string };
    expect(body.text).toContain("Kind regards,\nFay Facilities\nAccounts officer\nPhone 08 8900 0000\nfay@randazzo.properties");
  });

  it("applies the same reply-to and signature refusals as queueing", async () => {
    roles = [AppRole.FACILITIES];
    expect((await previewCorrespondence(post(draft()), context)).status).toBe(403);
    roles = [AppRole.ACCOUNTS];
    expect((await previewCorrespondence(post(draft({ signature: "x" })), context)).status).toBe(400);
  });

  it("refuses admin, a baseline user and no token", async () => {
    roles = [AppRole.ADMIN];
    expect((await previewCorrespondence(post(draft()), context)).status).toBe(403);
    roles = [AppRole.USER];
    expect((await previewCorrespondence(post(draft()), context)).status).toBe(403);
    token = null;
    expect((await previewCorrespondence(post(draft()), context)).status).toBe(401);
  });

  it("refuses bad input", async () => {
    expect((await previewCorrespondence(post("nope"), context)).status).toBe(400);
    expect((await previewCorrespondence(post(draft({ recipient: undefined })), context)).status).toBe(400);
  });

  describe("a saved send", () => {
    const saved = {
      approvedAt: null, approvedByName: null, approvedByOid: null, blockedCount: 0, bodyMarkdown: "Dear {{tenant.name}}", cancelledAt: null, cancelledByName: null, completedAt: null,
      correspondenceId: 41, createdAt: "x", createdByEmail: "fay@randazzo.properties", createdByName: "Fay Facilities", createdByOid: "fay-oid", createdByRole: "accounts", failedCount: 0,
      fromAddress: "notices@randazzo.properties", fromName: "Randazzo Properties", kind: "broadcast" as const, queuedAt: null, recipientCount: 1, replyToAddress: "accounts@randazzo.properties",
      replyToIdentityId: 3, replyToName: "Randazzo Accounts", requiresApproval: false, rowVersion: "00", sentCount: 0, signature: { email: null, lines: ["Accounts team"], phone: null },
      signatureMode: "role" as const, status: "queued" as const, subject: "Hi", templateId: null, templateVersion: null,
    };
    const savedRecipient = { address: "pat1@example.com", attempts: 0, correspondenceId: 41, detail: null, graphMessageId: null, internetMessageId: null, lastAttemptAt: null, lastErrorCode: null, mergeValues: { "tenant.name": "Acme" }, name: "Pat", nextAttemptAt: null, recipientId: 9, recipientRefId: "1", recipientType: "tenancy" as const, sentAt: null, sentToAddress: null, status: "queued" as const };

    it("previews the stored email for its creator", async () => {
      jobs.readJob.mockResolvedValue(saved);
      jobs.readRecipient.mockResolvedValue(savedRecipient);
      const response = await previewCorrespondence(post({ correspondenceId: 41, recipientId: 9 }), context);
      expect(response.status).toBe(200);
      expect((response.jsonBody as { html: string }).html).toContain("Dear Acme");
    });

    it("refuses someone else's send unless the caller is a manager, and 404s a missing one", async () => {
      roles = [AppRole.ACCOUNTS];
      jobs.readJob.mockResolvedValue({ ...saved, createdByOid: "someone-else" });
      expect((await previewCorrespondence(post({ correspondenceId: 41, recipientId: 9 }), context)).status).toBe(403);
      roles = [AppRole.ACCOUNTS_APPROVAL];
      jobs.readRecipient.mockResolvedValue(savedRecipient);
      expect((await previewCorrespondence(post({ correspondenceId: 41, recipientId: 9 }), context)).status).toBe(200);
      jobs.readJob.mockResolvedValue(null);
      expect((await previewCorrespondence(post({ correspondenceId: 41, recipientId: 9 }), context)).status).toBe(404);
    });
  });
});

describe("queueCorrespondence: the double-click guard", () => {
  const KEY = "0b9a7c5e-3f2d-4a61-9d1e-5c7b8a2f4e10";
  const db = jest.requireMock("../db") as { commitTransaction: jest.Mock; executeQuery: jest.Mock };

  it("queues once and notes the key when the key is new", async () => {
    db.executeQuery.mockResolvedValueOnce([{ Result: 0 }]).mockResolvedValueOnce([]);
    const response = await queueCorrespondence(post(request({ idempotencyKey: KEY })), context);
    expect(response.status).toBe(201);
    expect(response.jsonBody).toMatchObject({ correspondenceId: 41, repeated: false });
    expect(jest.mocked(events.appendEvent)).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ detail: `2 recipients key=${KEY}` }));
  });

  it("returns the job already made, queuing nothing, when the same person submits the same key again", async () => {
    db.executeQuery.mockResolvedValueOnce([{ Result: 0 }]).mockResolvedValueOnce([{ CorrespondenceId: 41 }]);
    jobs.readJob.mockResolvedValue({ blockedCount: 0, correspondenceId: 41, recipientCount: 2, status: "queued" } as never);
    const response = await queueCorrespondence(post(request({ idempotencyKey: KEY })), context);
    expect(response.status).toBe(200);
    expect(response.jsonBody).toMatchObject({ correspondenceId: 41, queued: 2, repeated: true, requiresApproval: false, status: "queued" });
    expect(jobs.insertJob).not.toHaveBeenCalled();
    expect(jobs.insertRecipient).not.toHaveBeenCalled();
    expect(jest.mocked(events.appendEvent)).not.toHaveBeenCalled();
    expect(jest.mocked(record)).not.toHaveBeenCalled();
    expect(db.commitTransaction).toHaveBeenCalledTimes(1);
  });

  it("looks for the key among the caller's own jobs only", async () => {
    db.executeQuery.mockResolvedValueOnce([{ Result: 0 }]).mockResolvedValueOnce([]);
    await queueCorrespondence(post(request({ idempotencyKey: KEY })), context);
    const lookup = db.executeQuery.mock.calls[1][2];
    expect(lookup).toEqual(expect.arrayContaining([expect.objectContaining({ name: "Oid", value: "fay-oid" })]));
  });

  it("does not look when there is no key, so existing callers behave as before", async () => {
    const response = await queueCorrespondence(post(request()), context);
    expect(response.status).toBe(201);
    expect(db.executeQuery).not.toHaveBeenCalled();
  });

  it.each(["short", "has spaces in it, which no key does", "x".repeat(65), 12345678901234567, ""])("refuses the malformed key %j", async (bad) => {
    const response = await queueCorrespondence(post(request({ idempotencyKey: bad })), context);
    expect(response.status).toBe(400);
    expect(jobs.insertJob).not.toHaveBeenCalled();
  });

  it("fails the queue, queuing nothing, when the lock can't be taken", async () => {
    db.executeQuery.mockResolvedValueOnce([{ Result: -1 }]);
    expect((await queueCorrespondence(post(request({ idempotencyKey: KEY })), context)).status).toBe(500);
    expect(jobs.insertJob).not.toHaveBeenCalled();
  });
});

describe("queueCorrespondence: a repeated submit and the 24 hour count", () => {
  const KEY = "0b9a7c5e-3f2d-4a61-9d1e-5c7b8a2f4e10";
  const db = jest.requireMock("../db") as { executeQuery: jest.Mock };

  it("returns the same job with the same reason on a repeat, and does not add its recipients to the total again", async () => {
    // First submit: 21 recipients, 4 already sent today, over the threshold of 20 by size.
    jobs.recentRecipientCount.mockResolvedValue(4);
    db.executeQuery.mockResolvedValueOnce([{ Result: 0 }]).mockResolvedValueOnce([]);
    const first = await queueCorrespondence(post(request({ idempotencyKey: KEY }, 21)), context);
    expect(first.status).toBe(201);
    expect(first.jsonBody).toMatchObject({ approvalReason: "size", correspondenceId: 41, recentRecipients: 4, repeated: false });
    expect(jobs.insertJob).toHaveBeenCalledTimes(1);

    // Repeat: the job exists now, so the stored total is 4 + 21. Nothing new is written.
    jobs.insertJob.mockClear();
    jobs.insertRecipient.mockClear();
    jobs.recentRecipientCount.mockClear();
    jobs.recentRecipientCount.mockResolvedValue(25);
    db.executeQuery.mockResolvedValueOnce([{ Result: 0 }]).mockResolvedValueOnce([{ CorrespondenceId: 41 }]);
    jobs.readJob.mockResolvedValue({ blockedCount: 0, correspondenceId: 41, createdByOid: "fay-oid", kind: "broadcast", recipientCount: 21, requiresApproval: true, status: "awaiting_approval" } as never);
    const again = await queueCorrespondence(post(request({ idempotencyKey: KEY }, 21)), context);
    expect(again.status).toBe(200);
    expect(again.jsonBody).toMatchObject({ approvalNote: (first.jsonBody as { approvalNote: string }).approvalNote, approvalReason: "size", correspondenceId: 41, recentRecipients: 4, repeated: true, requiresApproval: true, status: "awaiting_approval" });
    expect(jobs.insertJob).not.toHaveBeenCalled();
    expect(jobs.insertRecipient).not.toHaveBeenCalled();
    // The only count read is to say what the first answer said (25 stored less the job's own 21); it adds nothing.
    expect(jobs.recentRecipientCount).toHaveBeenCalledTimes(1);
  });

  it("does not let a repeat dodge the count: a different key from the same person is counted in full", async () => {
    jobs.recentRecipientCount.mockResolvedValue(18);
    db.executeQuery.mockResolvedValueOnce([{ Result: 0 }]).mockResolvedValueOnce([]);
    const response = await queueCorrespondence(post(request({ idempotencyKey: "1b9a7c5e-3f2d-4a61-9d1e-5c7b8a2f4e11" }, 5)), context);
    expect(response.jsonBody).toMatchObject({ approvalReason: "recent", recentRecipients: 18, repeated: false });
  });

  it("answers a repeat of a send that went straight to the queue with no approval note", async () => {
    db.executeQuery.mockResolvedValueOnce([{ Result: 0 }]).mockResolvedValueOnce([{ CorrespondenceId: 41 }]);
    jobs.recentRecipientCount.mockResolvedValue(2);
    jobs.readJob.mockResolvedValue({ blockedCount: 1, correspondenceId: 41, createdByOid: "fay-oid", kind: "broadcast", recipientCount: 2, requiresApproval: false, status: "queued" } as never);
    const response = await queueCorrespondence(post(request({ idempotencyKey: KEY })), context);
    expect(response.jsonBody).toMatchObject({ approvalNote: null, approvalReason: null, blocked: 1, queued: 1, repeated: true, requiresApproval: false });
  });
});

