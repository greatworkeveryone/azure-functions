/// <reference types="jest" />

jest.mock("../../db", () => ({ executeQuery: jest.fn() }));

import { loadRefs, writePlan } from "./mappingsStore";
import type { ImportPlan } from "./planImport";

const { executeQuery } = require("../../db") as { executeQuery: jest.Mock };
const DEMO = "0f9e8d7c-6b5a-4f3e-9d2c-1b0a99887766";
const SUP = "44444444-2222-4333-8444-555555555555";
const sqls = () => executeQuery.mock.calls.map((call: unknown[]) => String(call[1]).replace(/\s+/g, " "));

beforeEach(() => {
  jest.clearAllMocks();
  executeQuery.mockResolvedValue([]);
});

describe("loadRefs", () => {
  it("reads the existing mappings under UPDLOCK, HOLDLOCK only for an apply, with named columns", async () => {
    await loadRefs({} as never, "suppliers", false);
    await loadRefs({} as never, "suppliers", true);
    const reads = sqls().filter((sql) => sql.includes("FROM dbo.ContractorMyobSupplier"));
    expect(reads[0]).not.toMatch(/UPDLOCK/);
    expect(reads[1]).toMatch(/FROM dbo\.ContractorMyobSupplier WITH \(UPDLOCK, HOLDLOCK\)/);
    expect(sqls().join(" ")).not.toMatch(/SELECT \*/);
  });
});

describe("writePlan", () => {
  const row = (over: Partial<ImportPlan["rows"][number]>): ImportPlan["rows"][number] => ({
    after: { abn: null, supplierName: "ACME", supplierUid: SUP, taxCode: null, taxCodeUid: null }, before: null, changes: [], file: DEMO, key: `${DEMO}|12`, line: 2,
    matchBasis: "manual", message: "", outcome: "add", rowVersion: null, ...over,
  });
  const plan = (rows: ImportPlan["rows"]): ImportPlan => ({ counts: { add: 0, change: 0, skip: 0, unchanged: 0 }, hash: "h", kind: "suppliers", rows });

  it("inserts only where no row exists, and updates only the version the plan read; never deletes", async () => {
    executeQuery.mockResolvedValue([{ ContractorID: 12 }]);
    await writePlan({} as never, plan([row({}), row({ key: `${DEMO}|13`, outcome: "change", rowVersion: Buffer.from("v1").toString("base64") }), row({ outcome: "skip" }), row({ outcome: "unchanged" })]), "Johanne", "note");
    const [insert, update] = sqls();
    expect(sqls()).toHaveLength(2);
    expect(insert).toMatch(/INSERT INTO dbo\.ContractorMyobSupplier .* WHERE NOT EXISTS \(SELECT 1 FROM dbo\.ContractorMyobSupplier WHERE CompanyFileId = @File AND ContractorID = @Contractor\)/);
    expect(update).toMatch(/UPDATE dbo\.ContractorMyobSupplier SET .* WHERE CompanyFileId = @File AND ContractorID = @Contractor AND RowVersion = @RowVersion/);
    expect(sqls().join(" ")).not.toMatch(/\bDELETE\b|\bMERGE\b/);
    expect(executeQuery.mock.calls[1][2]).toEqual(expect.arrayContaining([expect.objectContaining({ name: "Contractor", value: 13 }), expect.objectContaining({ name: "By", value: "Johanne" })]));
  });

  it("refuses the whole import (409) when a row moved since the preview", async () => {
    executeQuery.mockResolvedValue([]);
    await expect(writePlan({} as never, plan([row({ outcome: "change", rowVersion: "AAAA" })]), "Johanne", "n")).rejects.toMatchObject({ status: 409 });
  });
});
