/// <reference types="jest" />
jest.mock("./auth", () => ({ ...jest.requireActual("./auth"), rolesForRequest: jest.fn() }));
jest.mock("./db", () => ({ executeQuery: jest.fn() }));

import type { HttpRequest } from "@azure/functions";
import {
  assertMayLeave,
  IS_TEST_SQL,
  loadTestSubjectKeys,
  TEST_SUBJECT_KEYS_SQL,
  testKindOfSubject,
  NOT_A_RECORD,
  readIsTest,
  showTestData,
  TEST_RECORD_MESSAGE,
  TestDataEgressError,
  testFlagForCreate,
  testRecordResponse,
} from "./test-data";

const auth = require("./auth") as { rolesForRequest: jest.Mock };
const db = require("./db") as { executeQuery: jest.Mock };

function request(headers: Record<string, string> = {}): HttpRequest {
  const map = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return { headers: { get: (name: string) => map.get(name.toLowerCase()) ?? null } } as unknown as HttpRequest;
}

beforeEach(() => jest.clearAllMocks());

describe("assertMayLeave (D9: a test record never leaves Floorplan)", () => {
  it("throws TestDataEgressError for a test record, naming the channel", () => {
    let caught: unknown;
    try {
      assertMayLeave("email", { isTest: true });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TestDataEgressError);
    expect((caught as TestDataEgressError).channel).toBe("email");
    expect((caught as Error).message).toBe("Not sent: test record");
  });

  it("lets a real record and mail that isn't about a record through", () => {
    expect(() => assertMayLeave("planner", { isTest: false })).not.toThrow();
    expect(() => assertMayLeave("planner", { isTest: null })).not.toThrow();
    expect(() => assertMayLeave("email", NOT_A_RECORD)).not.toThrow();
  });

  it("maps to a 409 the caller shows as 'Not sent: test record'", () => {
    expect(testRecordResponse()).toEqual({ jsonBody: { code: "TEST_RECORD", error: TEST_RECORD_MESSAGE }, status: 409 });
  });
});

describe("readIsTest", () => {
  it("reads the record's own flag, and a money record's job flag too", async () => {
    db.executeQuery.mockResolvedValueOnce([{ IsTest: true }]);
    await expect(readIsTest({} as never, "job", 5)).resolves.toBe(true);
    expect(db.executeQuery.mock.calls[0][1]).toBe(IS_TEST_SQL.job);
    expect(db.executeQuery.mock.calls[0][2]).toEqual([expect.objectContaining({ name: "Id", value: 5 })]);

    for (const kind of ["invoice", "payment", "purchase_order", "quote"] as const) {
      expect(IS_TEST_SQL[kind]).toMatch(/JOIN dbo\.Jobs j ON j\.JobID = \w+\.JobID/);
      expect(IS_TEST_SQL[kind]).toMatch(/j\.IsTest = 1/);
    }
  });

  it("reads a rent review or a schedule change through its tenancy, by its text id", async () => {
    db.executeQuery.mockResolvedValueOnce([{ IsTest: 1 }]);
    await expect(readIsTest({} as never, "rent_review", "rr-1")).resolves.toBe(true);
    expect(db.executeQuery.mock.calls[0][2]).toEqual([expect.objectContaining({ name: "Id", value: "rr-1" })]);
    expect(IS_TEST_SQL.rent_review).toMatch(/FROM dbo\.RentReviews r JOIN dbo\.Tenants t ON t\.TenantId = r\.TenantId WHERE r\.ReviewId = @Id/);
    expect(IS_TEST_SQL.schedule_change).toMatch(/IF OBJECT_ID\(N'dbo\.ScheduleChangeRequests', N'U'\) IS NOT NULL/);
    expect(IS_TEST_SQL.schedule_change).toMatch(/JOIN dbo\.Tenants t ON t\.TenantId = c\.TenantId WHERE c\.RequestId = @Id/);
  });

  it("treats a missing row as not a test record", async () => {
    db.executeQuery.mockResolvedValueOnce([]);
    await expect(readIsTest({} as never, "tenancy", 9)).resolves.toBe(false);
  });
});

describe("showTestData (the admin's Show test data toggle)", () => {
  it("is off without the header, without asking for roles", async () => {
    await expect(showTestData(request())).resolves.toBe(false);
    expect(auth.rolesForRequest).not.toHaveBeenCalled();
  });

  it("is on only for an admin who sent the header", async () => {
    auth.rolesForRequest.mockResolvedValueOnce(["admin"]);
    await expect(showTestData(request({ "X-Show-Test-Data": "1" }))).resolves.toBe(true);
    auth.rolesForRequest.mockResolvedValueOnce(["director"]);
    await expect(showTestData(request({ "X-Show-Test-Data": "1" }))).resolves.toBe(false);
    auth.rolesForRequest.mockRejectedValueOnce(new Error("lookup failed"));
    await expect(showTestData(request({ "X-Show-Test-Data": "1" }))).resolves.toBe(false);
  });
});

describe("testFlagForCreate", () => {
  it("is false when nobody asked, without asking for roles", async () => {
    await expect(testFlagForCreate(request(), undefined, "Leaking tap")).resolves.toEqual({ isTest: false });
    expect(auth.rolesForRequest).not.toHaveBeenCalled();
  });

  it("lets admins and directors set it; anyone else is refused", async () => {
    auth.rolesForRequest.mockResolvedValueOnce(["director"]);
    await expect(testFlagForCreate(request(), true, "Leaking tap")).resolves.toEqual({ isTest: true });
    auth.rolesForRequest.mockResolvedValueOnce(["admin"]);
    await expect(testFlagForCreate(request(), true, null)).resolves.toEqual({ isTest: true });
    auth.rolesForRequest.mockResolvedValueOnce(["facilities_manager"]);
    const refused = await testFlagForCreate(request(), true, "Leaking tap");
    expect("error" in refused && refused.error.status).toBe(403);
  });

  it("an admin's [TEST] title prefix sets it; anyone else's doesn't", async () => {
    auth.rolesForRequest.mockResolvedValueOnce(["admin"]);
    await expect(testFlagForCreate(request(), undefined, "[TEST] Leaking tap")).resolves.toEqual({ isTest: true });
    auth.rolesForRequest.mockResolvedValueOnce(["admin"]);
    await expect(testFlagForCreate(request(), undefined, "  [test] lower case")).resolves.toEqual({ isTest: true });
    auth.rolesForRequest.mockResolvedValueOnce(["director"]);
    await expect(testFlagForCreate(request(), undefined, "[TEST] Leaking tap")).resolves.toEqual({ isTest: false });
  });
});

describe("testKindOfSubject (an escalation's or a ledger row's subject type)", () => {
  it("maps the record types D9 flags and nothing else", () => {
    for (const kind of ["job", "tenancy", "rent_review", "schedule_change", "quote", "invoice", "purchase_order", "payment", "inspection", "key", "vacancy"]) {
      expect(testKindOfSubject(kind)).toBe(kind);
    }
    for (const other of ["system", "defects_period", "service_schedule", "approval_limit", ""]) {
      expect(testKindOfSubject(other)).toBeNull();
    }
  });
});

describe("loadTestSubjectKeys (for summaries that name many records: the digest, M4's daily email)", () => {
  it("returns kind:id for every test record, money records through their job too", async () => {
    db.executeQuery.mockResolvedValueOnce([
      { Id: "12", Kind: "job" },
      { Id: "rr-1", Kind: "rent_review" },
    ]);
    const keys = await loadTestSubjectKeys({} as never);
    expect([...keys]).toEqual(["job:12", "rent_review:rr-1"]);
    for (const TABLE of ["Jobs", "Tenants", "Inspections", "Keys", "Vacancies"]) {
      expect(TEST_SUBJECT_KEYS_SQL).toContain(`FROM dbo.${TABLE} WHERE IsTest = 1`);
    }
    for (const TABLE of ["Quotes", "JobInvoices", "PurchaseOrders", "Payments"]) {
      expect(TEST_SUBJECT_KEYS_SQL).toContain(`FROM dbo.${TABLE} r JOIN dbo.Jobs j ON j.JobID = r.JobID WHERE r.IsTest = 1 OR j.IsTest = 1`);
    }
    expect(TEST_SUBJECT_KEYS_SQL).toMatch(/FROM dbo\.RentReviews r JOIN dbo\.Tenants t ON t\.TenantId = r\.TenantId WHERE t\.IsTest = 1/);
    expect(TEST_SUBJECT_KEYS_SQL).toMatch(/IF OBJECT_ID\(N'dbo\.ScheduleChangeRequests', N'U'\) IS NOT NULL/);
  });
});
