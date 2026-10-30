/// <reference types="jest" />
// D4 (DL-04, DL-19; database-safety rule 1): a tenancy, and a lease document,
// is archived — reversible, stamped and ledgered — never hard-deleted. The one
// hard delete left is an empty draft (no schedule rows, areas, documents or jobs).
import { HttpRequest, InvocationContext } from "@azure/functions";

type Handler = (req: HttpRequest, ctx: InvocationContext) => Promise<{ status: number; jsonBody?: any }>;

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  const g = globalThis as unknown as { __d4Handlers?: Record<string, Handler> };
  g.__d4Handlers = g.__d4Handlers ?? {};
  return {
    ...actual,
    app: { ...actual.app, http: (name: string, opts: { handler: Handler }) => void ((g.__d4Handlers as Record<string, Handler>)[name] = opts.handler), timer: jest.fn() },
  };
});
jest.mock("../auth", () => ({
  ...jest.requireActual("../auth"),
  extractToken: jest.fn().mockReturnValue("tok"),
  oidFromToken: jest.fn().mockReturnValue("ann-oid"),
  requireRole: jest.fn().mockResolvedValue(null),
  verifiedIdentityFromRequest: jest.fn().mockResolvedValue({ email: "ann@rp", name: "Ann Accounts", oid: "ann-oid" }),
}));
// Migration 136 is applied here: the portfolio figures take their commercial-only SQL (portfolioOccupancy.residences.test.ts covers the probe).
jest.mock("../buildingCategoryColumn", () => ({ buildingCategoryColumnExists: jest.fn().mockResolvedValue(true), resetBuildingCategoryColumnProbe: jest.fn() }));
jest.mock("../db", () => ({
  beginTransaction: jest.fn().mockResolvedValue(undefined),
  closeConnection: jest.fn(),
  commitTransaction: jest.fn().mockResolvedValue(undefined),
  createRequestConnection: jest.fn().mockResolvedValue({}),
  executeQuery: jest.fn(),
  rollbackTransaction: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../tenant-register-cache", () => ({
  getCachedTenantDetail: jest.fn().mockReturnValue(null),
  getCachedTenantList: jest.fn().mockReturnValue(null),
  invalidateTenant: jest.fn(),
  invalidateTenantAndBuilding: jest.fn(),
  setCachedTenantDetail: jest.fn(),
  setCachedTenantList: jest.fn(),
}));
jest.mock("../planner", () => ({ resolveActivePlannerTasks: jest.fn().mockResolvedValue(undefined) }));
jest.mock("../blob-storage", () => ({ generateReadSasUrl: jest.fn().mockReturnValue("sas"), uploadBlob: jest.fn() }));
jest.mock("../ledger");
jest.mock("../ledger/actor", () => ({
  resolveLedgerActor: jest.fn().mockResolvedValue({ kind: "user", name: "Ann Accounts", role: "accounts_manager", userId: 7 }),
}));

import { AppRole } from "../auth";
import { defaultLeaseAdministration } from "../leaseAdministrationLogic";

const auth = jest.requireMock("../auth") as { requireRole: jest.Mock };
const db = jest.requireMock("../db") as Record<"beginTransaction" | "commitTransaction" | "executeQuery" | "rollbackTransaction", jest.Mock>;
const cache = jest.requireMock("../tenant-register-cache") as { invalidateTenant: jest.Mock };
const ledger = jest.requireMock("../ledger") as { record: jest.Mock };

require("./tenancy");
require("./tenants");
require("./tenancyAttachments");
require("./archiveTenant");
require("./unarchiveTenant");
require("./archiveTenancyDocument");
const handlers = (globalThis as unknown as { __d4Handlers: Record<string, Handler> }).__d4Handlers;

const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;
const post = (body: unknown, query: Record<string, string> = {}) =>
  ({ headers: { get: () => null }, json: async () => body, query: new URLSearchParams(query) }) as unknown as HttpRequest;

let tenant: Record<string, unknown> | null;
let tenantRow: Record<string, unknown> | null;
let optional: Record<string, unknown>;
let documentRow: Record<string, unknown> | null;
// The tenancy row as stored: a draft with a name and a building, nothing else filled in (S1-2).
const BLANK_COLUMNS = [
  "Abn", "AccountsEmail", "AccountsPhone", "Acn", "BusinessTenanciesAct", "CarparkScheduleGroups", "Comments", "CpiCapPercent", "CpiFloorPercent",
  "CpiReferenceQuarterRule", "CpiRegion", "EscalationPercent", "EscalationSchedule", "Expiry", "FixedReviewPercent", "HoldoverTerms", "IdNo",
  "Incentives", "InformationSheetAsAt", "InformationSheetReference", "InfoSheetSections", "LastReviewDate", "LastReviewIncreasePercent",
  "LeaseAdministration", "LeaseType", "Lot", "MiscFees", "NextReviewDate", "OptionNoticeMonths", "OptionPeriods", "PostalAddress",
  "PrimaryContactEmail", "PrimaryContactName", "PrimaryContactPhone", "RenewalLetterIssueBy", "RentPerAnnum", "RentReliefs", "ReviewIntervalMonths",
  "ScheduledRateSteps", "SecurityDepositHeld", "SecurityDepositMethod", "SecurityDepositRequired", "SecurityDepositSteps", "StreetAddress", "TermMonths", "TradingName", "OptionsTotal", "OptionsRemaining", "OptionTermMonths",
];
const blankRow = (): Record<string, unknown> => ({
  ...Object.fromEntries(BLANK_COLUMNS.map((column) => [column, null])),
  ArchivedAt: null,
  ArchivedBy: null,
  BuildingId: 3,
  Commencement: null,
  CreatedAt: new Date("2026-10-01T00:00:00Z"),
  CreatedById: "ann-oid",
  CreatedByName: "Ann Accounts",
  EmailOnly: false,
  InfoSheetVersion: 0,
  IsTest: false,
  LegalName: "Acme Pty Ltd",
  MyobId: null,
  ReviewRatchet: false,
  ReviewType: "none",
  RowVersion: Buffer.from("0000000000000a01", "hex"),
  ScheduleSignedOffAt: null,
  ScheduleVersion: 0,
  Status: "current",
  TenantId: 7,
  UpdatedAt: new Date("2026-10-01T00:00:00Z"),
  UpdatedById: "ann-oid",
  UpdatedByName: "Ann Accounts",
});
beforeEach(() => {
  jest.clearAllMocks();
  auth.requireRole.mockResolvedValue(null);
  tenant = {
    ArchivedAt: null,
    BuildingId: 3,
    Carparks: 0,
    Decisions: 0,
    Documents: 0,
    Jobs: 0,
    Keys: 0,
    LegalName: "Acme Pty Ltd",
    Notes: 0,
    Occupancies: 0,
    OccupancyHistory: 0,
    RentReviews: 0,
    ScheduleChanges: 0,
    Vacancies: 0,
  };
  tenantRow = blankRow();
  optional = { ChangeRequests: 0, DefectsPeriods: 0, LeaseEvents: 0, RegisterDocuments: 0, SignedOff: 0, Contacts: 0, Links: 0, Notices: 0, Photos: 0, Responsibilities: 0 };
  documentRow = { ArchivedAt: null, OriginalName: "lease.pdf" };
  db.executeQuery.mockImplementation(async (_c: unknown, sql: string) => {
    if (/SELECT \* FROM dbo\.Tenants WITH \(UPDLOCK, HOLDLOCK\)/.test(sql)) return tenantRow ? [tenantRow] : [];
    if (/FROM dbo\.Tenants t WITH \(UPDLOCK, HOLDLOCK\)/.test(sql)) return tenant ? [tenant] : [];
    if (/ScheduleSignedOffAt/.test(sql)) return [optional];
    if (/FROM dbo\.TenancyAttachments ta WITH \(UPDLOCK, HOLDLOCK\)/.test(sql)) return documentRow ? [documentRow] : [];
    return [];
  });
});

const sqlOf = (pattern: RegExp) =>
  db.executeQuery.mock.calls.map((c: unknown[]) => String(c[1])).find((sql: string) => pattern.test(sql)) ?? "";
const ran = (pattern: RegExp) => sqlOf(pattern) !== "";
const order = (pattern: RegExp) => {
  const i = db.executeQuery.mock.calls.findIndex((c: unknown[]) => pattern.test(String(c[1])));
  return db.executeQuery.mock.invocationCallOrder[i];
};

describe("archiveTenant / unarchiveTenant", () => {
  it("are for accounts_manager and above (cfo, director, admin through the hierarchy)", async () => {
    await handlers.archiveTenant(post({ Reason: "Lease ended", TenantId: 7 }), ctx);
    await handlers.unarchiveTenant(post({ Reason: "Archived by mistake", TenantId: 7 }), ctx);
    expect(auth.requireRole.mock.calls.map((c: unknown[]) => c[1])).toEqual([[AppRole.ACCOUNTS_APPROVAL], [AppRole.ACCOUNTS_APPROVAL]]);
  });

  it("refuse other roles before touching the database", async () => {
    auth.requireRole.mockResolvedValue({ jsonBody: { error: "Forbidden" }, status: 403 });
    expect((await handlers.archiveTenant(post({ Reason: "x", TenantId: 7 }), ctx)).status).toBe(403);
    expect(db.executeQuery).not.toHaveBeenCalled();
  });

  it.each([{ TenantId: 7 }, { Reason: "   ", TenantId: 7 }, { Reason: "Lease ended" }])("need a tenancy and a reason: %p → 400", async (body) => {
    expect((await handlers.archiveTenant(post(body), ctx)).status).toBe(400);
    expect(db.executeQuery).not.toHaveBeenCalled();
  });

  it("archive stamps who and when, ledgers it with the reason, all in one transaction", async () => {
    const res = await handlers.archiveTenant(post({ Reason: "Lease ended, keys returned", TenantId: 7 }), ctx);
    expect(res.status).toBe(200);
    const update = sqlOf(/UPDATE dbo\.Tenants SET ArchivedAt/);
    expect(update).toMatch(/ArchivedAt = SYSUTCDATETIME\(\), ArchivedBy = @By/);
    expect(update).toMatch(/WHERE TenantId = @Id AND ArchivedAt IS NULL/);
    expect(ledger.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "tenancy.archive", reason: "Lease ended, keys returned", subject: { id: 7, type: "tenancy" } }),
    );
    expect(order(/UPDATE dbo\.Tenants SET ArchivedAt/)).toBeGreaterThan(db.beginTransaction.mock.invocationCallOrder[0]);
    expect(ledger.record.mock.invocationCallOrder[0]).toBeLessThan(db.commitTransaction.mock.invocationCallOrder[0]);
    expect(cache.invalidateTenant).toHaveBeenCalledWith(7);
  });

  it("archive answers 404 for an unknown tenancy and 409 for one already archived, writing nothing", async () => {
    tenant = null;
    expect((await handlers.archiveTenant(post({ Reason: "x", TenantId: 7 }), ctx)).status).toBe(404);
    tenant = { ArchivedAt: new Date(), BuildingId: 3, LegalName: "Acme Pty Ltd" };
    expect((await handlers.archiveTenant(post({ Reason: "x", TenantId: 7 }), ctx)).status).toBe(409);
    expect(ran(/UPDATE dbo\.Tenants/)).toBe(false);
    expect(ledger.record).not.toHaveBeenCalled();
  });

  it("unarchive clears the stamp and ledgers it; 409 when the tenancy isn't archived", async () => {
    tenant = { ArchivedAt: new Date(), BuildingId: 3, LegalName: "Acme Pty Ltd" };
    expect((await handlers.unarchiveTenant(post({ Reason: "Archived by mistake", TenantId: 7 }), ctx)).status).toBe(200);
    expect(sqlOf(/UPDATE dbo\.Tenants SET ArchivedAt = NULL/)).toMatch(/WHERE TenantId = @Id AND ArchivedAt IS NOT NULL/);
    expect(ledger.record).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "tenancy.unarchive", reason: "Archived by mistake" }));
    tenant = { ArchivedAt: null, BuildingId: 3, LegalName: "Acme Pty Ltd" };
    expect((await handlers.unarchiveTenant(post({ Reason: "x", TenantId: 7 }), ctx)).status).toBe(409);
  });
});

// A hard delete cascades (RentReviews, RentScheduleChangeLog, TenancyAttachments,
// occupancies, notes, history) and strands DecisionLedger rows, so it is allowed
// only for a tenancy nothing has been recorded against. Each condition below is
// tested on its own so that dropping any one of them fails.
const DRAFT_HOLDINGS: [string, Record<string, unknown>, string][] = [
  ["occupancies", { Occupancies: 2 }, "2 areas"],
  ["occupancy history", { OccupancyHistory: 1 }, "area history"],
  ["notes", { Notes: 1 }, "1 note"],
  ["rent reviews", { RentReviews: 1 }, "1 rent review"],
  ["rent schedule change log rows", { ScheduleChanges: 4 }, "rent schedule history"],
  ["lease documents", { Documents: 1 }, "1 document"],
  ["keys", { Keys: 2 }, "2 keys"],
  ["vacancies", { Vacancies: 1 }, "1 vacancy"],
  ["car parks", { Carparks: 3 }, "3 car parks"],
  ["decision ledger rows", { Decisions: 1 }, "decision history"],
  ["a schedule sign-off", { SignedOff: 1 }, "a schedule sign-off"],
  ["defects periods", { DefectsPeriods: 2 }, "2 defects periods"],
  ["schedule change requests", { ChangeRequests: 1 }, "1 schedule change request"],
  ["documentation register entries", { RegisterDocuments: 2 }, "2 documentation register entries"],
  ["option or renewal records", { LeaseEvents: 2 }, "2 option or renewal records"],
  ["tenant notices", { Notices: 2 }, "2 tenant notices"],
  ["maintenance responsibilities", { Responsibilities: 2 }, "2 maintenance responsibilities"],
  ["tenant request photos", { Photos: 3 }, "3 tenant request photos"],
  ["contact or personal link records", { Contacts: 1, Links: 1 }, "2 contact and personal link records"],
];

// S1-2 (D11 re-check): every column a person can fill in on the tenancy itself is
// tested on its own, so that dropping any one from the rule fails. Each row is the
// column, a value someone might have entered, and what the refusal calls it.
const CONTENT_HOLDINGS: [string, unknown, string][] = [
  ["InfoSheetSections", '[{"id":"s1","title":"Keys","displayOrder":0,"rows":[]}]', "1 lease clause section"],
  ["LeaseAdministration", JSON.stringify({ ...defaultLeaseAdministration(), leaseManager: { email: "bea@acme.example", name: "Bea" } }), "lease administration details"],
  ["MiscFees", '[{"id":"m1","title":"Air con"}]', "1 miscellaneous fee"],
  ["Incentives", '[{"id":"i1"}]', "1 incentive"],
  ["ScheduledRateSteps", '[{"id":"s1","effectiveFrom":"2024-07-01","ratePercent":0}]', "a rent schedule"],
  ["CarparkScheduleGroups", '[{"id":"g1"}]', "1 car park rate group"],
  ["SecurityDepositSteps", '[{"id":"d1"}]', "a security deposit schedule"],
  ["RentReliefs", '[{"id":"r1"}]', "1 rent relief"],
  ["HoldoverTerms", "Month to month after expiry", "holdover terms"],
  ["Comments", "Chase the signed copy", "comments"],
  ["EscalationSchedule", '[{"year":2,"percent":3}]', "escalation terms"],
  ["EscalationPercent", 3, "escalation terms"],
  ["TradingName", "Acme Trading", "company details"],
  ["Abn", "12 345 678 901", "company details"],
  ["Acn", "123 456 789", "company details"],
  ["IdNo", "T-0042", "company details"],
  ["PostalAddress", "GPO Box 1", "address and contact details"],
  ["StreetAddress", "1 Smith St", "address and contact details"],
  ["AccountsPhone", "08 8900 0000", "address and contact details"],
  ["AccountsEmail", "accounts@acme.example", "address and contact details"],
  ["PrimaryContactName", "Bea Contact", "address and contact details"],
  ["PrimaryContactEmail", "bea@acme.example", "address and contact details"],
  ["PrimaryContactPhone", "0400 000 000", "address and contact details"],
  ["Expiry", new Date("2029-06-30T00:00:00Z"), "lease terms"],
  ["TermMonths", 60, "lease terms"],
  ["OptionsTotal", 2, "lease options"],
  ["OptionsRemaining", 1, "lease options"],
  ["OptionTermMonths", 60, "lease options"],
  ["OptionPeriods", "2 x 5 years", "lease terms"],
  ["OptionNoticeMonths", 6, "lease terms"],
  ["RenewalLetterIssueBy", "ASAP", "lease terms"],
  ["BusinessTenanciesAct", "Not Retail", "lease terms"],
  ["LeaseType", "retail", "lease terms"],
  ["Lot", "5443", "lease terms"],
  ["InformationSheetAsAt", "5/1/19", "lease terms"],
  ["InformationSheetReference", "Leasing\\2019\\Form 34.pdf", "lease terms"],
  ["RentPerAnnum", 0, "rent figures"],
  ["ReviewType", "CPI Darwin (June)", "rent review settings"],
  ["ReviewIntervalMonths", 12, "rent review settings"],
  ["LastReviewDate", new Date("2026-07-01T00:00:00Z"), "rent review settings"],
  ["LastReviewIncreasePercent", 3.5, "rent review settings"],
  ["FixedReviewPercent", 3, "rent review settings"],
  ["CpiRegion", "DARWIN", "rent review settings"],
  ["CpiCapPercent", 5, "rent review settings"],
  ["CpiFloorPercent", 0, "rent review settings"],
  ["CpiReferenceQuarterRule", "quarter_before_review_date", "rent review settings"],
  ["ReviewRatchet", true, "rent review settings"],
  ["EmailOnly", true, "an email-only setting"],
  ["SecurityDepositRequired", "3 months rent", "security deposit details"],
  ["SecurityDepositMethod", "Bank guarantee", "security deposit details"],
  ["SecurityDepositHeld", 0, "security deposit details"],
];

// Tables a hard delete would cascade into or strand, each read under a range lock
// inside the delete's transaction so nothing can be added between check and delete.
const LOCKED_CHILD_READS: [string, RegExp][] = [
  ["Jobs", /FROM dbo\.Jobs j WITH \(HOLDLOCK\) WHERE j\.TenantID = t\.TenantId/],
  ["Keys", /FROM dbo\.Keys k WITH \(HOLDLOCK\) WHERE k\.TenancyId = t\.TenantId/],
  ["Vacancies", /FROM dbo\.Vacancies v WITH \(HOLDLOCK\) WHERE v\.TenancyId = t\.TenantId/],
  ["TenantOccupancies", /FROM dbo\.TenantOccupancies o WITH \(HOLDLOCK\) WHERE o\.TenantId = t\.TenantId/],
  ["TenantOccupancyHistory", /FROM dbo\.TenantOccupancyHistory h WITH \(HOLDLOCK\) WHERE h\.TenantId = t\.TenantId/],
  ["TenantNotes", /FROM dbo\.TenantNotes n WITH \(HOLDLOCK\) WHERE n\.TenantId = t\.TenantId/],
  ["RentReviews", /FROM dbo\.RentReviews r WITH \(HOLDLOCK\) WHERE r\.TenantId = t\.TenantId/],
  ["RentScheduleChangeLog", /FROM dbo\.RentScheduleChangeLog c WITH \(HOLDLOCK\) WHERE c\.TenantId = t\.TenantId/],
  ["TenancyAttachments", /FROM dbo\.TenancyAttachments ta WITH \(HOLDLOCK\) WHERE ta\.TenantId = t\.TenantId/],
  ["Carparks", /FROM dbo\.Carparks cp WITH \(HOLDLOCK\) WHERE cp\.TenantId = t\.TenantId/],
  ["DecisionLedger (subject)", /FROM dbo\.DecisionLedger d WITH \(HOLDLOCK\) WHERE d\.SubjectType = N'tenancy' AND d\.SubjectId = @IdText/],
  ["DecisionLedger (scope)", /FROM dbo\.DecisionLedger d2 WITH \(HOLDLOCK\) WHERE d2\.TenantId = t\.TenantId/],
];

describe.each(["deleteRegisterTenant", "deleteTenant"])("%s: only an empty draft is hard-deleted", (name) => {
  const body = name === "deleteTenant" ? { TenantID: 7 } : { TenantId: 7 };

  it("is gated on the same roles as the other delete route", async () => {
    await handlers[name](post(body), ctx);
    expect(auth.requireRole.mock.calls[0][1]).toEqual([AppRole.ACCOUNTS, AppRole.ACCOUNTS_APPROVAL, AppRole.ADMIN, AppRole.DIRECTOR]);
  });

  const refusedAndNothingChanged = () => {
    expect(ran(/DELETE FROM dbo\.Tenants/)).toBe(false);
    expect(ledger.record).not.toHaveBeenCalled();
    expect(db.rollbackTransaction).toHaveBeenCalled();
    expect(db.commitTransaction).not.toHaveBeenCalled();
  };

  it.each(DRAFT_HOLDINGS)("refuses (409) a tenancy with %s, says archive instead, deletes and ledgers nothing", async (_label, over, part) => {
    tenant = { ...tenant, ...over };
    optional = { ...optional, ...over };
    const res = await handlers[name](post(body), ctx);
    expect(res.status).toBe(409);
    expect(res.jsonBody.error).toBe(`Acme Pty Ltd has ${part}, so it can't be deleted. Archive it instead.`);
    expect(res.jsonBody.contains).toEqual([part]);
    refusedAndNothingChanged();
  });

  it.each(CONTENT_HOLDINGS)("refuses (409) a tenancy with something in %s, naming it, deleting and ledgering nothing (S1-2)", async (column, value, part) => {
    tenantRow = { ...tenantRow, [column]: value };
    const res = await handlers[name](post(body), ctx);
    expect(res.status).toBe(409);
    expect(res.jsonBody.error).toBe(`Acme Pty Ltd has ${part}, so it can't be deleted. Archive it instead.`);
    expect(res.jsonBody.contains).toEqual([part]);
    refusedAndNothingChanged();
  });

  it("covers every column the rule lists: this table and the rule agree", () => {
    const { TENANCY_CONTENT_COLUMNS } = jest.requireActual("../tenancyDraftContent") as { TENANCY_CONTENT_COLUMNS: { column: string }[] };
    expect(CONTENT_HOLDINGS.map(([column]) => column).sort()).toEqual(TENANCY_CONTENT_COLUMNS.map((entry) => entry.column).sort());
  });

  it("names everything it has, whichever of its columns or child records it is in", async () => {
    tenant = { ...tenant, Documents: 3, Occupancies: 1 };
    tenantRow = {
      ...tenantRow,
      InfoSheetSections: '[{"id":"s1","title":"A","rows":[]},{"id":"s2","title":"B","rows":[]}]',
      ScheduledRateSteps: '[{"id":"s1","effectiveFrom":"2024-07-01","ratePercent":0}]',
    };
    const res = await handlers[name](post(body), ctx);
    expect(res.jsonBody.error).toBe("Acme Pty Ltd has 2 lease clause sections, a rent schedule, 1 area and 3 documents, so it can't be deleted. Archive it instead.");
    expect(res.jsonBody.contains).toEqual(["2 lease clause sections", "a rent schedule", "1 area", "3 documents"]);
  });

  it("the lease clauses alone are enough: clauses but no areas or schedule is not an empty draft (the 23 Oct review's case)", async () => {
    tenantRow = { ...tenantRow, InfoSheetSections: '[{"id":"s1","title":"Make good","rows":[{"id":"r1","subheader":"Clause 9","body":"Remove fitout"}]}]' };
    expect((await handlers[name](post(body), ctx)).status).toBe(409);
    refusedAndNothingChanged();
  });

  const JSON_COLUMNS = ["CarparkScheduleGroups", "Incentives", "InfoSheetSections", "LeaseAdministration", "MiscFees", "RentReliefs", "ScheduledRateSteps", "SecurityDepositSteps"];
  it.each(["[]", "{}", "null", "", "  ", null, "[{}]", '{"a":null,"b":[],"c":""}'])("treats %p in a JSON column as empty", async (text) => {
    tenantRow = { ...tenantRow, ...Object.fromEntries(JSON_COLUMNS.map((column) => [column, text])) };
    expect((await handlers[name](post(body), ctx)).status).toBe(200);
  });

  it.each([["unreadable text", "{not json"], ["a bare string", '"x"'], ["a number", "0"], ["false", "false"]])("never takes %s in a JSON column to mean empty", async (_label, text) => {
    tenantRow = { ...tenantRow, InfoSheetSections: text };
    const res = await handlers[name](post(body), ctx);
    expect(res.status).toBe(409);
    expect(res.jsonBody.contains).toEqual(["lease clauses"]);
    refusedAndNothingChanged();
  });

  it("ReviewType 'none' is the default, not content; anything else is", async () => {
    expect((await handlers[name](post(body), ctx)).status).toBe(200);
    tenantRow = { ...tenantRow, ReviewType: "Market" };
    expect((await handlers[name](post(body), ctx)).status).toBe(409);
  });

  it("a column the rule has never heard of with something in it is content, so a new column can't be deleted unseen", async () => {
    tenantRow = { ...tenantRow, SomeFutureColumn: "anything" };
    const res = await handlers[name](post(body), ctx);
    expect(res.status).toBe(409);
    expect(res.jsonBody.contains).toEqual(["other details"]);
    refusedAndNothingChanged();
  });

  it("a column the rule has never heard of that is empty doesn't stop a delete", async () => {
    tenantRow = { ...tenantRow, SomeFutureColumn: null };
    expect((await handlers[name](post(body), ctx)).status).toBe(200);
  });

  it("a tenancy exactly as creating one leaves it is an empty draft: the standard lease administration the insert writes, a commencement and the review date worked out from it", async () => {
    tenantRow = {
      ...tenantRow,
      Commencement: new Date("2026-11-01T00:00:00Z"),
      LeaseAdministration: JSON.stringify(defaultLeaseAdministration()),
      MyobId: "CUST-0042",
      NextReviewDate: new Date("2027-11-01T00:00:00Z"),
      Status: "vacated",
    };
    expect((await handlers[name](post(body), ctx)).status).toBe(200);
  });

  // The seeded lease administration is untouched only while nothing is filled in, added, renamed or removed.
  const touched = (change: (admin: ReturnType<typeof defaultLeaseAdministration>) => unknown) => JSON.stringify(change(defaultLeaseAdministration()));
  it.each([
    ["a date filled in on a field", touched((admin) => ({ ...admin, otherDocuments: admin.otherDocuments.map((field, index) => (index === 0 ? { ...field, value: "2026-01-01" } : field)) }))],
    ["a date set on the lease document", touched((admin) => ({ ...admin, leaseDocuments: admin.leaseDocuments.map((doc) => ({ ...doc, executedByLessee: "2026-01-01" })) }))],
    ["a lease document added", touched((admin) => ({ ...admin, leaseDocuments: [...admin.leaseDocuments, { displayOrder: 1, docType: "Deed of Variation", id: "d2" }] }))],
    ["the seeded lease document removed", touched((admin) => ({ ...admin, leaseDocuments: [] }))],
    ["a field added", touched((admin) => ({ ...admin, detailsEntered: [...admin.detailsEntered, { displayOrder: 4, fieldType: "text", id: "x", label: "Notes" }] }))],
    ["a field renamed", touched((admin) => ({ ...admin, detailsEntered: admin.detailsEntered.map((field, index) => (index === 0 ? { ...field, label: "Renamed" } : field)) }))],
    ["a field removed", touched((admin) => ({ ...admin, detailsEntered: admin.detailsEntered.slice(1) }))],
    ["a part this code has never heard of", touched((admin) => ({ ...admin, futureThing: "kept" }))],
  ])("is not an empty draft once its lease administration has %s", async (_label, value) => {
    tenantRow = { ...tenantRow, LeaseAdministration: value };
    const res = await handlers[name](post(body), ctx);
    expect(res.status).toBe(409);
    expect(res.jsonBody.contains).toEqual(["lease administration details"]);
    refusedAndNothingChanged();
  });

  it("the New tenancy form's own fields (name, building, commencement, MYOB id, status) are not content", async () => {
    tenantRow = { ...tenantRow, Commencement: new Date("2026-11-01T00:00:00Z"), MyobId: "CUST-0042", Status: "vacated" };
    expect((await handlers[name](post(body), ctx)).status).toBe(200);
  });

  it("still refuses a tenancy jobs refer to (400, as before)", async () => {
    tenant = { ...tenant, Jobs: 2 };
    const res = await handlers[name](post(body), ctx);
    expect(res.status).toBe(400);
    expect(res.jsonBody.error).toMatch(/Reassign first/);
    expect(ran(/DELETE FROM dbo\.Tenants/)).toBe(false);
  });

  it("answers 404 for an unknown tenancy", async () => {
    tenant = null;
    expect((await handlers[name](post(body), ctx)).status).toBe(404);
    expect(ran(/DELETE FROM dbo\.Tenants/)).toBe(false);
  });

  it.each(LOCKED_CHILD_READS)("reads %s under a range lock before deleting", async (_table, pattern) => {
    await handlers[name](post(body), ctx);
    const facts = sqlOf(/FROM dbo\.Tenants t WITH \(UPDLOCK, HOLDLOCK\)/);
    expect(facts).toMatch(pattern);
    expect(order(/FROM dbo\.Tenants t WITH \(UPDLOCK, HOLDLOCK\)/)).toBeGreaterThan(db.beginTransaction.mock.invocationCallOrder[0]);
    const params = db.executeQuery.mock.calls.find((c: unknown[]) => /FROM dbo\.Tenants t WITH \(UPDLOCK, HOLDLOCK\)/.test(String(c[1])))?.[2];
    expect(params).toEqual(expect.arrayContaining([expect.objectContaining({ name: "IdText", value: "7" })]));
  });

  it("reads every table in TENANCY_CHILD_TABLES under a range lock (S1-2)", async () => {
    await handlers[name](post(body), ctx);
    const sql = [sqlOf(/FROM dbo\.Tenants t WITH \(UPDLOCK, HOLDLOCK\)/), sqlOf(/ScheduleSignedOffAt/)].join("\n");
    const { TENANCY_CHILD_TABLES } = jest.requireActual("../tenancyDraftContent") as { TENANCY_CHILD_TABLES: readonly string[] };
    for (const table of TENANCY_CHILD_TABLES) expect(sql).toMatch(new RegExp(`FROM dbo\\.${table}(?: \\w+)? WITH \\(HOLDLOCK\\)`));
  });

  it("reads the row itself, every column, under the same lock before it counts anything (S1-2)", async () => {
    await handlers[name](post(body), ctx);
    expect(sqlOf(/SELECT \* FROM dbo\.Tenants/)).toMatch(/SELECT \* FROM dbo\.Tenants WITH \(UPDLOCK, HOLDLOCK\) WHERE TenantId = @Id/);
    expect(order(/SELECT \* FROM dbo\.Tenants/)).toBeGreaterThan(db.beginTransaction.mock.invocationCallOrder[0]);
    expect(order(/SELECT \* FROM dbo\.Tenants/)).toBeLessThan(order(/FROM dbo\.Tenants t WITH \(UPDLOCK, HOLDLOCK\)/));
  });

  it("reads the sign-off and defects periods only where those exist (migrations 097 and 119)", async () => {
    await handlers[name](post(body), ctx);
    const optionalSql = sqlOf(/ScheduleSignedOffAt/);
    expect(optionalSql).toMatch(/IF COL_LENGTH\(N'dbo\.Tenants', N'ScheduleSignedOffAt'\) IS NOT NULL/);
    expect(optionalSql).toMatch(/ScheduleSignedOffAt IS NOT NULL/);
    expect(optionalSql).toMatch(/IF OBJECT_ID\(N'dbo\.DefectsPeriods', N'U'\) IS NOT NULL/);
    expect(optionalSql).toMatch(/FROM dbo\.DefectsPeriods WITH \(HOLDLOCK\) WHERE TenantId = @Id/);
    expect(optionalSql).toMatch(/IF OBJECT_ID\(N'dbo\.ScheduleChangeRequests', N'U'\) IS NOT NULL\s+SELECT @Requests = COUNT\(\*\) FROM dbo\.ScheduleChangeRequests WITH \(HOLDLOCK\) WHERE TenantId = @Id/);
    expect(optionalSql).toMatch(/IF OBJECT_ID\(N'dbo\.RegisterDocuments', N'U'\) IS NOT NULL\s+SELECT @RegisterDocs = COUNT\(\*\) FROM dbo\.RegisterDocuments WITH \(HOLDLOCK\) WHERE TenantId = @Id/);
    expect(optionalSql).toMatch(/IF OBJECT_ID\(N'dbo\.LeaseEvents', N'U'\) IS NOT NULL\s+SELECT @LeaseEvents = COUNT\(\*\) FROM dbo\.LeaseEvents WITH \(HOLDLOCK\) WHERE TenantId = @Id/);
    expect(order(/ScheduleSignedOffAt/)).toBeGreaterThan(db.beginTransaction.mock.invocationCallOrder[0]);
  });

  it("deletes an empty draft inside one transaction and ledgers it with what was deleted", async () => {
    const res = await handlers[name](post(body), ctx);
    expect(res.status).toBe(200);
    expect(sqlOf(/DELETE FROM dbo\.Tenants/)).toMatch(/DELETE FROM dbo\.Tenants WHERE TenantId = @Id/);
    expect(order(/DELETE FROM dbo\.Tenants/)).toBeGreaterThan(order(/ScheduleSignedOffAt/));
    expect(order(/DELETE FROM dbo\.Tenants/)).toBeGreaterThan(order(/FROM dbo\.Tenants t WITH \(UPDLOCK, HOLDLOCK\)/));
    expect(ledger.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "tenancy.delete_draft",
        before: expect.objectContaining({ buildingId: 3, legalName: "Acme Pty Ltd" }),
        buildingId: 3,
        subject: { id: 7, type: "tenancy" },
      }),
    );
    expect(ledger.record.mock.invocationCallOrder[0]).toBeGreaterThan(order(/DELETE FROM dbo\.Tenants/));
    expect(ledger.record.mock.invocationCallOrder[0]).toBeLessThan(db.commitTransaction.mock.invocationCallOrder[0]);
    expect(cache.invalidateTenant).toHaveBeenCalledWith(7);
  });

  it("writes the whole deleted row to the ledger's Before, so nothing the row held is lost (S1-2)", async () => {
    tenantRow = { ...tenantRow, Commencement: new Date("2026-11-01T00:00:00Z"), MyobId: "CUST-0042" };
    await handlers[name](post(body), ctx);
    const before = ledger.record.mock.calls[0][1].before;
    expect(before.row).toEqual(
      expect.objectContaining({ Commencement: "2026-11-01T00:00:00.000Z", LegalName: "Acme Pty Ltd", MyobId: "CUST-0042", RowVersion: "0000000000000a01", TenantId: 7 }),
    );
    expect(Object.keys(before.row).sort()).toEqual(Object.keys(blankRow()).sort());
  });

  it("refuses the delete, removing nothing, when that row would not fit the ledger (S1-2)", async () => {
    tenantRow = { ...tenantRow, MyobId: "x".repeat(70_000) };
    const res = await handlers[name](post(body), ctx);
    expect(res.status).toBe(409);
    expect(res.jsonBody.error).toBe("Acme Pty Ltd is too large to keep a copy of in the history, so it can't be deleted. Archive it instead.");
    refusedAndNothingChanged();
  });

  it("rolls back, deleting nothing for good, when the ledger write fails", async () => {
    ledger.record.mockRejectedValueOnce(new Error("ledger down"));
    const res = await handlers[name](post(body), ctx);
    expect(res.status).toBe(500);
    expect(db.rollbackTransaction).toHaveBeenCalled();
    expect(db.commitTransaction).not.toHaveBeenCalled();
  });
});

describe("lease documents", () => {
  it("archiveTenancyDocument stamps who and when on the file and ledgers it against the tenancy", async () => {
    const res = await handlers.archiveTenancyDocument(post({ AttachmentID: 12, TenantId: 7 }), ctx);
    expect(res.status).toBe(200);
    expect(sqlOf(/UPDATE dbo\.Attachments SET ArchivedAt/)).toMatch(/ArchivedAt = SYSUTCDATETIME\(\), ArchivedBy = @By[\s\S]*WHERE Id = @AttachmentID AND ArchivedAt IS NULL/);
    expect(ledger.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "tenancy.document_archive", before: { attachmentId: 12, fileName: "lease.pdf" }, subject: { id: 7, type: "tenancy" } }),
    );
    expect(db.commitTransaction).toHaveBeenCalled();
  });

  it("archiveTenancyDocument answers 404 for a file that isn't this tenancy's and 409 for one already archived", async () => {
    documentRow = null;
    expect((await handlers.archiveTenancyDocument(post({ AttachmentID: 12, TenantId: 7 }), ctx)).status).toBe(404);
    documentRow = { ArchivedAt: new Date(), OriginalName: "lease.pdf" };
    expect((await handlers.archiveTenancyDocument(post({ AttachmentID: 12, TenantId: 7 }), ctx)).status).toBe(409);
    expect(ledger.record).not.toHaveBeenCalled();
  });

  it("getTenancyAttachments leaves archived documents out unless asked for", async () => {
    await handlers.getTenancyAttachments(post(null, { tenantId: "7" }), ctx);
    expect(sqlOf(/FROM TenancyAttachments ta/)).toMatch(/AND a\.ArchivedAt IS NULL/);
    db.executeQuery.mockClear();
    await handlers.getTenancyAttachments(post(null, { includeArchived: "true", tenantId: "7" }), ctx);
    expect(sqlOf(/FROM TenancyAttachments ta/)).not.toMatch(/ArchivedAt IS NULL/);
  });
});

describe("archived tenancies stay out of normal views and counts", () => {
  it("the building register leaves them out unless asked for", async () => {
    await handlers.getRegisterTenants(post(null, { buildingId: "3" }), ctx);
    expect(sqlOf(/FROM dbo\.Tenants t WHERE BuildingId = @BuildingId/)).toMatch(/AND t\.ArchivedAt IS NULL/);
    db.executeQuery.mockClear();
    await handlers.getRegisterTenants(post(null, { buildingId: "3", includeArchived: "true" }), ctx);
    expect(sqlOf(/FROM dbo\.Tenants t WHERE BuildingId = @BuildingId/)).not.toMatch(/ArchivedAt IS NULL/);
  });

  it.each([
    ["getReviewsDue", {}],
    ["getPortfolioOccupancy", {}],
    ["getTenants", {}],
  ])("%s leaves them out", async (name, query) => {
    await handlers[name](post(null, query), ctx);
    const tenantSql = db.executeQuery.mock.calls.map((c: unknown[]) => String(c[1])).filter((sql: string) => /FROM dbo\.Tenants t/.test(sql));
    expect(tenantSql.length).toBeGreaterThan(0);
    for (const sql of tenantSql) expect(sql).toMatch(/t\.ArchivedAt IS NULL/);
  });
});
