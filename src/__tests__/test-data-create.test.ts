import { readFileSync } from "node:fs";
import { join } from "node:path";

// D9: a record's test flag is set when it is created — by an admin or a
// director asking for it, or by an admin's "[TEST]" title prefix
// (testFlagForCreate, unit-tested in test-data.test.ts) — and written by the
// INSERT itself. It is never part of an ordinary update; only setTestFlag
// (admin, confirmed) flips it afterwards.

const SRC = join(__dirname, "..");

const CREATES = [
  { file: "functions/jobs.ts", handler: "export async function upsertJob(", insert: "INSERT INTO Jobs (" },
  { file: "functions/tenancy.ts", handler: "async function upsertRegisterTenant(", insert: "INSERT INTO dbo.Tenants (" },
  { file: "functions/tenants.ts", handler: "async function upsertTenant(", insert: "INSERT INTO dbo.Tenants (" },
  { file: "functions/inspections.ts", handler: "async function createInspection(", insert: "INSERT INTO dbo.Inspections (" },
  { file: "functions/keys.ts", handler: "async function createKey(", insert: "INSERT INTO dbo.Keys" },
  { file: "functions/vacancies.ts", handler: "async function handleCreateVacancy(", insert: "INSERT INTO dbo.Vacancies (" },
];

function handlerRegion(source: string, anchor: string): string {
  const start = source.indexOf(anchor);
  if (start === -1) return "";
  const end = source.indexOf("\n}\n", start);
  return source.slice(start, end === -1 ? undefined : end);
}

describe("records are flagged as test data when they are created (D9)", () => {
  it.each(CREATES)("$handler asks testFlagForCreate and writes IsTest", ({ file, handler, insert }) => {
    const region = handlerRegion(readFileSync(join(SRC, file), "utf8"), handler);
    expect(region).not.toBe("");
    expect(region).toMatch(/testFlagForCreate\(request,/);
    expect(region.indexOf(insert)).toBeGreaterThan(-1);
    expect(region).toMatch(/@IsTest/);
    expect(region).toMatch(/name: "IsTest",\s+type: TYPES\.Bit,\s+value: testFlag\.isTest/);
  });

  it("a job raised from an inspection takes the inspection's flag", () => {
    const source = readFileSync(join(SRC, "functions/inspections.ts"), "utf8");
    const region = handlerRegion(source, "async function raiseJobsFromInspection(");
    expect(region).toMatch(/INSERT INTO dbo\.Jobs \([\s\S]*IsTest[\s\S]*@IsTest/);
    expect(region).toMatch(/name: "IsTest", type: TYPES\.Bit, value: inspectionIsTest/);
  });
});
