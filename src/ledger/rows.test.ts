/// <reference types="jest" />
import { DECISION_COLUMNS, toDecisionRow } from "./rows";

// A row as tedious hands it back: BIGINT as a string, the GUID upper-cased,
// DATETIME2 as a Date (UTC), BIT as a boolean, DECIMAL as a number.
function sqlRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    LedgerId: "9007",
    OccurredAt: new Date("2026-10-13T01:02:03.456Z"),
    Action: "quote.approve_attributed",
    SubjectType: "quote",
    SubjectId: "123",
    TenantId: 42,
    JobId: 99,
    BuildingId: 5,
    ActorUserId: 11,
    ActorName: "Fay Staff",
    ActorRole: "facilities",
    ActorKind: "user",
    AttributedUserId: 12,
    AttributedName: "Mo Manager",
    AttributedRole: "facilities_manager",
    Reason: "Talked it through on site",
    Before: '{"status":"pending"}',
    After: '{"status":"approved"}',
    Computed: null,
    FinancialImpact: 1234.5,
    RuleApplied: "within_own_limit",
    CorrelationId: "6F9619FF-8B86-D011-B42D-00C04FC964FF",
    IsException: false,
    ...overrides,
  };
}

describe("toDecisionRow", () => {
  it("shapes a person's decision", () => {
    expect(toDecisionRow(sqlRow())).toEqual({
      action: "quote.approve_attributed",
      actor: { kind: "user", name: "Fay Staff", role: "facilities", userId: 11 },
      after: { status: "approved" },
      attributedTo: { name: "Mo Manager", role: "facilities_manager", userId: 12 },
      before: { status: "pending" },
      buildingId: 5,
      computed: null,
      correlationId: "6f9619ff-8b86-d011-b42d-00c04fc964ff",
      financialImpact: 1234.5,
      isException: false,
      jobId: 99,
      ledgerId: 9007,
      occurredAt: "2026-10-13T01:02:03.456Z",
      reason: "Talked it through on site",
      ruleApplied: "within_own_limit",
      subjectId: "123",
      subjectType: "quote",
      tenantId: 42,
    });
  });

  it("gives the id as a number and the time as ISO UTC", () => {
    const row = toDecisionRow(sqlRow());
    expect(typeof row.ledgerId).toBe("number");
    expect(row.occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("lower-cases the correlation id so it matches newCorrelationId() and MyobApiLog", () => {
    expect(toDecisionRow(sqlRow()).correlationId).toBe("6f9619ff-8b86-d011-b42d-00c04fc964ff");
  });

  it("returns attributedTo null when nobody was named", () => {
    const row = toDecisionRow(sqlRow({ AttributedName: null, AttributedRole: null, AttributedUserId: null }));
    expect(row.attributedTo).toBeNull();
  });

  it("keeps a named person who has no Floorplan account", () => {
    const row = toDecisionRow(sqlRow({ AttributedUserId: null }));
    expect(row.attributedTo).toEqual({ name: "Mo Manager", role: "facilities_manager", userId: null });
  });

  it("shapes a system actor", () => {
    const row = toDecisionRow(sqlRow({ ActorKind: "system", ActorName: "ledgerVerifyTimer", ActorRole: null, ActorUserId: null }));
    expect(row.actor).toEqual({ kind: "system", name: "ledgerVerifyTimer", role: null, userId: null });
  });

  it("maps NULLs to null and zero impact to zero", () => {
    const row = toDecisionRow(
      sqlRow({ BuildingId: null, FinancialImpact: 0, JobId: null, Reason: null, RuleApplied: null, TenantId: null }),
    );
    expect(row).toMatchObject({ buildingId: null, financialImpact: 0, jobId: null, reason: null, ruleApplied: null, tenantId: null });
    expect(toDecisionRow(sqlRow({ FinancialImpact: null })).financialImpact).toBeNull();
  });

  it("parses the snapshots and survives a damaged one", () => {
    const row = toDecisionRow(sqlRow({ Before: "[1,2]", Computed: '{"suggested":3}' }));
    expect(row.before).toEqual([1, 2]);
    expect(row.computed).toEqual({ suggested: 3 });
    expect(toDecisionRow(sqlRow({ After: "{not json" })).after).toBeNull();
  });
});

describe("DECISION_COLUMNS", () => {
  it("lists columns explicitly: no SELECT * and no AppVersion", () => {
    expect(DECISION_COLUMNS).not.toContain("*");
    expect(DECISION_COLUMNS).not.toContain("AppVersion");
    expect(DECISION_COLUMNS).toContain("[Before]");
    expect(DECISION_COLUMNS).toContain("AttributedName");
  });
});
