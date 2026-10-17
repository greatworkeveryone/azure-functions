/// <reference types="jest" />
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { findDestructiveStatements, migrationFromSql, validateMigration } from "../migrate-files";
import { parseLadder } from "../escalation/policies";

// Migration 138 is applied by hand in production and a failing one stops the API
// on startup elsewhere, so the file is held to the database-safety rules here, as
// well as being run against a throwaway SQL Server before it merged. This is a
// regex tripwire over the raw file, not a SQL parser.

const FILE = "138_job_decisions.sql";
const DIR = join(__dirname, "..", "..", "migrations");
const raw = readFileSync(join(DIR, FILE), "utf8");

const stripComments = (sql: string): string => sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");
const code = stripComments(raw);
const batches = code.split(/^GO\s*$/im).map((b) => b.trim()).filter(Boolean);

const tableStart = code.indexOf("CREATE TABLE dbo.JobDecisions");
const tableBody = code.slice(tableStart, code.indexOf("\nGO", tableStart));

describe("138_job_decisions.sql is additive and safe to run twice", () => {
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
    expect(creating).toHaveLength(5); // the table and its four indexes
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

  it("stops with a plain message, not a foreign key error, when 137 has not been applied", () => {
    const precondition = batches.find((b) => /THROW/.test(b)) ?? "";
    expect(precondition).toMatch(/^IF OBJECT_ID\('dbo\.JobDecisionRequests', 'U'\) IS NULL/);
    expect(precondition).toMatch(/;THROW 51138, N'Apply migration 137 first: dbo\.JobDecisionRequests does not exist\.', 1;/);
    expect(batches.indexOf(precondition)).toBeLessThan(batches.findIndex((b) => /CREATE TABLE dbo\.JobDecisions/.test(b)));
  });

  it("is the one 138, after 137, and the last for now", () => {
    expect(readdirSync(DIR).filter((f) => f.startsWith("138_"))).toEqual([FILE]);
    expect(readdirSync(DIR).filter((f) => f.startsWith("137_"))).toHaveLength(1);
    expect(readdirSync(DIR).some((f) => f.startsWith("139_"))).toBe(false);
  });

  it("sets the session options a filtered index needs, in a batch of their own", () => {
    expect(batches[0]).toBe("SET QUOTED_IDENTIFIER ON;\nSET ANSI_NULLS ON;");
  });
});

describe("dbo.JobDecisions", () => {
  it("has the columns the plan names, and the ones the step and the re-ask need", () => {
    for (const column of [
      "DecisionId", "RequestId", "JobId", "Outcome", "Rationale", "NextStep", "NextStepOwnerUserId", "NextStepOwnerRole", "NextStepDueAt",
      "DeferUntil", "ReaskRequestId", "RespondedById", "RespondedByName", "RespondedAt", "NextStepClosedAt", "NextStepClosedKind",
      "NextStepClosedById", "NextStepClosedByName", "NextStepClosedNote", "RowVersion",
    ]) {
      expect(tableBody).toContain(column);
    }
    expect(tableBody).toMatch(/DecisionId\s+INT\s+IDENTITY\(1,1\)\s+NOT NULL/);
    expect(tableBody).toMatch(/RequestId\s+INT\s+NOT NULL/);
    expect(tableBody).toMatch(/JobId\s+INT\s+NOT NULL/);
    expect(tableBody).toMatch(/Outcome\s+NVARCHAR\(10\)\s+NOT NULL/);
    expect(tableBody).toMatch(/Rationale\s+NVARCHAR\(4000\)\s+NOT NULL/);
    expect(tableBody).toMatch(/NextStep\s+NVARCHAR\(2000\)\s+NULL/);
    expect(tableBody).toMatch(/NextStepOwnerRole\s+NVARCHAR\(32\)\s+NULL/);
    expect(tableBody).toMatch(/NextStepDueAt\s+DATETIME2\(3\)\s+NULL/);
    expect(tableBody).toMatch(/DeferUntil\s+DATE\s+NULL/);
    expect(tableBody).toMatch(/RespondedByName\s+NVARCHAR\(200\)\s+NOT NULL/);
    expect(tableBody).toMatch(/RespondedAt\s+DATETIME2\(3\)\s+NOT NULL CONSTRAINT DF_JobDecisions_RespondedAt DEFAULT SYSUTCDATETIME\(\)/);
    expect(tableBody).toMatch(/RowVersion\s+ROWVERSION\s+NOT NULL/);
    expect(tableBody).toMatch(/PRIMARY KEY CLUSTERED \(DecisionId\)/);
  });

  it("has room for the longest rationale the API takes, and an owner role as long as any role", () => {
    const { RATIONALE_MAX_CHARS, NEXT_STEP_MAX_CHARS, STEP_NOTE_MAX_CHARS } = require("../jobDecisions/respond") as typeof import("../jobDecisions/respond");
    expect(RATIONALE_MAX_CHARS).toBeLessThanOrEqual(4000);
    expect(NEXT_STEP_MAX_CHARS).toBeLessThanOrEqual(2000);
    expect(STEP_NOTE_MAX_CHARS).toBeLessThanOrEqual(1000);
    expect(tableBody).toMatch(/NextStepClosedNote\s+NVARCHAR\(1000\)\s+NULL/);
    const { NEXT_STEP_OWNER_ROLES } = require("../jobDecisions/roles") as typeof import("../jobDecisions/roles");
    for (const role of NEXT_STEP_OWNER_ROLES) expect(role.length).toBeLessThanOrEqual(32);
  });

  it("refers to the request, the re-ask's request and the job, and cascades nothing", () => {
    expect(tableBody).toMatch(/FOREIGN KEY \(RequestId\)\s+REFERENCES dbo\.JobDecisionRequests\(RequestId\)/);
    expect(tableBody).toMatch(/FOREIGN KEY \(ReaskRequestId\)\s+REFERENCES dbo\.JobDecisionRequests\(RequestId\)/);
    expect(tableBody).toMatch(/FOREIGN KEY \(JobId\)\s+REFERENCES dbo\.Jobs\(JobID\)/);
    expect(tableBody).not.toMatch(/ON\s+DELETE|ON\s+UPDATE/i);
  });

  it("checks the vocabulary, and that the rationale is not blank", () => {
    expect(tableBody).toMatch(/Outcome IN \(N'approve', N'deny', N'defer', N'revise'\)/);
    expect(tableBody).toMatch(/LEN\(LTRIM\(RTRIM\(Rationale\)\)\) > 0/);
  });

  it("ties a next step to its owner and its due moment: all or none, one owner never two, naming NOT NULL (a CHECK lets UNKNOWN through)", () => {
    expect(tableBody).toMatch(/NextStep IS NULL AND NextStepOwnerUserId IS NULL AND NextStepOwnerRole IS NULL AND NextStepDueAt IS NULL/);
    expect(tableBody).toMatch(/NextStep IS NOT NULL AND LEN\(LTRIM\(RTRIM\(NextStep\)\)\) > 0 AND NextStepDueAt IS NOT NULL/);
    expect(tableBody).toMatch(/NextStepOwnerUserId IS NOT NULL AND NextStepOwnerRole IS NULL/);
    expect(tableBody).toMatch(/NextStepOwnerUserId IS NULL AND NextStepOwnerRole IS NOT NULL/);
  });

  it("requires a next step for everything but a deferral", () => {
    expect(tableBody).toMatch(/CONSTRAINT CK_JobDecisions_NextStepNeeded CHECK \(Outcome = N'defer' OR NextStep IS NOT NULL\)/);
  });

  it("gives a deferral its day and no other outcome one", () => {
    expect(tableBody).toMatch(/Outcome = N'defer' AND DeferUntil IS NOT NULL/);
    expect(tableBody).toMatch(/Outcome <> N'defer' AND DeferUntil IS NULL/);
    expect(tableBody).toMatch(/CONSTRAINT CK_JobDecisions_Reask CHECK \(ReaskRequestId IS NULL OR Outcome = N'defer'\)/);
  });

  it("closes a step all at once or not at all, and only a step that exists", () => {
    expect(tableBody).toMatch(/NextStepClosedAt IS NULL AND NextStepClosedKind IS NULL AND NextStepClosedById IS NULL\s+AND NextStepClosedByName IS NULL AND NextStepClosedNote IS NULL/);
    expect(tableBody).toMatch(
      /NextStep IS NOT NULL AND NextStepClosedAt IS NOT NULL\s+AND NextStepClosedKind IS NOT NULL AND NextStepClosedKind IN \(N'done', N'replaced'\)\s+AND NextStepClosedByName IS NOT NULL/,
    );
  });

  it("answers a request once, finds a job's decisions, asks a deferral again once, and scans the deferrals waiting", () => {
    expect(code).toMatch(/CREATE UNIQUE INDEX UX_JobDecisions_Request\s+ON dbo\.JobDecisions \(RequestId\)/);
    expect(code).toMatch(/CREATE INDEX IX_JobDecisions_JobId\s+ON dbo\.JobDecisions \(JobId, DecisionId DESC\)/);
    expect(code).toMatch(/CREATE UNIQUE INDEX UX_JobDecisions_Reask\s+ON dbo\.JobDecisions \(ReaskRequestId\)\s+WHERE ReaskRequestId IS NOT NULL/);
    expect(code).toMatch(/CREATE INDEX IX_JobDecisions_DeferDue\s+ON dbo\.JobDecisions \(DeferUntil, DecisionId\)\s+INCLUDE \(JobId, RequestId\)\s+WHERE Outcome = N'defer' AND ReaskRequestId IS NULL/);
  });
});

describe("the code and the table agree", () => {
  const store = readFileSync(join(__dirname, "..", "jobDecisions", "decisionsStore.ts"), "utf8");
  const tableColumns = tableBody
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[A-Z]\w+\s+(INT|BIT|NVARCHAR|DATETIME2|DATE|ROWVERSION)/.test(line))
    .map((line) => line.split(/\s+/)[0]);

  it("finds the table's columns", () => {
    expect(tableColumns).toEqual([
      "DecisionId", "RequestId", "JobId", "Outcome", "Rationale", "NextStep", "NextStepOwnerUserId", "NextStepOwnerRole", "NextStepDueAt", "DeferUntil",
      "ReaskRequestId", "RespondedById", "RespondedByName", "RespondedAt", "NextStepClosedAt", "NextStepClosedKind", "NextStepClosedById",
      "NextStepClosedByName", "NextStepClosedNote", "RowVersion",
    ]);
  });

  it("has every column the store inserts", () => {
    const insert = store.match(/INSERT INTO dbo\.JobDecisions\s*\(([^)]*)\)/);
    expect(insert).not.toBeNull();
    const columns = (insert as RegExpMatchArray)[1].split(",").map((c) => c.trim());
    expect(columns.length).toBeGreaterThan(8);
    for (const column of columns) expect(tableColumns).toContain(column);
  });

  it("has every column the store selects", () => {
    const list = store.match(/const DECISION_COLUMNS = `([^`]*)`/);
    expect(list).not.toBeNull();
    const columns = (list as RegExpMatchArray)[1].split(",").map((c) => c.trim());
    expect([...columns].sort()).toEqual([...tableColumns].sort());
  });

  it("has every column the store sets when it closes a step", () => {
    const set = store.match(/const CLOSE_SET = `([^`]*)`/);
    expect(set).not.toBeNull();
    const columns = (set as RegExpMatchArray)[1].split(",").map((part) => part.split("=")[0].trim());
    expect(columns).toEqual(["NextStepClosedAt", "NextStepClosedKind", "NextStepClosedById", "NextStepClosedByName", "NextStepClosedNote"]);
    for (const column of columns) expect(tableColumns).toContain(column);
  });

  it("states the same vocabularies the code does", () => {
    const { OUTCOMES } = require("../jobDecisions/respond") as typeof import("../jobDecisions/respond");
    const checked = tableBody.match(/Outcome IN \(([^)]*)\)/)![1].split(",").map((t) => t.trim().replace(/^N'|'$/g, ""));
    expect(checked).toEqual([...OUTCOMES]);
    const kinds = tableBody.match(/NextStepClosedKind IN \(([^)]*)\)/)![1].split(",").map((t) => t.trim().replace(/^N'|'$/g, ""));
    expect(kinds).toEqual(["done", "replaced"]);
  });

  it("updates the request to the state the request table allows", () => {
    const requests = readFileSync(join(DIR, "137_job_decision_requests.sql"), "utf8");
    expect(requests).toMatch(/State IN \(N'pending', N'answered', N'withdrawn'\)/);
    expect(store).toMatch(/SET State = N'answered'/);
  });

  // The CHECKs, written out: what the table will take of a decision as the service writes it.
  const accepts = (d: {
    deferUntil: string | null;
    nextStep: string | null;
    nextStepDueAt: Date | null;
    nextStepOwnerRole: string | null;
    nextStepOwnerUserId: number | null;
    outcome: string;
  }): boolean => {
    const hasStep = d.nextStep !== null;
    const stepAllOrNone = hasStep
      ? d.nextStep!.trim() !== "" && d.nextStepDueAt !== null && (d.nextStepOwnerUserId !== null) !== (d.nextStepOwnerRole !== null)
      : d.nextStepOwnerUserId === null && d.nextStepOwnerRole === null && d.nextStepDueAt === null;
    const stepNeeded = d.outcome === "defer" || hasStep;
    const deferDay = d.outcome === "defer" ? d.deferUntil !== null : d.deferUntil === null;
    return stepAllOrNone && stepNeeded && deferDay;
  };

  it("takes every decision the endpoint can produce, and refuses the ones it must", () => {
    const { parseRespondBody } = require("../jobDecisions/respond") as typeof import("../jobDecisions/respond");
    const VERSION = Buffer.from([0, 0, 0, 0, 0, 0, 0, 1]).toString("base64");
    const base = { rationale: "Because", requestId: 1, rowVersion: VERSION };
    const due = new Date("2026-10-19T07:30:00Z");
    const written = (input: Record<string, unknown>) => {
      const parsed = parseRespondBody({ ...base, ...input });
      const owner = parsed.nextStepOwner ?? (parsed.nextStep !== null ? ({ kind: "user", userId: 9 } as const) : null);
      return {
        deferUntil: parsed.deferUntil,
        nextStep: parsed.nextStep,
        nextStepDueAt: parsed.nextStep !== null ? due : null,
        nextStepOwnerRole: owner?.kind === "role" ? owner.role : null,
        nextStepOwnerUserId: owner?.kind === "user" ? owner.userId : null,
        outcome: parsed.outcome,
      };
    };
    for (const input of [
      { nextStep: "Pay it", outcome: "approve" },
      { nextStep: "Tell the contractor", nextStepOwner: { role: "accounts" }, outcome: "deny" },
      { nextStep: "Fix the ABN", nextStepOwner: { userId: 9 }, outcome: "revise" },
      { deferUntil: "2026-10-23", outcome: "defer" },
      { deferUntil: "2026-10-23", nextStep: "Chase the contractor", outcome: "defer" },
    ]) {
      expect(accepts(written(input))).toBe(true);
    }
    // and what the table would refuse had the code not already
    expect(accepts({ deferUntil: null, nextStep: null, nextStepDueAt: null, nextStepOwnerRole: null, nextStepOwnerUserId: null, outcome: "approve" })).toBe(false);
    expect(accepts({ deferUntil: null, nextStep: "x", nextStepDueAt: due, nextStepOwnerRole: "accounts", nextStepOwnerUserId: 9, outcome: "approve" })).toBe(false);
    expect(accepts({ deferUntil: null, nextStep: "x", nextStepDueAt: null, nextStepOwnerRole: null, nextStepOwnerUserId: 9, outcome: "approve" })).toBe(false);
    expect(accepts({ deferUntil: "2026-10-23", nextStep: "x", nextStepDueAt: due, nextStepOwnerRole: null, nextStepOwnerUserId: 9, outcome: "approve" })).toBe(false);
    expect(accepts({ deferUntil: null, nextStep: null, nextStepDueAt: null, nextStepOwnerRole: null, nextStepOwnerUserId: null, outcome: "defer" })).toBe(false);
  });

  it("seeds the policy under the key the code raises", () => {
    const { NEXT_STEP_POLICY } = require("../escalation/decisionRows") as typeof import("../escalation/decisionRows");
    expect(code).toContain(`N'${NEXT_STEP_POLICY}'`);
  });
});

describe("the job.next_step policy seed", () => {
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
    expect(seed[0]).toMatchObject({ active: true, autoReescalate: "yes", clock: "business", kind: "attention", policyKey: "job.next_step", urgent: false });
  });

  it("is an attention policy, so the sweep tidies a step whose job has closed, and the inbox guards stop it being ended any other way", () => {
    expect(seed[0].kind).toBe("attention");
  });

  it("goes to the owner, then their manager, then a director", () => {
    expect(parseLadder(seed[0].ladder)).toEqual([{ userTarget: true }, { slaHours: 16, token: "raiser_manager" }, { role: "director" }]);
  });

  it("writes the seeded values on insert only, so an admin's switch survives a re-run", () => {
    expect(code).toMatch(/INSERT \(PolicyKey, Kind, Urgent, Clock, AutoReescalate, Ladder, Active, UpdatedBy\)/);
    expect(code).toMatch(/source\.Ladder, source\.Active, N'migration:138_job_decisions'/);
    expect(code).toMatch(/AS v \(PolicyKey, Kind, Urgent, Clock, AutoReescalate, Ladder, Active\)/);
  });
});
