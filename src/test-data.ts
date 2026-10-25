import type { HttpRequest, HttpResponseInit } from "@azure/functions";
import { TYPES, type Connection } from "tedious";
import { AppRole, forbiddenResponse, rolesForRequest } from "./auth";
import { executeQuery } from "./db";

// Test records (D9, WP58-lite; migration 127 adds IsTest to the record tables).
//
// A test record never leaves Floorplan: every egress helper (Graph mail,
// Planner, MYOB, WordPress, the digest, Teams alerts) takes what the call is
// about and throws TestDataEgressError for a test record before it touches the network.
// Test records are also left out of lists, counts, figures and exports unless
// an admin has turned on Show test data, which the app sends as the
// X-Show-Test-Data header on every request.

export const TEST_RECORD_MESSAGE = "Not sent: test record";
export const TEST_TITLE_PREFIX = "[TEST]";
export const SHOW_TEST_DATA_HEADER = "x-show-test-data";

export type EgressChannel = "digest" | "email" | "mybuildings" | "myob" | "planner" | "teams" | "wordpress";

export class TestDataEgressError extends Error {
  readonly channel: EgressChannel;
  constructor(channel: EgressChannel) {
    super(TEST_RECORD_MESSAGE);
    this.name = "TestDataEgressError";
    this.channel = channel;
  }
}

/** For outbound mail that isn't about a record (feedback, a connection test). */
export const NOT_A_RECORD = "not-a-record" as const;

/** What an outbound call is about: the record's test flag, or NOT_A_RECORD. */
export type EgressSubject = { isTest: boolean | null | undefined } | typeof NOT_A_RECORD;

/** Throws TestDataEgressError when the call is about a test record. */
export function assertMayLeave(channel: EgressChannel, subject: EgressSubject): void {
  if (subject !== NOT_A_RECORD && subject.isTest) throw new TestDataEgressError(channel);
}

/** The response an endpoint gives when its send was refused for a test record. */
export function testRecordResponse(): HttpResponseInit {
  return { jsonBody: { code: "TEST_RECORD", error: TEST_RECORD_MESSAGE }, status: 409 };
}

export type TestRecordKind =
  | "defects_period"
  | "inspection"
  | "invoice"
  | "job"
  | "key"
  | "payment"
  | "purchase_order"
  | "quote"
  | "rent_review"
  | "schedule_change"
  | "tenancy"
  | "vacancy";

const TEXT_ID_KINDS: ReadonlySet<TestRecordKind> = new Set(["rent_review", "schedule_change"]);

// One constant statement per kind. A money record is a test record when it is
// flagged itself or its job is; a rent review, a schedule change or a defects
// period when its tenancy is (a building-wide defects period never is).
export const IS_TEST_SQL: Record<TestRecordKind, string> = {
  defects_period: `IF OBJECT_ID(N'dbo.DefectsPeriods', N'U') IS NOT NULL
  SELECT t.IsTest FROM dbo.DefectsPeriods d JOIN dbo.Tenants t ON t.TenantId = d.TenantId WHERE d.DefectsPeriodId = @Id`,
  inspection: `SELECT IsTest FROM dbo.Inspections WHERE Id = @Id`,
  invoice: `SELECT CAST(CASE WHEN r.IsTest = 1 OR j.IsTest = 1 THEN 1 ELSE 0 END AS BIT) AS IsTest
  FROM dbo.JobInvoices r JOIN dbo.Jobs j ON j.JobID = r.JobID WHERE r.JobInvoiceID = @Id`,
  job: `SELECT IsTest FROM dbo.Jobs WHERE JobID = @Id`,
  key: `SELECT IsTest FROM dbo.Keys WHERE Id = @Id`,
  payment: `SELECT CAST(CASE WHEN r.IsTest = 1 OR j.IsTest = 1 THEN 1 ELSE 0 END AS BIT) AS IsTest
  FROM dbo.Payments r JOIN dbo.Jobs j ON j.JobID = r.JobID WHERE r.PaymentID = @Id`,
  purchase_order: `SELECT CAST(CASE WHEN r.IsTest = 1 OR j.IsTest = 1 THEN 1 ELSE 0 END AS BIT) AS IsTest
  FROM dbo.PurchaseOrders r JOIN dbo.Jobs j ON j.JobID = r.JobID WHERE r.PurchaseOrderID = @Id`,
  quote: `SELECT CAST(CASE WHEN r.IsTest = 1 OR j.IsTest = 1 THEN 1 ELSE 0 END AS BIT) AS IsTest
  FROM dbo.Quotes r JOIN dbo.Jobs j ON j.JobID = r.JobID WHERE r.QuoteID = @Id`,
  rent_review: `SELECT t.IsTest FROM dbo.RentReviews r JOIN dbo.Tenants t ON t.TenantId = r.TenantId WHERE r.ReviewId = @Id`,
  schedule_change: `IF OBJECT_ID(N'dbo.ScheduleChangeRequests', N'U') IS NOT NULL
  SELECT t.IsTest FROM dbo.ScheduleChangeRequests c JOIN dbo.Tenants t ON t.TenantId = c.TenantId WHERE c.RequestId = @Id`,
  tenancy: `SELECT IsTest FROM dbo.Tenants WHERE TenantId = @Id`,
  vacancy: `SELECT IsTest FROM dbo.Vacancies WHERE Id = @Id`,
};

/** A record's test flag, or null when no such record exists. */
export async function readTestRecord(connection: Connection, kind: TestRecordKind, id: number | string): Promise<boolean | null> {
  const param = TEXT_ID_KINDS.has(kind)
    ? { name: "Id", type: TYPES.NVarChar, value: String(id) }
    : { name: "Id", type: TYPES.Int, value: Number(id) };
  const [row] = await executeQuery(connection, IS_TEST_SQL[kind], [param]);
  return row ? row.IsTest === true || row.IsTest === 1 : null;
}

/** Whether a record is test data; a record that isn't there reads as not test (see readTestRecord to tell). */
export async function readIsTest(connection: Connection, kind: TestRecordKind, id: number | string): Promise<boolean> {
  return (await readTestRecord(connection, kind, id)) === true;
}

/** The test-record kind an escalation's or a ledger row's subject type names, or null. */
export function testKindOfSubject(subjectType: string): TestRecordKind | null {
  return Object.prototype.hasOwnProperty.call(IS_TEST_SQL, subjectType) ? (subjectType as TestRecordKind) : null;
}

// Every test record a summary could name, as Kind/Id rows. Test records are
// few, so the digest and the MYOB daily email read this once per run.
export const TEST_SUBJECT_KEYS_SQL = `DECLARE @Keys TABLE (Kind NVARCHAR(32), Id NVARCHAR(64));
INSERT @Keys (Kind, Id)
  SELECT N'job', CAST(JobID AS NVARCHAR(64)) FROM dbo.Jobs WHERE IsTest = 1
  UNION ALL SELECT N'tenancy', CAST(TenantId AS NVARCHAR(64)) FROM dbo.Tenants WHERE IsTest = 1
  UNION ALL SELECT N'inspection', CAST(Id AS NVARCHAR(64)) FROM dbo.Inspections WHERE IsTest = 1
  UNION ALL SELECT N'key', CAST(Id AS NVARCHAR(64)) FROM dbo.Keys WHERE IsTest = 1
  UNION ALL SELECT N'vacancy', CAST(Id AS NVARCHAR(64)) FROM dbo.Vacancies WHERE IsTest = 1
  UNION ALL SELECT N'quote', CAST(r.QuoteID AS NVARCHAR(64)) FROM dbo.Quotes r JOIN dbo.Jobs j ON j.JobID = r.JobID WHERE r.IsTest = 1 OR j.IsTest = 1
  UNION ALL SELECT N'invoice', CAST(r.JobInvoiceID AS NVARCHAR(64)) FROM dbo.JobInvoices r JOIN dbo.Jobs j ON j.JobID = r.JobID WHERE r.IsTest = 1 OR j.IsTest = 1
  UNION ALL SELECT N'purchase_order', CAST(r.PurchaseOrderID AS NVARCHAR(64)) FROM dbo.PurchaseOrders r JOIN dbo.Jobs j ON j.JobID = r.JobID WHERE r.IsTest = 1 OR j.IsTest = 1
  UNION ALL SELECT N'payment', CAST(r.PaymentID AS NVARCHAR(64)) FROM dbo.Payments r JOIN dbo.Jobs j ON j.JobID = r.JobID WHERE r.IsTest = 1 OR j.IsTest = 1
  UNION ALL SELECT N'rent_review', r.ReviewId FROM dbo.RentReviews r JOIN dbo.Tenants t ON t.TenantId = r.TenantId WHERE t.IsTest = 1;
IF OBJECT_ID(N'dbo.ScheduleChangeRequests', N'U') IS NOT NULL
  INSERT @Keys (Kind, Id)
  SELECT N'schedule_change', c.RequestId FROM dbo.ScheduleChangeRequests c JOIN dbo.Tenants t ON t.TenantId = c.TenantId WHERE t.IsTest = 1;
IF OBJECT_ID(N'dbo.DefectsPeriods', N'U') IS NOT NULL
  INSERT @Keys (Kind, Id)
  SELECT N'defects_period', CAST(d.DefectsPeriodId AS NVARCHAR(64)) FROM dbo.DefectsPeriods d JOIN dbo.Tenants t ON t.TenantId = d.TenantId WHERE t.IsTest = 1;
SELECT Kind, Id FROM @Keys;`;

/** "<kind>:<id>" for every test record (see TEST_SUBJECT_KEYS_SQL). */
export async function loadTestSubjectKeys(connection: Connection): Promise<Set<string>> {
  const rows = await executeQuery(connection, TEST_SUBJECT_KEYS_SQL);
  return new Set(rows.map((row) => `${String(row.Kind)}:${String(row.Id)}`));
}

/** Whether this request may see test records: only an admin with Show test data on. */
export async function showTestData(request: HttpRequest): Promise<boolean> {
  if (request.headers.get(SHOW_TEST_DATA_HEADER) !== "1") return false;
  try {
    return (await rolesForRequest(request)).includes(AppRole.ADMIN);
  } catch {
    return false;
  }
}

/** The `@ShowTest` parameter that list queries pair with `(x.IsTest = 0 OR @ShowTest = 1)`. */
export async function showTestParam(request: HttpRequest) {
  return { name: "ShowTest", type: TYPES.Bit, value: await showTestData(request) };
}

/**
 * IsTest for a record being created. Admins and directors may ask for it
 * (anyone else is refused); an admin's "[TEST]" title prefix sets it too.
 */
export async function testFlagForCreate(
  request: HttpRequest,
  requested: unknown,
  title: string | null | undefined,
): Promise<{ isTest: boolean } | { error: HttpResponseInit }> {
  const asked = requested === true;
  const prefixed = typeof title === "string" && title.trim().toUpperCase().startsWith(TEST_TITLE_PREFIX);
  if (!asked && !prefixed) return { isTest: false };

  let roles: string[] = [];
  try {
    roles = await rolesForRequest(request);
  } catch {
    roles = [];
  }
  const admin = roles.includes(AppRole.ADMIN);
  if (asked) {
    if (admin || roles.includes(AppRole.DIRECTOR)) return { isTest: true };
    return { error: forbiddenResponse("Only admins and directors can mark a record as test data.") };
  }
  return { isTest: admin };
}
