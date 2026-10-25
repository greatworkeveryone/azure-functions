/// <reference types="jest" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFECTS_PERIOD_COLUMNS } from "../defectsPeriods";
import { DEFECTS_ENFORCEMENTS, DEFECTS_SCOPES } from "../facilitiesRules";
import { DEFECTS_POLICIES } from "../escalation/adapters/defectsPeriod";

// No SQL Server in the unit tests: these pin what can be pinned from the file.
// migration-safety.test.ts adds the generic additive / guarded checks.

const sql = readFileSync(join(__dirname, "..", "..", "migrations", "119_defects_periods.sql"), "utf8");
const code = sql.replace(/--.*$/gm, "");

function checkValues(constraint: string): string[] {
  const at = code.indexOf(`CONSTRAINT ${constraint} CHECK`);
  if (at < 0) throw new Error(`${constraint} not found`);
  const list = code.slice(at).match(/\bIN \(([^)]*)\)/);
  if (!list) throw new Error(`${constraint} has no IN list`);
  return list[1].split(",").map((v) => v.trim().replace(/^N?'|'$/g, ""));
}

describe("migration 119_defects_periods.sql", () => {
  it("creates dbo.DefectsPeriods only when it is missing", () => {
    expect(code).toMatch(/IF OBJECT_ID\('dbo\.DefectsPeriods', 'U'\) IS NULL\s+BEGIN\s+CREATE TABLE dbo\.DefectsPeriods/);
  });

  it("has every column the handlers read", () => {
    const table = code.slice(code.indexOf("CREATE TABLE dbo.DefectsPeriods"), code.indexOf("\n    );"));
    for (const column of DEFECTS_PERIOD_COLUMNS.split(",").map((c) => c.trim().replace(/^d\./, ""))) {
      if (column === "") continue;
      expect(table).toMatch(new RegExp(`\\n\\s+${column}\\s+(INT|NVARCHAR|DATE|DATETIME2|BIT|ROWVERSION)\\b`));
    }
  });

  it("keeps the scope and enforcement checks in step with the rules", () => {
    expect(checkValues("CK_DefectsPeriods_Scope")).toEqual([...DEFECTS_SCOPES]);
    expect(checkValues("CK_DefectsPeriods_Enforcement")).toEqual([...DEFECTS_ENFORCEMENTS]);
  });

  it("refuses an end before practical completion and a malformed services list", () => {
    expect(code).toMatch(/CHECK \(EndsOn >= PracticalCompletion\)/);
    expect(code).toMatch(/Services = N'all' OR ISJSON\(Services\) = 1/);
  });

  it("archives rather than deletes: ArchivedAt and ArchivedBy, no DELETE anywhere", () => {
    expect(code).toMatch(/ArchivedAt\s+DATETIME2\s+NULL/);
    expect(code).toMatch(/ArchivedBy\s+NVARCHAR\(200\)\s+NULL/);
    expect(code).not.toMatch(/\bDELETE\b/i);
  });

  it("seeds the reminder policies insert-only, digest (not urgent), never overwriting an admin's edit", () => {
    for (const key of Object.values(DEFECTS_POLICIES)) {
      expect(code).toContain(`N'${key}', N'attention', 0,`);
    }
    expect(code).toMatch(/WHEN NOT MATCHED BY TARGET THEN\s+INSERT/);
    expect(code).not.toMatch(/WHEN MATCHED/);
    expect(code).toMatch(/IF OBJECT_ID\('dbo\.EscalationPolicies', 'U'\) IS NOT NULL/);
  });
});
