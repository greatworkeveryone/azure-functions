import { HttpRequest, type InvocationContext } from "@azure/functions";
import { AppRole } from "../auth";
import * as events from "../comms/events";
import type { AdminIdentity } from "../comms/identityStore";
import * as identityStore from "../comms/identityStore";
import * as jobStore from "../comms/store";
import * as userStore from "../comms/userSignatureStore";
import { _resetRateLimitForTests } from "../rateLimit";
import { getBroadcastOptions } from "./getBroadcastOptions";
import { listCorrespondence } from "./listCorrespondence";
import { resolveBroadcastAudience } from "./resolveBroadcastAudience";
import { sendTestCorrespondence } from "./sendTestCorrespondence";

jest.mock("@azure/functions", () => ({ ...jest.requireActual("@azure/functions"), app: { http: jest.fn() } }));
let roles: string[] = [AppRole.FACILITIES_APPROVAL];
let token: string | null = "token";
jest.mock("../auth", () => ({
  ...jest.requireActual("../auth"),
  extractToken: () => token,
  requireRole: async (_r: unknown, allowed: string[]) => (jest.requireActual("../auth").rolesPassGate(roles, allowed) ? null : { status: 403 }),
  rolesForRequest: async () => roles,
  verifiedIdentityFromRequest: async () => (token ? { email: "Fay@Randazzo.Properties", name: "Fay Facilities", oid: "fay-oid" } : null),
}));
jest.mock("../db", () => ({
  beginTransaction: jest.fn().mockResolvedValue(undefined),
  closeConnection: jest.fn(),
  commitTransaction: jest.fn().mockResolvedValue(undefined),
  createRequestConnection: jest.fn(async () => ({})),
  executeQuery: jest.fn(),
  rollbackTransaction: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../buildingCategoryColumn", () => ({ buildingCategoryColumnExists: jest.fn().mockResolvedValue(true) }));
jest.mock("../ledger", () => ({ record: jest.fn() }));
jest.mock("../comms/events", () => ({ appendEvent: jest.fn(), readEvents: jest.fn() }));
jest.mock("../comms/store", () => ({ insertJob: jest.fn(), insertRecipient: jest.fn(), readJob: jest.fn(), readRecipient: jest.fn(), recentRecipientCount: jest.fn() }));
jest.mock("../comms/identityStore", () => ({ ...jest.requireActual("../comms/identityStore"), readIdentity: jest.fn() }));
jest.mock("../comms/userSignatureStore", () => ({ findUserByOid: jest.fn(), readUserSignature: jest.fn() }));

const db = jest.requireMock("../db") as { executeQuery: jest.Mock };
const idStore = { ...jest.mocked(identityStore), ...jest.mocked(userStore) };
const jobs = jest.mocked(jobStore);
const context = { error: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;
const post = (body: unknown) => new HttpRequest({ body: { string: JSON.stringify(body) }, headers: { "Content-Type": "application/json" }, method: "POST", url: "http://localhost/api/x" });
const get = (query = "") => new HttpRequest({ method: "GET", url: `http://localhost/api/x${query}` });

const tenancyRow = (id: number, over: Record<string, unknown> = {}) => ({
  AccountsEmail: null, BuildingAddress: "1 Smith St", BuildingId: 5, BuildingName: "Mooney Plaza", Category: "commercial", Commencement: null, Expiry: null, IsTest: 0,
  LegalName: `Tenant ${id}`, NextReviewDate: null, PrimaryContactEmail: `t${id}@example.com`, PrimaryContactName: `Pat ${id}`, TenantId: id, ...over,
});

function answerSql(rows: { tenancies?: Record<string, unknown>[]; occupancies?: Record<string, unknown>[]; testContacts?: Record<string, unknown>[] } = {}) {
  db.executeQuery.mockImplementation(async (_c: unknown, sql: string) => {
    if (/FROM dbo\.Tenants t\s+JOIN dbo\.Buildings/.test(sql)) return rows.tenancies ?? [];
    if (/FROM dbo\.TenantOccupancies o\s+WHERE/.test(sql)) return rows.occupancies ?? [];
    if (/Matches FROM dbo\.AppUsers WHERE UserID/.test(sql)) return [{ Matches: 1 }];
    if (/FROM dbo\.Tenants WHERE IsTest = 1/.test(sql)) return rows.testContacts ?? [];
    return [];
  });
}

beforeEach(() => {
  jest.resetAllMocks();
  _resetRateLimitForTests();
  roles = [AppRole.FACILITIES_APPROVAL];
  token = "token";
  delete process.env.COMMS_APPROVAL_THRESHOLD;
  const connection = jest.requireMock("../db") as { createRequestConnection: jest.Mock; beginTransaction: jest.Mock; commitTransaction: jest.Mock };
  connection.createRequestConnection.mockResolvedValue({});
  connection.beginTransaction.mockResolvedValue(undefined);
  connection.commitTransaction.mockResolvedValue(undefined);
  jest.requireMock("../buildingCategoryColumn").buildingCategoryColumnExists.mockResolvedValue(true);
  answerSql();
});

describe("resolveBroadcastAudience", () => {
  const body = { tenancies: { selections: [{ buildingId: 5 }] } };

  it.each([AppRole.FACILITIES_APPROVAL, AppRole.ACCOUNTS_APPROVAL, AppRole.CFO, AppRole.DIRECTOR, AppRole.ADMIN])("lets %s resolve an audience", async (role) => {
    roles = [role];
    expect((await resolveBroadcastAudience(post(body), context)).status).toBe(200);
  });

  it.each([AppRole.FACILITIES, AppRole.ACCOUNTS, AppRole.USER])("refuses %s before reading anything", async (role) => {
    roles = [role];
    expect((await resolveBroadcastAudience(post(body), context)).status).toBe(403);
    expect(db.executeQuery).not.toHaveBeenCalled();
  });

  it("refuses a request with no token", async () => {
    token = null;
    expect((await resolveBroadcastAudience(post(body), context)).status).toBe(401);
  });

  it.each([{}, { tenancies: { selections: [] } }, { staff: { roles: ["janitor"] } }, { typed: "a@x.com" }, { tenancies: { selections: [{ buildingId: 5 }] }, from: "x" }])("refuses invalid input %j", async (bad) => {
    expect((await resolveBroadcastAudience(post(bad), context)).status).toBe(400);
    expect(db.executeQuery).not.toHaveBeenCalled();
  });

  it("refuses a body that is not JSON", async () => {
    const response = await resolveBroadcastAudience(new HttpRequest({ body: { string: "nope" }, method: "POST", url: "http://localhost/api/x" }), context);
    expect(response.status).toBe(400);
  });

  it("returns de-duplicated recipients with counts and what was left out, and writes nothing", async () => {
    answerSql({
      occupancies: [{ Area: "Suite 1", BuildingId: 5, Level: "Level 2", TenantId: 1 }],
      tenancies: [tenancyRow(1), tenancyRow(2, { PrimaryContactEmail: "T1@example.com" }), tenancyRow(3, { PrimaryContactEmail: null }), tenancyRow(4, { IsTest: 1 })],
    });
    const response = await resolveBroadcastAudience(post({ tenancies: { contacts: ["primary"], selections: [{ buildingId: 5 }] }, typed: ["nope"] }), context);
    expect(response.status).toBe(200);
    const audience = response.jsonBody as { counts: Record<string, number>; excluded: { reason: string }[]; recipients: { address: string; mergeValues: Record<string, string> }[] };
    expect(audience.recipients.map((r) => r.address)).toEqual(["t1@example.com"]);
    expect(audience.recipients[0].mergeValues["tenant.suite"]).toBe("Level 2, Suite 1");
    expect(audience.counts).toMatchObject({ duplicatesMerged: 1, tenancy: 1, total: 1 });
    expect(audience.excluded.map((e) => e.reason).sort()).toEqual(["invalid_address", "no_address", "test_record"]);
    const writes = db.executeQuery.mock.calls.filter(([, sql]) => /\b(INSERT|UPDATE|DELETE)\b/i.test(String(sql)));
    expect(writes).toEqual([]);
  });

  it("only reads active, unarchived tenancies and binds the buildings as a parameter", async () => {
    await resolveBroadcastAudience(post(body), context);
    const [, sql, params] = db.executeQuery.mock.calls[0];
    expect(sql).toContain("t.ArchivedAt IS NULL AND t.Status IN ('current', 'holdover')");
    expect(JSON.parse(params[0].value)).toEqual([5]);
  });

  it("lists a typed address that is a test tenancy's contact as a test record, since the server would refuse it", async () => {
    answerSql({ testContacts: [{ Address: "demo@test.example" }] });
    const response = await resolveBroadcastAudience(post({ typed: ["Demo@Test.example", "real@x.com"] }), context);
    const audience = response.jsonBody as { excluded: { address: string; reason: string }[]; recipients: { address: string; recipientRefId: string | null; recipientType: string }[] };
    expect(audience.recipients).toEqual([expect.objectContaining({ address: "real@x.com", recipientRefId: null, recipientType: "manual" })]);
    expect(audience.excluded).toEqual([expect.objectContaining({ address: "demo@test.example", reason: "test_record" })]);
  });

  it("gives tenancy, contractor and staff recipients their record id and stored address, and a typed one no id", async () => {
    db.executeQuery.mockImplementation(async (_c: unknown, sql: string) => {
      if (/FROM dbo\.Tenants t\s+JOIN dbo\.Buildings/.test(sql)) return [tenancyRow(1)];
      if (/FROM dbo\.Contractors/.test(sql)) return [{ ContractorID: 8, ContractorName: "Sparks", EmailAddress: "Sam@Sparks.example" }];
      if (/FROM dbo\.ContractorCoverage/.test(sql)) return [{ ContractorId: 8, CoverageJson: JSON.stringify({ trades: ["Electrical"] }) }];
      if (/FROM dbo\.AppUsers/.test(sql)) return [{ DisplayName: "Zed", Email: "Zed@Randazzo.Properties", Role: "director", UserID: 3 }];
      return [];
    });
    const response = await resolveBroadcastAudience(post({ contractors: { trades: ["Electrical"] }, staff: { roles: ["director"] }, tenancies: { contacts: ["primary"], selections: [{ buildingId: 5 }] }, typed: ["x@y.com"] }), context);
    const { recipients } = response.jsonBody as { recipients: { address: string; recipientRefId: string | null; recipientType: string }[] };
    expect(recipients.map((entry) => [entry.recipientType, entry.recipientRefId, entry.address])).toEqual([
      ["tenancy", "1", "t1@example.com"],
      ["contractor", "8", "sam@sparks.example"],
      ["staff", "3", "zed@randazzo.properties"],
      ["manual", null, "x@y.com"],
    ]);
  });

  it("asks for contractors by trade and staff by role", async () => {
    db.executeQuery.mockImplementation(async (_c: unknown, sql: string) => {
      if (/FROM dbo\.Contractors/.test(sql)) return [{ ContactFirstName: "Sam", ContactLastName: "Spark", ContractorID: 1, ContractorName: "Sparks", EmailAddress: "sam@sparks.example" }];
      if (/FROM dbo\.ContractorCoverage/.test(sql)) return [{ ContractorId: 1, CoverageJson: JSON.stringify({ regions: [], trades: ["Electrical"] }) }];
      if (/FROM dbo\.AppUsers/.test(sql)) return [{ DisplayName: "Zed", Email: "zed@randazzo.properties", Role: "director", UserID: 3 }];
      return [];
    });
    const response = await resolveBroadcastAudience(post({ contractors: { trades: ["electrical"] }, staff: { roles: ["director"] } }), context);
    expect((response.jsonBody as { counts: Record<string, number> }).counts).toMatchObject({ contractor: 1, staff: 1, total: 2 });
  });

  it("reports a failed read without the database's words", async () => {
    db.executeQuery.mockRejectedValue(new Error("Login failed for secret-user"));
    const response = await resolveBroadcastAudience(post(body), context);
    expect(response.status).toBe(500);
    expect(JSON.stringify(response.jsonBody)).not.toContain("secret-user");
  });
});

describe("getBroadcastOptions", () => {
  it.each([AppRole.FACILITIES, AppRole.ACCOUNTS, AppRole.USER])("refuses %s", async (role) => {
    roles = [role];
    expect((await getBroadcastOptions(get(), context)).status).toBe(403);
  });

  it("refuses no token", async () => {
    token = null;
    expect((await getBroadcastOptions(get(), context)).status).toBe(401);
  });

  it("offers buildings with their levels, trades from both sources, roles with people and the approvers other than the caller", async () => {
    db.executeQuery.mockImplementation(async (_c: unknown, sql: string) => {
      if (/FROM dbo\.Buildings/.test(sql)) return [{ BuildingID: 5, BuildingName: "Mooney Plaza", Category: "commercial" }, { BuildingID: 2, BuildingName: "Alpha House", Category: "residence" }];
      if (/DISTINCT o\.BuildingId/.test(sql)) return [{ BuildingId: 5, Level: "Level 10" }, { BuildingId: 5, Level: "Level 2" }, { BuildingId: 5, Level: "Ground" }];
      if (/ContractorCoverage/.test(sql)) return [{ Json: JSON.stringify({ regions: [], trades: ["Electrical", "Plumbing"] }) }];
      if (/MaintenanceCoverage/.test(sql)) return [{ Json: JSON.stringify([{ contractorIds: [1], required: true, trade: "electrical" }, { contractorIds: [], required: false, trade: "Lifts" }]) }];
      if (/GROUP BY/.test(sql)) return [{ N: 3, Role: "facilities" }, { N: 1, Role: "user" }, { N: 1, Role: "director" }];
      if (/DisplayName, LOWER\(Role\)/.test(sql)) return [{ DisplayName: "Zed", Role: "director" }];
      return [];
    });
    jest.mocked(jobStore.recentRecipientCount).mockResolvedValue(12);
    const response = await getBroadcastOptions(get(), context);
    expect(jobStore.recentRecipientCount).toHaveBeenCalledWith(expect.anything(), "fay-oid", false);
    expect(response.jsonBody).toEqual({
      approvalThreshold: 20,
      approvers: [{ name: "Zed", role: "director" }],
      buildings: [
        { buildingId: 2, category: "residence", levels: [], name: "Alpha House" },
        { buildingId: 5, category: "commercial", levels: ["Ground", "Level 2", "Level 10"], name: "Mooney Plaza" },
      ],
      recentRecipients: 12,
      staffRoles: [{ count: 1, role: "director" }, { count: 3, role: "facilities" }],
      trades: ["Electrical", "Lifts", "Plumbing"],
    });
    const approverCall = db.executeQuery.mock.calls.find(([, sql]) => /EntraOid <> @Oid/.test(String(sql)));
    expect(approverCall?.[2]).toEqual(expect.arrayContaining([expect.objectContaining({ name: "Oid", value: "fay-oid" })]));
    expect(JSON.parse(approverCall?.[2][0].value)).not.toContain("admin");
  });

  it("reports the configured threshold", async () => {
    process.env.COMMS_APPROVAL_THRESHOLD = "5";
    jest.mocked(jobStore.recentRecipientCount).mockResolvedValue(0);
    expect((await getBroadcastOptions(get(), context)).jsonBody).toMatchObject({ approvalThreshold: 5 });
  });
});

describe("listCorrespondence", () => {
  it("shows a manager everyone's broadcasts, newest first, without wording", async () => {
    db.executeQuery.mockResolvedValue([]);
    const response = await listCorrespondence(get(), context);
    expect(response.status).toBe(200);
    const [, sql, params] = db.executeQuery.mock.calls[0];
    expect(sql).toContain("ORDER BY c.CorrespondenceId DESC");
    expect(params).toEqual(expect.arrayContaining([expect.objectContaining({ name: "Kind", value: "broadcast" }), expect.objectContaining({ name: "Oid", value: null })]));
  });

  it("shows someone who is not a manager only their own", async () => {
    roles = [AppRole.ACCOUNTS];
    db.executeQuery.mockResolvedValue([]);
    await listCorrespondence(get(), context);
    expect(db.executeQuery.mock.calls[0][2]).toEqual(expect.arrayContaining([expect.objectContaining({ name: "Oid", value: "fay-oid" })]));
  });

  it("strips the wording and signature from each item", async () => {
    db.executeQuery.mockResolvedValue([
      { ApprovedAt: null, BlockedCount: 0, BodyMarkdown: "secret words", CorrespondenceId: 9, CreatedAt: new Date("2026-10-24T01:00:00Z"), CreatedByEmail: "a@b", CreatedByName: "A", CreatedByOid: "o", FailedCount: 0, FromAddress: "n@r", FromName: "RP", Kind: "broadcast", RecipientCount: 3, ReplyToAddress: "r@r", RequiresApproval: 0, RowVersion: "01", SentCount: 1, SignatureJson: "{}", SignatureMode: "role", Status: "sending", Subject: "Water" },
    ]);
    const { items } = (await listCorrespondence(get("?limit=10"), context)).jsonBody as { items: Record<string, unknown>[] };
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ correspondenceId: 9, recipientCount: 3, sentCount: 1, status: "sending", subject: "Water" });
    expect(JSON.stringify(items)).not.toContain("secret words");
    expect(items[0]).not.toHaveProperty("signature");
  });

  it.each(["?kind=system", "?limit=0", "?limit=101", "?limit=abc"])("refuses %s", async (query) => {
    expect((await listCorrespondence(get(query), context)).status).toBe(400);
  });

  it.each([AppRole.USER])("refuses %s, and no token", async (role) => {
    roles = [role];
    expect((await listCorrespondence(get(), context)).status).toBe(403);
    token = null;
    expect((await listCorrespondence(get(), context)).status).toBe(401);
  });
});

describe("sendTestCorrespondence", () => {
  const identity = (): AdminIdentity => ({
    address: "facilities@randazzo.properties", allowedRoles: [AppRole.FACILITIES], archivedAt: null, archivedBy: null, createdAt: "2026-10-24T00:00:00.000Z",
    createdBy: "Will", displayName: "Randazzo Facilities", identityId: 3, isActive: true, rowVersion: "01",
    signature: { email: "facilities@randazzo.properties", lines: ["Facilities team"], phone: null }, teamLabel: "Facilities", updatedAt: null, updatedBy: null,
  });
  const request = (over: Record<string, unknown> = {}) => ({
    bodyMarkdown: "Dear {{recipient.name}},\n\nWater is off at {{building.name}} on Tuesday.",
    kind: "broadcast",
    recipient: { address: "pat@acme.example", mergeValues: { "building.name": "Mooney Plaza" }, name: "Pat Smith", recipientRefId: "44", recipientType: "tenancy" },
    replyTo: { identityId: 3, type: "identity" },
    signatureMode: "role",
    subject: "Water shut-off",
    ...over,
  });

  beforeEach(() => {
    idStore.readIdentity.mockResolvedValue(identity());
    idStore.findUserByOid.mockResolvedValue({ displayName: "Fay Facilities", email: "Fay@Randazzo.Properties", userId: 7 });
    idStore.readUserSignature.mockResolvedValue({ jobTitle: null, phone: null, updatedAt: null });
    jobs.insertJob.mockResolvedValue(77);
    jobs.insertRecipient.mockResolvedValue(1);
  });

  it("queues one message to the caller's own stored address, never the recipient's, as a system send with a [Test] subject", async () => {
    const response = await sendTestCorrespondence(post(request()), context);
    expect(response.status).toBe(201);
    expect(response.jsonBody).toEqual({ correspondenceId: 77, sentTo: "fay@randazzo.properties", status: "queued" });
    const job = jobs.insertJob.mock.calls[0][1];
    expect(job.kind).toBe("system");
    expect(job.subject).toBe("[Test] Water shut-off");
    expect(job.recipients).toHaveLength(1);
    expect(job.recipients[0]).toMatchObject({ address: "fay@randazzo.properties", name: "Pat Smith", recipientRefId: "7", recipientType: "staff" });
    expect(jobs.insertRecipient).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(jobs.insertRecipient.mock.calls)).not.toContain("pat@acme.example");
  });

  it("is outside the 24 hour count: it neither reads the creator's total nor waits for approval after a big send", async () => {
    jest.mocked(jobStore.recentRecipientCount).mockResolvedValue(500);
    process.env.COMMS_APPROVAL_THRESHOLD = "20";
    const response = await sendTestCorrespondence(post(request()), context);
    expect(response.jsonBody).toMatchObject({ status: "queued" });
    expect(jobStore.recentRecipientCount).not.toHaveBeenCalled();
    expect(jobs.insertJob.mock.calls[0][2]).toBe("queued");
  });

  it("asks the server's records about its own address, as a send does, and refuses when they say no", async () => {
    db.executeQuery.mockImplementation(async (_c: unknown, sql: string) => (/Matches FROM dbo\.AppUsers WHERE UserID/.test(sql) ? [{ Matches: 0 }] : []));
    const response = await sendTestCorrespondence(post(request()), context);
    expect(response.status).toBe(400);
    expect(JSON.stringify(response.jsonBody)).toContain("recorded contact");
    expect(jobs.insertJob).not.toHaveBeenCalled();
  });

  it("is never held for approval, even when the threshold is zero", async () => {
    process.env.COMMS_APPROVAL_THRESHOLD = "0";
    expect((await sendTestCorrespondence(post(request()), context)).jsonBody).toMatchObject({ status: "queued" });
    expect(jobs.insertJob.mock.calls[0][2]).toBe("queued");
  });

  it("refuses a request that names where to send it", async () => {
    for (const extra of [{ to: "boss@x.com" }, { address: "boss@x.com" }, { recipients: [{ address: "a@b.com" }] }]) {
      expect((await sendTestCorrespondence(post(request(extra)), context)).status).toBe(400);
    }
    expect(jobs.insertJob).not.toHaveBeenCalled();
  });

  it("refuses a saved send: a test is of the email as written", async () => {
    expect((await sendTestCorrespondence(post({ correspondenceId: 1, recipientId: 2 }), context)).status).toBe(400);
  });

  it("says what is missing instead of sending a test with a hole in it", async () => {
    const response = await sendTestCorrespondence(post(request({ recipient: { address: "pat@acme.example", mergeValues: {}, name: null, recipientRefId: "44", recipientType: "tenancy" } })), context);
    expect(response.status).toBe(400);
    expect(JSON.stringify(response.jsonBody)).toContain("Building name");
    expect(jobs.insertJob).not.toHaveBeenCalled();
  });

  it("refuses when the caller has no staff record to send the test to", async () => {
    idStore.findUserByOid.mockResolvedValue(null);
    expect((await sendTestCorrespondence(post(request()), context)).status).toBe(403);
    expect(jobs.insertJob).not.toHaveBeenCalled();
  });

  it("refuses admin (sends nothing real), a baseline user and no token", async () => {
    for (const role of [AppRole.ADMIN, AppRole.USER]) {
      roles = [role];
      expect((await sendTestCorrespondence(post(request()), context)).status).toBe(403);
    }
    token = null;
    expect((await sendTestCorrespondence(post(request()), context)).status).toBe(401);
    expect(jobs.insertJob).not.toHaveBeenCalled();
  });

  it("refuses a reply-to the role may not use", async () => {
    roles = [AppRole.ACCOUNTS];
    expect((await sendTestCorrespondence(post(request()), context)).status).toBe(403);
    expect(jobs.insertJob).not.toHaveBeenCalled();
  });

  it("limits tests to five a minute", async () => {
    for (let i = 0; i < 5; i += 1) await sendTestCorrespondence(post(request()), context);
    expect((await sendTestCorrespondence(post(request()), context)).status).toBe(429);
  });

  it("writes the job, event and ledger row in one transaction", async () => {
    await sendTestCorrespondence(post(request()), context);
    expect(jest.mocked(events.appendEvent)).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ correspondenceId: 77, type: "job" }));
  });
});
