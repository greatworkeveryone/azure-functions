/// <reference types="jest" />

jest.mock("../../db", () => ({ executeQuery: jest.fn().mockResolvedValue([]) }));

import { loadCallRows, loadProposalRows } from "./activityStore";

const { executeQuery } = require("../../db") as { executeQuery: jest.Mock };
const CF = "0f9e8d7c-6b5a-4f3e-9d2c-1b0a99887766";
const FILTERS = { companyFileId: CF, from: new Date("2026-10-13T14:30:00Z"), state: "verified" as const, to: new Date("2026-10-16T14:30:00Z") };
const flat = (call: unknown[]) => String(call[1]).replace(/\s+/g, " ");

beforeEach(() => jest.clearAllMocks());

describe("loadProposalRows", () => {
  it("reads proposals of registered files with every filter as a parameter", async () => {
    await loadProposalRows({} as never, FILTERS);
    const sql = flat(executeQuery.mock.calls[0]);
    expect(sql).toMatch(/FROM dbo\.MyobProposals p JOIN dbo\.MyobCompanyFiles f ON f\.CompanyFileId = p\.CompanyFileId/);
    expect(sql).toMatch(/\(@File IS NULL OR p\.CompanyFileId = @File\) AND \(@State IS NULL OR p\.State = @State\) AND \(@From IS NULL OR p\.ProposedAt >= @From\) AND \(@To IS NULL OR p\.ProposedAt < @To\)/);
    expect(sql).not.toMatch(/SELECT \*|\bINSERT\b|\bUPDATE\b|\bDELETE\b/);
    expect(executeQuery.mock.calls[0][2]).toEqual(expect.arrayContaining([expect.objectContaining({ name: "File", value: CF }), expect.objectContaining({ name: "State", value: "verified" })]));
  });
});

describe("loadCallRows", () => {
  it("reads one outcome row per MYOB call in the window, with the proposal it served", async () => {
    await loadCallRows({} as never, FILTERS);
    const sql = flat(executeQuery.mock.calls[0]);
    expect(sql).toMatch(/FROM dbo\.MyobApiLog l OUTER APPLY \(SELECT TOP 1 q\.ProposalId, q\.CompanyFileId FROM dbo\.MyobProposals q WHERE q\.CorrelationId = l\.CorrelationId/);
    expect(sql).toMatch(/l\.Phase IN \(N'response', N'error'\) AND \(@From IS NULL OR l\.OccurredAt >= @From\) AND \(@To IS NULL OR l\.OccurredAt < @To\)/);
    expect(sql).not.toMatch(/SELECT \*/);
  });
});
