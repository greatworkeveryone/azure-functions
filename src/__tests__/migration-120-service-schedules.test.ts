/// <reference types="jest" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SCHEDULE_COLUMNS } from "../serviceSchedules";
import { INTERVAL_UNITS } from "../facilitiesRules";
import { SCHEDULE_POLICIES } from "../escalation/adapters/serviceSchedule";
import { RUN_OUTCOMES } from "../serviceScheduleRuns";

const sql = readFileSync(join(__dirname, "..", "..", "migrations", "120_service_schedules.sql"), "utf8");
const code = sql.replace(/--.*$/gm, "");

function tableBlock(table: string): string {
  const start = code.indexOf(`CREATE TABLE dbo.${table} (`);
  return code.slice(start, code.indexOf("\n    );", start));
}

function checkValues(constraint: string): string[] {
  const at = code.indexOf(`CONSTRAINT ${constraint} CHECK`);
  const list = code.slice(at).match(/\bIN \(([^)]*)\)/);
  if (at < 0 || !list) throw new Error(`${constraint} not found`);
  return list[1].split(",").map((v) => v.trim().replace(/^N?'|'$/g, ""));
}

describe("migration 120_service_schedules.sql", () => {
  it("creates both tables only when missing", () => {
    expect(code).toMatch(/IF OBJECT_ID\('dbo\.ServiceSchedules', 'U'\) IS NULL\s+BEGIN\s+CREATE TABLE dbo\.ServiceSchedules/);
    expect(code).toMatch(/IF OBJECT_ID\('dbo\.ServiceScheduleRuns', 'U'\) IS NULL\s+BEGIN\s+CREATE TABLE dbo\.ServiceScheduleRuns/);
  });

  it("has every schedule column the handlers read", () => {
    const table = tableBlock("ServiceSchedules");
    for (const column of SCHEDULE_COLUMNS.split(",").map((c) => c.trim().replace(/^s\./, "")).filter(Boolean)) {
      expect(table).toMatch(new RegExp(`\\n\\s+${column}\\s+(INT|NVARCHAR|DATE|DATETIME2|BIT|ROWVERSION)\\b`));
    }
  });

  it("keeps interval units and run outcomes in step with the code", () => {
    expect(checkValues("CK_ServiceSchedules_IntervalUnit")).toEqual([...INTERVAL_UNITS]);
    expect(checkValues("CK_ServiceScheduleRuns_Outcome")).toEqual([...RUN_OUTCOMES]);
  });

  it("makes one run per schedule and due date: the scheduler's idempotency guard", () => {
    expect(code).toMatch(/CREATE UNIQUE INDEX UX_ServiceScheduleRuns_Schedule_Due\s+ON dbo\.ServiceScheduleRuns \(ServiceScheduleId, DueDate\)/);
  });

  it("defaults lead days to 14 and requires an asset or a described scope", () => {
    expect(code).toMatch(/LeadDays\s+INT\s+NOT NULL CONSTRAINT DF_ServiceSchedules_LeadDays DEFAULT 14/);
    expect(code).toMatch(/CHECK \(AssetId IS NOT NULL OR Scope IS NOT NULL\)/);
  });

  it("archives rather than deletes, and seeds the overdue policies insert-only", () => {
    expect(code).toMatch(/ArchivedAt\s+DATETIME2\s+NULL/);
    expect(code).toContain(`N'${SCHEDULE_POLICIES.overdue}', N'attention', 0,`);
    expect(code).toContain(`N'${SCHEDULE_POLICIES.overdueUrgent}', N'attention', 1,`);
    expect(code).not.toMatch(/WHEN MATCHED/);
    expect(code).not.toMatch(/\bDELETE\b|\bON DELETE\b/i);
  });
});
