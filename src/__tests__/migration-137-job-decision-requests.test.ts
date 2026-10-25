/// <reference types="jest" />
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { findDestructiveStatements, migrationFromSql, validateMigration } from "../migrate-files";
import { parseLadder } from "../escalation/policies";

// Migration 137 is applied by hand in production and a failing one stops the API
// on startup elsewhere, so the file is held to the database-safety rules here, as
// well as being run against a throwaway SQL Server before it merged. This is a
// regex tripwire over the raw file, not a SQL parser.

const FILE = "137_job_decision_requests.sql";
const DIR = join(__dirname, "..", "..", "migrations");
const raw = readFileSync(join(DIR, FILE), "utf8");

const stripComments = (sql: string): string => sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");
const code = stripComments(raw);
const batches = code.split(/^GO\s*$/im).map((b) => b.trim()).filter(Boolean);

const tableBody = code.slice(code.indexOf("CREATE TABLE dbo.JobDecisionRequests"), code.indexOf("\nGO", code.indexOf("CREATE TABLE dbo.JobDecisionRequests")));

describe("137_job_decision_requests.sql is additive and safe to run twice", () => {
  it("contains nothing destructive, comments included", () => {
    expect(raw).not.toMatch(/\bDROP\s+(TABLE|COLUMN)\b|\bTRUNCATE\b|\bDELETE\s+FROM\b|\bALTER\s+COLUMN\b|\bsp_rename\b/i);
    expect(code).not.toMatch(/\b(DROP|TRUNCATE|DELETE)\b/i);
  });

  it("passes the runner's own scan and needs no approval header", () => {
    expect(findDestructiveStatements(raw)).toEqual([]);
    expect(validateMigration(migrationFromSql(FILE, raw))).toEqual([]);
  });

  it("never rewrites existing values or alters an existing table", () => {
    expect(code).not.toMatch(/\bUPDATE\b/i);
    expect(code).not.toMatch(/\bALTER\s+TABLE\b/i);
  });

  it("puts every CREATE behind an existence guard, ahead of the CREATE", () => {
    const guard = /^IF\s+(NOT\s+EXISTS|OBJECT_ID)\b/i;
    const creating = batches.filter((b) => /\bCREATE\b/i.test(b));
    expect(creating).toHaveLength(4);
    for (const batch of creating) {
      expect(batch).toMatch(guard);
      expect(batch.search(guard)).toBeLessThan(batch.search(/\bCREATE\b/i));
    }
  });

  it("seeds with MERGE ... WHEN NOT MATCHED THEN INSERT only, so an admin's edit survives a re-run", () => {
    expect(code).toMatch(/MERGE\s+dbo\.EscalationPolicies/i);
    expect(code).toMatch(/WHEN NOT MATCHED BY TARGET THEN\s+INSERT/i);
    expect(code).not.toMatch(/WHEN\s+MATCHED/i);
    expect(code.match(/\bMERGE\b/gi)).toHaveLength(1);
  });

  it("is run by the runner inside one transaction", () => {
    expect(migrationFromSql(FILE, raw)).toMatchObject({ transactional: true, transactionNote: null });
  });

  it("creates the requests table and no JobDecisions table (that is migration 138's)", () => {
    expect(code).toMatch(/CREATE TABLE dbo\.JobDecisionRequests/);
    expect(code).not.toMatch(/JobDecisions\b/);
    expect(readdirSync(DIR).filter((f) => f.startsWith("137_"))).toEqual([FILE]);
  });
});

describe("dbo.JobDecisionRequests", () => {
  it("has the columns the plan names", () => {
    for (const column of [
      "RequestId", "JobId", "Question", "DecisionMakers", "AssignmentMode", "Tier", "RespondBy", "RoutineWeeks",
      "AutoEscalate", "SourceAttachmentId", "State", "RequestedBy", "RequestedAt", "RowVersion",
    ]) {
      expect(tableBody).toContain(column);
    }
    expect(tableBody).toMatch(/RequestId\s+INT\s+IDENTITY\(1,1\)\s+NOT NULL/);
    expect(tableBody).toMatch(/Question\s+NVARCHAR\(2000\)\s+NOT NULL/);
    expect(tableBody).toMatch(/RespondBy\s+DATETIME2\(3\)\s+NULL/);
    expect(tableBody).toMatch(/AutoEscalate\s+BIT\s+NOT NULL,/);
    expect(tableBody).toMatch(/SourceAttachmentId\s+INT\s+NULL/);
    expect(tableBody).toMatch(/RowVersion\s+ROWVERSION\s+NOT NULL/);
    expect(tableBody).toMatch(/PRIMARY KEY CLUSTERED \(RequestId\)/);
  });

  it("records a withdrawal with who, when and why, all nullable until it happens", () => {
    expect(tableBody).toMatch(/WithdrawnAt\s+DATETIME2\(3\)\s+NULL/);
    expect(tableBody).toMatch(/WithdrawnBy\s+NVARCHAR\(200\)\s+NULL/);
    expect(tableBody).toMatch(/WithdrawnReason\s+NVARCHAR\(1000\)\s+NULL/);
  });

  it("refers to the job and to the file, and cascades nothing", () => {
    expect(tableBody).toMatch(/FOREIGN KEY \(JobId\)\s+REFERENCES dbo\.Jobs\(JobID\)/);
    expect(tableBody).toMatch(/FOREIGN KEY \(SourceAttachmentId\)\s+REFERENCES dbo\.Attachments\(Id\)/);
    expect(tableBody).not.toMatch(/ON\s+DELETE|ON\s+UPDATE/i);
  });

  it("checks the vocabularies: mode, tier and state, and that the people are JSON", () => {
    expect(tableBody).toMatch(/AssignmentMode IN \(N'named', N'role'\)/);
    expect(tableBody).toMatch(/Tier IN \(N'emergency', N'urgent', N'soon', N'routine', N'fixed'\)/);
    expect(tableBody).toMatch(/State IN \(N'pending', N'answered', N'withdrawn'\)/);
    expect(tableBody).toMatch(/ISJSON\(DecisionMakers\) = 1/);
    expect(tableBody).toMatch(/LEN\(LTRIM\(RTRIM\(Question\)\)\) > 0/);
  });

  it("ties the weeks to the routine tier, and the deadline to every tier but emergency, naming NOT NULL (a CHECK lets UNKNOWN through)", () => {
    expect(tableBody).toMatch(/Tier = N'routine' AND RoutineWeeks IS NOT NULL AND RoutineWeeks BETWEEN 2 AND 8/);
    expect(tableBody).toMatch(/Tier <> N'routine' AND RoutineWeeks IS NULL/);
    expect(tableBody).toMatch(/Tier = N'emergency' AND RespondBy IS NULL/);
    expect(tableBody).toMatch(/Tier <> N'emergency' AND RespondBy IS NOT NULL/);
  });

  it("ties the move-up to the tier: always for soon, routine and fixed, never for an emergency, the raiser's tick for urgent", () => {
    expect(tableBody).toMatch(/CONSTRAINT CK_JobDecisionRequests_AutoEscalate CHECK/);
    expect(tableBody).toMatch(/Tier = N'emergency' AND AutoEscalate = 0/);
    expect(tableBody).toMatch(/OR Tier = N'urgent'\s/);
    expect(tableBody).toMatch(/Tier IN \(N'soon', N'routine', N'fixed'\) AND AutoEscalate = 1/);
  });

  it("makes a withdrawal carry its time and reason", () => {
    expect(tableBody).toMatch(/State = N'withdrawn' AND WithdrawnAt IS NOT NULL AND WithdrawnReason IS NOT NULL/);
    expect(tableBody).toMatch(/State <> N'withdrawn' AND WithdrawnAt IS NULL/);
  });

  it("starts a request pending and stamps when it was asked", () => {
    expect(tableBody).toMatch(/State\s+NVARCHAR\(10\)\s+NOT NULL CONSTRAINT DF_JobDecisionRequests_State DEFAULT N'pending'/);
    expect(tableBody).toMatch(/RequestedAt\s+DATETIME2\(3\)\s+NOT NULL CONSTRAINT DF_JobDecisionRequests_RequestedAt DEFAULT SYSUTCDATETIME\(\)/);
  });

  it("indexes the job, allows one pending request per job, and finds the requests a file is the subject of", () => {
    expect(code).toMatch(/CREATE INDEX IX_JobDecisionRequests_JobId\s+ON dbo\.JobDecisionRequests \(JobId, RequestId DESC\)/);
    expect(code).toMatch(/CREATE UNIQUE INDEX UX_JobDecisionRequests_Pending\s+ON dbo\.JobDecisionRequests \(JobId\)\s+WHERE State = N'pending'/);
    expect(code).toMatch(/CREATE INDEX IX_JobDecisionRequests_SourceAttachment\s+ON dbo\.JobDecisionRequests \(SourceAttachmentId\)\s+WHERE SourceAttachmentId IS NOT NULL/);
  });

  it("sets the session options a filtered index needs, in a batch of their own", () => {
    expect(batches[0]).toBe("SET QUOTED_IDENTIFIER ON;\nSET ANSI_NULLS ON;");
  });
});

describe("the code and the table agree", () => {
  const store = readFileSync(join(__dirname, "..", "jobDecisions", "store.ts"), "utf8");
  const tableColumns = tableBody
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[A-Z]\w+\s+(INT|BIT|NVARCHAR|DATETIME2|ROWVERSION)/.test(line))
    .map((line) => line.split(/\s+/)[0]);

  it("finds the table's columns", () => {
    expect(tableColumns).toEqual([
      "RequestId", "JobId", "Question", "DecisionMakers", "AssignmentMode", "Tier", "RespondBy", "RoutineWeeks", "AutoEscalate",
      "SourceAttachmentId", "State", "RequestedBy", "RequestedByUserId", "RequestedAt", "WithdrawnAt", "WithdrawnBy", "WithdrawnByUserId", "WithdrawnReason", "RowVersion",
    ]);
  });

  it("has every column the store inserts", () => {
    const insert = store.match(/INSERT INTO dbo\.JobDecisionRequests\s*\(([^)]*)\)/);
    expect(insert).not.toBeNull();
    const columns = (insert as RegExpMatchArray)[1].split(",").map((c) => c.trim());
    expect(columns.length).toBeGreaterThan(8);
    for (const column of columns) expect(tableColumns).toContain(column);
  });

  it("has every column the store selects", () => {
    const list = store.match(/const REQUEST_COLUMNS = `([^`]*)`/);
    expect(list).not.toBeNull();
    const columns = (list as RegExpMatchArray)[1].split(",").map((c) => c.trim());
    expect(columns.sort()).toEqual([...tableColumns].sort());
  });

  it("has every column the store updates when a request is withdrawn", () => {
    const set = store.match(/const WITHDRAW_SET = `([^`]*)`/);
    expect(set).not.toBeNull();
    const columns = (set as RegExpMatchArray)[1].split(",").map((part) => part.split("=")[0].trim());
    expect(columns).toEqual(["State", "WithdrawnAt", "WithdrawnBy", "WithdrawnByUserId", "WithdrawnReason"]);
    for (const column of columns) expect(tableColumns).toContain(column);
  });

  it("states the same vocabularies the code does", () => {
    const { DECISION_TIERS } = require("../jobDecisions/tiers") as typeof import("../jobDecisions/tiers");
    const checked = tableBody.match(/Tier IN \(([^)]*)\)/)![1].split(",").map((t) => t.trim().replace(/^N'|'$/g, ""));
    expect(checked).toEqual([...DECISION_TIERS]);
  });

  it("never produces a schedule the AutoEscalate CHECK would refuse", () => {
    const { DECISION_TIERS, scheduleFor } = require("../jobDecisions/tiers") as typeof import("../jobDecisions/tiers");
    // The CHECK, written out: emergency off, urgent either, the rest on.
    const allowed = (tier: string, autoEscalate: boolean): boolean => (tier === "emergency" ? !autoEscalate : tier === "urgent" ? true : autoEscalate);
    const now = new Date("2026-10-12T00:30:00Z");
    const own: Record<string, object> = { fixed: { fixedDate: "2026-10-23" }, routine: { routineWeeks: 3 } };
    for (const tier of DECISION_TIERS) {
      for (const tick of [undefined, true]) {
        const schedule = scheduleFor({ ...own[tier], ...(tick === undefined ? {} : { autoEscalate: tick }), tier }, now);
        expect({ allowed: allowed(tier, schedule.autoEscalate), tick, tier }).toEqual({ allowed: true, tick, tier });
        // and what is stored says what the engine will do: no due moment, no move-up
        expect({ moves: schedule.escalateAt !== null, tier }).toEqual({ moves: schedule.autoEscalate, tier });
      }
    }
  });

  it("seeds the policy under the key the code raises", () => {
    const { DECISION_PENDING_POLICY } = require("../escalation/decisionRows") as typeof import("../escalation/decisionRows");
    expect(code).toContain(`N'${DECISION_PENDING_POLICY}'`);
  });
});

describe("the job.decision_pending policy seed", () => {
  const seed = [...code.matchAll(/\(N'([a-z_.]+)', N'(attention|authority)', ([01]), N'(business|wall)', N'(yes|reminder|nudge|no)',\s*N'(\[.*?\])', ([01])\)/g)].map((m) => ({
    active: m[7] === "1",
    autoReescalate: m[5],
    clock: m[4],
    kind: m[2],
    ladder: m[6],
    policyKey: m[1],
    urgent: m[3] === "1",
  }));

  it("seeds exactly one policy, active, with the escalation engine's own vocabulary", () => {
    expect(seed).toHaveLength(1);
    expect(seed[0]).toMatchObject({
      active: true,
      autoReescalate: "yes",
      clock: "business",
      kind: "authority",
      policyKey: "job.decision_pending",
      urgent: false,
    });
  });

  it("is an authority policy, so a decision request can only end by being decided or withdrawn", () => {
    expect(seed[0].kind).toBe("authority");
  });

  it("goes to the people asked, then the raiser's manager, then a director", () => {
    expect(parseLadder(seed[0].ladder)).toEqual([{ userTarget: true }, { slaHours: 16, token: "raiser_manager" }, { role: "director" }]);
  });

  it("writes the seeded values on insert only, so an admin's switch survives a re-run", () => {
    expect(code).toMatch(/INSERT \(PolicyKey, Kind, Urgent, Clock, AutoReescalate, Ladder, Active, UpdatedBy\)/);
    expect(code).toMatch(/source\.Ladder, source\.Active, N'migration:137_job_decision_requests'/);
    expect(code).toMatch(/AS v \(PolicyKey, Kind, Urgent, Clock, AutoReescalate, Ladder, Active\)/);
  });
});
