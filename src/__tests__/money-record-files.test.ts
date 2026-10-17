/// <reference types="jest" />
// The state rules themselves (D5). The handler tests mock LockedBecause, so
// these read the SQL: one row per table and condition, each failing if that
// WHEN is removed or changed.
import { DETACH_SQL, type MoneyLinkTable } from "../money-record-files";

/** The CASE … END AS LockedBecause of one table's statement. */
function lockCase(table: MoneyLinkTable): string {
  const sql = DETACH_SQL[table];
  const start = sql.indexOf("CASE WHEN EXISTS (SELECT 1 FROM dbo.Payments");
  const end = sql.indexOf("END AS LockedBecause");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end);
}

const MYOB_SENT = /WHEN @MyobState IN \(N'pushed', N'verified'\) THEN N'sent to MYOB'/;
const MYOB_APPROVED = /WHEN @MyobState = N'approved' THEN N'approved for MYOB'/;

const RULES: [MoneyLinkTable, string, RegExp][] = [
  ["QuoteAttachments", "paid", /EXISTS \(SELECT 1 FROM dbo\.Payments p WHERE p\.QuoteID = r\.QuoteID AND p\.Status = N'paid'\) THEN N'paid'/],
  ["QuoteAttachments", "completed", /WHEN r\.Status = N'completed' THEN N'completed'/],
  ["QuoteAttachments", "approved by a director", /WHEN r\.Status = N'approved' AND r\.DirectorApprovedAt IS NOT NULL THEN N'approved by a director'/],
  ["QuoteAttachments", "approved", /WHEN r\.Status = N'approved' THEN N'approved'/],
  ["QuoteAttachments", "awaiting a director", /WHEN r\.Status = N'awaiting_director' THEN N'sent to a director for approval'/],
  ["QuoteAttachments", "pushed or verified in MYOB", MYOB_SENT],
  ["QuoteAttachments", "approved for MYOB", MYOB_APPROVED],
  ["PurchaseOrderAttachments", "paid", /EXISTS \(SELECT 1 FROM dbo\.Payments p WHERE p\.PurchaseOrderID = r\.PurchaseOrderID AND p\.Status = N'paid'\) THEN N'paid'/],
  ["PurchaseOrderAttachments", "marked in MYOB", /WHEN r\.MyobCreatedAt IS NOT NULL THEN N'marked in MYOB'/],
  ["PurchaseOrderAttachments", "marked complete", /WHEN r\.CompletedAt IS NOT NULL THEN N'marked complete'/],
  ["PurchaseOrderAttachments", "sent to the contractor", /WHEN r\.SentAt IS NOT NULL THEN N'sent to the contractor'/],
  ["PurchaseOrderAttachments", "pushed or verified in MYOB", MYOB_SENT],
  ["PurchaseOrderAttachments", "approved for MYOB", MYOB_APPROVED],
  ["JobInvoiceAttachments", "paid", /EXISTS \(SELECT 1 FROM dbo\.Payments p WHERE p\.JobInvoiceID = r\.JobInvoiceID AND p\.Status = N'paid'\) THEN N'paid'/],
  ["JobInvoiceAttachments", "marked in MYOB", /WHEN r\.MyobCreatedAt IS NOT NULL THEN N'marked in MYOB'/],
  ["JobInvoiceAttachments", "approved by a director", /WHEN r\.Status = N'director_approved' THEN N'approved by a director'/],
  ["JobInvoiceAttachments", "approved", /WHEN r\.Status = N'approved' THEN N'approved'/],
  ["JobInvoiceAttachments", "awaiting approval", /WHEN r\.Status = N'awaiting_approval' THEN N'sent for approval'/],
  ["JobInvoiceAttachments", "pushed or verified in MYOB", MYOB_SENT],
  ["JobInvoiceAttachments", "approved for MYOB", MYOB_APPROVED],
];

describe("when a money record's files are fixed", () => {
  it.each(RULES)("%s: locked when %s", (table, _condition, rule) => {
    expect(lockCase(table)).toMatch(rule);
  });

  it("has exactly the conditions listed above for each table, no more and no fewer", () => {
    for (const table of Object.keys(DETACH_SQL) as MoneyLinkTable[]) {
      const whens = lockCase(table).match(/\bWHEN\b/g) ?? [];
      expect([table, whens.length]).toEqual([table, RULES.filter(([t]) => t === table).length]);
    }
  });
});

describe("records pushed through MyobProposals (migration 126)", () => {
  const SUBJECT: Record<MoneyLinkTable, string> = {
    JobInvoiceAttachments: "invoice",
    PurchaseOrderAttachments: "purchase_order",
    QuoteAttachments: "quote",
  };

  it.each(Object.entries(SUBJECT))("%s reads its own proposals in approved, pushed or verified, only where the table exists", (table, subject) => {
    const sql = DETACH_SQL[table as MoneyLinkTable];
    const guarded = new RegExp(
      "IF OBJECT_ID\\(N'dbo\\.MyobProposals', N'U'\\) IS NOT NULL\\s+" +
        "SELECT TOP 1 @MyobState = mp\\.State FROM dbo\\.MyobProposals mp\\s+" +
        `WHERE mp\\.SubjectType = N'${subject}' AND mp\\.SubjectId = @ParentID AND mp\\.State IN \\(N'approved', N'pushed', N'verified'\\)`,
    );
    expect(sql).toMatch(guarded);
    // Named only in the guard and the guarded read: before 126 nothing touches it.
    expect(sql.match(/dbo\.MyobProposals/g)).toHaveLength(2);
    expect(sql.match(/FROM dbo\.MyobProposals/g)).toHaveLength(1);
  });

  it.each(Object.keys(SUBJECT))("%s: before 126 @MyobState stays NULL, which no lock condition matches", (table) => {
    const sql = DETACH_SQL[table as MoneyLinkTable];
    expect(sql.startsWith("DECLARE @MyobState NVARCHAR(16) = NULL;")).toBe(true);
    const myobConditions = lockCase(table as MoneyLinkTable).match(/WHEN @MyobState[^T]*THEN/g) ?? [];
    expect(myobConditions).toEqual(["WHEN @MyobState IN (N'pushed', N'verified') THEN", "WHEN @MyobState = N'approved' THEN"]);
  });
});
