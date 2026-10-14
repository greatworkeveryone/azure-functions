import { readFileSync } from "node:fs";
import { join } from "node:path";

// Migration 121 rewrites existing ApprovalLimits rows (approved destructive
// change, beta sprint J1). It runs at startup, so it must be safe to run twice
// and must leave a deliberately set limit alone. These checks read the file as
// text; nothing touches a database. The generic destructive-migration rules
// are in migration-safety.test.ts.

const RAW = readFileSync(join(__dirname, "..", "..", "migrations", "121_approval_limits_normalise.sql"), "utf8");
const SQL = RAW.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");

function statement(pattern: RegExp): string {
  const hit = pattern.exec(SQL);
  if (!hit) throw new Error(`no statement matches ${pattern}`);
  return hit[0];
}

describe("migration 121 approval_limits_normalise", () => {
  it("carries Connor's approval, word for word", () => {
    expect(RAW.split("\n")[0]).toBe(
      "-- DESTRUCTIVE: normalise role names in dbo.ApprovalLimits · approved by Connor Randazzo 2026-10-13",
    );
  });

  it("copies every column of ApprovalLimits to ApprovalLimits_bak_20261014", () => {
    expect(statement(/SELECT[^;]*INTO dbo\.ApprovalLimits_bak_20261014\s+FROM dbo\.ApprovalLimits;/)).toMatch(
      /SELECT RoleName, MaxApprovalAmount, SYSUTCDATETIME\(\) AS BackedUpAt/,
    );
  });

  it("deletes only the two legacy timesheet rows, and only those the backup holds", () => {
    const deletes = SQL.match(/\bDELETE\b/gi) ?? [];
    expect(deletes).toHaveLength(1);
    const del = statement(/DELETE FROM dbo\.ApprovalLimits[\s\S]*?\);/);
    expect(del).toMatch(/IN \('timesheet_approval_accounts', 'timesheet_approval_facilities'\)/);
    expect(del).toMatch(/EXISTS \(\s*SELECT 1 FROM dbo\.ApprovalLimits_bak_20261014 AS b\s+WHERE b\.RoleName = ApprovalLimits\.RoleName/);
  });

  it("lower-cases role names with a binary comparison, never onto a name already taken", () => {
    const update = statement(/UPDATE a\s+SET RoleName[\s\S]*?\);/);
    expect(update).toMatch(/SET RoleName = LOWER\(LTRIM\(RTRIM\(a\.RoleName\)\)\)/);
    expect(update).toMatch(/COLLATE Latin1_General_BIN2 <> LOWER\(LTRIM\(RTRIM\(a\.RoleName\)\)\) COLLATE Latin1_General_BIN2/);
    expect(update).toMatch(/AND NOT EXISTS \(/);
  });

  it("normalises names before it looks for the admin and cfo rows", () => {
    expect(SQL.search(/UPDATE a\s+SET RoleName/)).toBeLessThan(SQL.search(/WHERE RoleName = 'admin'/));
    expect(SQL.search(/UPDATE a\s+SET RoleName/)).toBeLessThan(SQL.search(/WHERE RoleName = 'cfo'/));
  });

  it("gives admin $50,000 only where it was unlimited (NULL) or had no row", () => {
    expect(statement(/UPDATE dbo\.ApprovalLimits\s+SET MaxApprovalAmount[\s\S]*?;/)).toMatch(
      /SET MaxApprovalAmount = 50000\.00\s+WHERE RoleName = 'admin'\s+AND MaxApprovalAmount IS NULL;/,
    );
    expect(SQL).toMatch(
      /IF NOT EXISTS \(SELECT 1 FROM dbo\.ApprovalLimits WHERE RoleName = 'admin'\)\s+INSERT INTO dbo\.ApprovalLimits \(RoleName, MaxApprovalAmount\) VALUES \('admin', 50000\.00\);/,
    );
  });

  it("adds a cfo row, unlimited below the director threshold, only when none exists", () => {
    expect(SQL).toMatch(
      /IF NOT EXISTS \(SELECT 1 FROM dbo\.ApprovalLimits WHERE RoleName = 'cfo'\)\s+INSERT INTO dbo\.ApprovalLimits \(RoleName, MaxApprovalAmount\) VALUES \('cfo', NULL\);/,
    );
  });

  it("changes no other value: exactly one UPDATE of amounts and one of names", () => {
    expect(SQL.match(/\bUPDATE\b/gi)).toHaveLength(2);
  });

  it("puts the runbook line for the director threshold where Will reads it", () => {
    expect(RAW).toMatch(/DIRECTOR_APPROVAL_THRESHOLD=50000/);
    expect(RAW).toMatch(/same deploy as the J1 code, never before it/);
  });
});
