/// <reference types="jest" />
// Migration 099 (WP26c) runs by hand in production (npm run migrate -- --apply)
// and at startup on the local Docker database, so a failing or destructive one
// is not an option (database-safety rules). A regex tripwire over the raw file,
// like 101's, plus its policy seed held against the ladder parser. It was also
// applied twice to a throwaway SQL Server 2022 container before it was committed.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseLadder } from "../escalation/policies";
import { findDestructiveStatements } from "../migrate-files";

const FILE = "099_schedule_change_requests.sql";
const raw = readFileSync(join(__dirname, "..", "..", "migrations", FILE), "utf8");
const stripComments = (sql: string): string => sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");
const code = stripComments(raw);
const batches = code.split(/^GO\s*$/im).map((b) => b.trim()).filter(Boolean);

describe("099_schedule_change_requests.sql is additive and safe to run twice", () => {
  it("contains nothing destructive, and the runner's own scan agrees", () => {
    expect(code).not.toMatch(/\b(DROP|TRUNCATE|DELETE|sp_rename)\b/i);
    expect(code).not.toMatch(/\bALTER\s+COLUMN\b/i);
    expect(findDestructiveStatements(raw)).toEqual([]);
    expect(raw).not.toMatch(/^--\s*DESTRUCTIVE:/im);
  });

  it("never rewrites a row: no UPDATE or SELECT INTO, and the seed only inserts", () => {
    expect(code).not.toMatch(/\bUPDATE\b/i);
    expect(code).not.toMatch(/\bSELECT\b[^;]*\bINTO\b/i);
    expect(code).toMatch(/WHEN NOT MATCHED BY TARGET THEN\s+INSERT/i);
    expect(code).not.toMatch(/WHEN\s+MATCHED/i);
  });

  it("puts every CREATE and ALTER behind an existence guard, one to a batch, ahead of the statement", () => {
    const guard = /^IF\s+(NOT\s+EXISTS|COL_LENGTH|OBJECT_ID)\b/i;
    const ddl = batches.filter((batch) => /\b(CREATE|ALTER)\b/i.test(batch));
    // the table, two indexes, two columns, two checks
    expect(ddl).toHaveLength(7);
    for (const batch of ddl) {
      expect(batch).toMatch(guard);
      expect(batch.search(guard)).toBeLessThan(batch.search(/\b(CREATE|ALTER)\b/i));
      expect(batch.match(/\b(CREATE|ALTER)\b/gi)).toHaveLength(1);
    }
  });

  it("guards each object by its own name", () => {
    expect(code).toMatch(/IF OBJECT_ID\('dbo\.ScheduleChangeRequests', 'U'\) IS NULL\s+BEGIN\s+CREATE TABLE dbo\.ScheduleChangeRequests/);
    for (const index of ["IX_ScheduleChangeRequests_Tenant", "IX_ScheduleChangeRequests_State"]) {
      // Built by concatenation: a template literal of SQL text trips local/no-sql-interpolation.
      expect(code).toMatch(new RegExp("sys\\.indexes WHERE name = '" + index + "' AND object_id = OBJECT_ID\\('dbo\\.ScheduleChangeRequests'\\)\\)\\s+CREATE INDEX " + index));
    }
    for (const column of ["RentReliefs", "CpiReferenceQuarterRule"]) {
      expect(code).toMatch(new RegExp(`IF COL_LENGTH\\('dbo\\.Tenants', '${column}'\\) IS NULL\\s+ALTER TABLE dbo\\.Tenants ADD ${column} `));
    }
    for (const check of ["CK_Tenants_RentReliefs", "CK_Tenants_CpiReferenceQuarterRule"]) {
      expect(code).toMatch(new RegExp("sys\\.check_constraints WHERE name = '" + check + "' AND parent_object_id = OBJECT_ID\\('dbo\\.Tenants'\\)\\)\\s+ALTER TABLE dbo\\.Tenants ADD CONSTRAINT " + check));
    }
  });

  it("adds a column in one batch and checks it only in a later one", () => {
    const addedAt = (column: string) => batches.findIndex((batch) => new RegExp(`ADD ${column} `).test(batch));
    const checkedAt = (check: string) => batches.findIndex((batch) => batch.includes(`ADD CONSTRAINT ${check}`));
    expect(addedAt("RentReliefs")).toBeLessThan(checkedAt("CK_Tenants_RentReliefs"));
    expect(addedAt("CpiReferenceQuarterRule")).toBeLessThan(checkedAt("CK_Tenants_CpiReferenceQuarterRule"));
  });
});

describe("dbo.ScheduleChangeRequests", () => {
  const table = code.slice(code.indexOf("CREATE TABLE dbo.ScheduleChangeRequests"), code.indexOf("END", code.indexOf("CREATE TABLE")));

  it("has the plan's columns, decided ones nullable, and a rowversion", () => {
    const columns: Array<[string, RegExp]> = [
      ["RequestId", /RequestId\s+NVARCHAR\(40\)\s+NOT NULL/],
      ["TenantId", /TenantId\s+INT\s+NOT NULL/],
      ["Kind", /Kind\s+NVARCHAR\(20\)\s+NOT NULL/],
      ["Payload", /Payload\s+NVARCHAR\(MAX\)\s+NOT NULL/],
      ["Reason", /Reason\s+NVARCHAR\(2000\)\s+NOT NULL/],
      ["State", /State\s+NVARCHAR\(16\)\s+NOT NULL CONSTRAINT DF_ScheduleChangeRequests_State DEFAULT N'pending'/],
      ["RequestedById", /RequestedById\s+INT\s+NULL/],
      ["RequestedByName", /RequestedByName\s+NVARCHAR\(200\)\s+NOT NULL/],
      ["RequestedAt", /RequestedAt\s+DATETIME2\(3\)\s+NOT NULL CONSTRAINT DF_ScheduleChangeRequests_RequestedAt DEFAULT SYSUTCDATETIME\(\)/],
      ["DecidedById", /DecidedById\s+INT\s+NULL/],
      ["DecidedByName", /DecidedByName\s+NVARCHAR\(200\)\s+NULL/],
      ["DecidedAt", /DecidedAt\s+DATETIME2\(3\)\s+NULL/],
      ["DecisionNote", /DecisionNote\s+NVARCHAR\(2000\)\s+NULL/],
      ["Version", /Version\s+ROWVERSION\s+NOT NULL/],
    ];
    for (const [, pattern] of columns) expect(table).toMatch(pattern);
  });

  it("checks the kind, the state, the payload's JSON, a reason, and who decided", () => {
    expect(table).toMatch(/CHECK \(Kind IN \(N'relief', N'ratchet_override', N'manual_change'\)\)/);
    expect(table).toMatch(/CHECK \(State IN \(N'pending', N'ratified', N'rejected', N'withdrawn'\)\)/);
    expect(table).toMatch(/CHECK \(ISJSON\(Payload\) = 1\)/);
    expect(table).toMatch(/CHECK \(LEN\(Reason\) > 0\)/);
    expect(table).toMatch(/\(State = N'pending' AND DecidedAt IS NULL\)\s+OR \(State <> N'pending' AND DecidedAt IS NOT NULL AND DecidedByName IS NOT NULL\)/);
  });

  it("points at its tenancy without a cascade, so deleting a tenancy can't take its requests with it", () => {
    expect(table).toMatch(/FOREIGN KEY \(TenantId\) REFERENCES dbo\.Tenants \(TenantId\)/);
    expect(code).not.toMatch(/\bON\s+(DELETE|UPDATE)\b/i);
  });
});

describe("the Tenants columns", () => {
  it("adds RentReliefs and CpiReferenceQuarterRule as NULL", () => {
    expect(code).toMatch(/ALTER TABLE dbo\.Tenants ADD RentReliefs NVARCHAR\(MAX\) NULL;/);
    expect(code).toMatch(/ALTER TABLE dbo\.Tenants ADD CpiReferenceQuarterRule NVARCHAR\(32\) NULL;/);
  });

  it("holds RentReliefs to JSON and the reference quarter to the two rules", () => {
    expect(code).toMatch(/CHECK \(RentReliefs IS NULL OR ISJSON\(RentReliefs\) = 1\)/);
    expect(code).toMatch(/CHECK \(CpiReferenceQuarterRule IS NULL OR CpiReferenceQuarterRule IN \(N'quarter_before_review_date', N'latest_published_before_review'\)\)/);
  });
});

describe("the schedule.change_ratification policy", () => {
  const seed = [...code.matchAll(/\(N'([\w.]+)',\s*N'(\w+)',\s*(\d),\s*N'(\w+)',\s*N'(\w+)',\s*N'(\[[^']*\])',\s*(\d)\)/g)];

  it("is the one row seeded, an authority escalation to the directors with reminders, active", () => {
    expect(seed.map((m) => m[1])).toEqual(["schedule.change_ratification"]);
    const [, , kind, urgent, clock, auto, ladder, active] = seed[0];
    expect({ active, auto, clock, kind, urgent }).toEqual({ active: "1", auto: "reminder", clock: "business", kind: "authority", urgent: "0" });
    expect(parseLadder(ladder)).toEqual([{ role: "director", slaHours: 16 }]);
  });

  it("waits for 098's table and says who inserted it", () => {
    const batch = batches.find((b) => b.includes("MERGE dbo.EscalationPolicies")) ?? "";
    expect(batch).toMatch(/^IF OBJECT_ID\(N'dbo\.EscalationPolicies', N'U'\) IS NOT NULL\s+BEGIN/);
    expect(code).toContain("N'migration:099_schedule_change_requests'");
  });
});
