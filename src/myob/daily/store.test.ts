/// <reference types="jest" />

jest.mock("../../db", () => ({ executeQuery: jest.fn() }));

import { lastCoveredRun, loadCfoRecipients, loadDailyFacts } from "./store";

const { executeQuery } = require("../../db") as { executeQuery: jest.Mock };
const SINCE = new Date("2026-10-12T22:00:00Z");
const UNTIL = new Date("2026-10-13T22:00:00Z");
const CF = "0F9E8D7C-6B5A-4F3E-9D2C-1B0A99887766";

beforeEach(() => {
  jest.clearAllMocks();
  executeQuery.mockImplementation(async (_c: unknown, sql: string) => {
    if (sql.includes("N'myob.control_change'")) {
      return [{
        Action: "myob.control_change", ActorName: "Johanne", After: '{"enabled":true}', Before: '{"enabled":false}', CompanyFileId: CF, OccurredAt: new Date("2026-10-13T00:01:00Z"),
        Reason: "Lab day", RuleApplied: "set", SubjectId: `${CF.toLowerCase()}:orders.create`, SubjectType: "myob_control",
      }];
    }
    if (sql.includes("FROM dbo.TimerRuns")) return [{ StartedAt: new Date("2026-10-12T22:01:00Z") }];
    if (sql.includes("FROM dbo.DecisionLedger")) {
      return [{
        Action: "myob.push", ActorName: "Johanne", After: '{"state":"verified"}', CompanyFileId: CF, CompanyFileName: "Demo Pty Ltd", JobId: 12, MyobNumber: "66Sm261014",
        MyobUrl: null, OccurredAt: new Date("2026-10-13T00:06:00Z"), Operation: "orders.create", ProposalId: 5, ProposedBy: "Ray", Reason: null,
        Rendered: '{"document":"Order","number":"66Sm261014"}', ReviewedBy: "Johanne", RuleApplied: null,
      }];
    }
    if (sql.includes("FROM dbo.MyobApiLog")) {
      return [{ ActorKind: "user", ActorName: "Johanne", ErrorMessage: null, HttpStatus: 201, Method: "POST", OccurredAt: new Date("2026-10-13T00:05:00Z"), Path: "/accountright/x", Phase: "response", Purpose: "create-order" }];
    }
    if (sql.includes("FROM dbo.MyobCompanyFiles")) return [{ CompanyFileId: CF, Name: "Demo Pty Ltd" }];
    if (sql.includes("FROM dbo.AppUsers")) return [{ DisplayName: "Johanne", Email: "j@rp", UserID: 12 }, { DisplayName: null, Email: null, UserID: 13 }];
    return [];
  });
});

describe("loadDailyFacts", () => {
  it("reads proposal events only for registered company files, in the window, with the acting person", async () => {
    const facts = await loadDailyFacts({} as never, SINCE, UNTIL);
    const [, sql, params] = executeQuery.mock.calls.find((call: unknown[]) => String(call[1]).includes("DecisionLedger")) as [unknown, string, { name: string; value: unknown }[]];
    expect(sql).toMatch(/INNER JOIN dbo\.MyobCompanyFiles f ON f\.CompanyFileId = p\.CompanyFileId/);
    expect(sql).toMatch(/l\.SubjectType = N'myob_proposal'/);
    expect(sql).toMatch(/l\.OccurredAt >= @Since AND l\.OccurredAt < @Until/);
    expect(params).toEqual(expect.arrayContaining([expect.objectContaining({ name: "Since", value: SINCE }), expect.objectContaining({ name: "Until", value: UNTIL })]));
    expect(facts.events[0]).toMatchObject({ action: "myob.push", actorName: "Johanne", companyFileId: CF.toLowerCase(), rendered: { number: "66Sm261014" } });
    expect(facts.files).toEqual([{ id: CF.toLowerCase(), name: "Demo Pty Ltd" }]);
  });

  it("reads one outcome row per MYOB call (answered, refused or failed)", async () => {
    const facts = await loadDailyFacts({} as never, SINCE, UNTIL);
    const sql = String((executeQuery.mock.calls.find((call: unknown[]) => String(call[1]).includes("MyobApiLog")) as unknown[])[1]);
    expect(sql).toMatch(/Phase IN \(N'response', N'error'\)/);
    expect(facts.calls[0]).toMatchObject({ actorName: "Johanne", httpStatus: 201, phase: "response", purpose: "create-order" });
  });
});

describe("controls and link events", () => {
  it("are read only for registered company files, with the scope after the file in the subject", async () => {
    const facts = await loadDailyFacts({} as never, SINCE, UNTIL);
    const sql = String((executeQuery.mock.calls.find((call: unknown[]) => String(call[1]).includes("N'myob.control_change'")) as unknown[])[1]);
    expect(sql).toMatch(/l\.Action IN \(N'myob\.control_change', N'myob\.link'\)/);
    expect(sql).toMatch(/INNER JOIN dbo\.MyobCompanyFiles f\s+ON f\.CompanyFileId = CASE WHEN l\.SubjectType = N'myob_control'/);
    expect(facts.controls).toEqual([expect.objectContaining({ after: { enabled: true }, companyFileId: CF.toLowerCase(), reason: "Lab day", scope: "orders.create" })]);
  });
});

describe("lastCoveredRun", () => {
  it("is the last ok run of the daily email that did a run of the same kind (live or dry run)", async () => {
    expect(await lastCoveredRun({} as never, false)).toEqual(new Date("2026-10-12T22:01:00Z"));
    const [, sql, params] = executeQuery.mock.calls.find((call: unknown[]) => String(call[1]).includes("TimerRuns")) as [unknown, string, { name: string; value: unknown }[]];
    // The exact predicate: only an ok run of this timer whose own Counts say the same kind (a morning dry run never covers the live window).
    const where = sql.replace(/\s+/g, " ").match(/WHERE (.*) ORDER BY/)?.[1];
    expect(where).toBe("Name = N'myobDailyEmailTimer' AND Outcome = N'ok' AND (CASE WHEN ISJSON(Counts) = 1 THEN JSON_VALUE(Counts, '$.dryRun') END) = @DryRun");
    expect(sql.replace(/\s+/g, " ")).toMatch(/^SELECT TOP 1 StartedAt FROM dbo\.TimerRuns WHERE .* ORDER BY StartedAt DESC$/);
    expect(params).toEqual([expect.objectContaining({ name: "DryRun", value: "false" })]);
    await lastCoveredRun({} as never, true);
    expect(executeQuery.mock.calls.at(-1)?.[2]).toEqual([expect.objectContaining({ name: "DryRun", value: "true" })]);
  });
});

describe("loadCfoRecipients", () => {
  it("is the active cfo users", async () => {
    const recipients = await loadCfoRecipients({} as never);
    expect(String(executeQuery.mock.calls[0][1])).toMatch(/IsActive = 1 AND LOWER\(LTRIM\(RTRIM\(Role\)\)\) = N'cfo'/);
    expect(recipients).toEqual([{ email: "j@rp", name: "Johanne", userId: 12 }, { email: null, name: "User 13", userId: 13 }]);
  });
});

describe("test records (D9)", () => {
  it("leaves out proposal events for a test record or a record on a test job", async () => {
    await loadDailyFacts({} as never, SINCE, UNTIL);
    const sql = String((executeQuery.mock.calls.find((call: unknown[]) => String(call[1]).includes("DecisionLedger")) as unknown[])[1]);
    expect(sql).toMatch(/NOT EXISTS \(SELECT 1 FROM dbo\.Jobs tj WHERE tj\.JobID = p\.JobId AND tj\.IsTest = 1\)/);
    expect(sql).toMatch(/NOT EXISTS \(SELECT 1 FROM dbo\.PurchaseOrders tpo WHERE p\.SubjectType = N'purchase_order' AND tpo\.PurchaseOrderID = p\.SubjectId AND tpo\.IsTest = 1\)/);
    expect(sql).toMatch(/NOT EXISTS \(SELECT 1 FROM dbo\.Quotes tq WHERE p\.SubjectType = N'quote' AND tq\.QuoteID = p\.SubjectId AND tq\.IsTest = 1\)/);
  });

  it("hands the run the test-record keys", async () => {
    const facts = await loadDailyFacts({} as never, SINCE, UNTIL);
    expect(facts.testKeys).toBeInstanceOf(Set);
    expect(executeQuery.mock.calls.some((call: unknown[]) => String(call[1]).includes("DECLARE @Keys TABLE"))).toBe(true);
  });
});
