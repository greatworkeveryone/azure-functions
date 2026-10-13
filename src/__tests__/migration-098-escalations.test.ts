/// <reference types="jest" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseLadder } from "../escalation/policies";

// Migration 098 runs automatically at startup in production and a failing one
// stops the API (database-safety rules), so the file is held to the rules here, as
// well as being run against a real SQL Server before it merged. This is a regex
// tripwire over the raw file, not a SQL parser.

const FILE = "098_escalations.sql";
const raw = readFileSync(join(__dirname, "..", "..", "migrations", FILE), "utf8");

const stripComments = (sql: string): string => sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");
const code = stripComments(raw);
const batches = code.split(/^GO\s*$/im).map((b) => b.trim()).filter(Boolean);

describe("098_escalations.sql is additive and safe to run twice", () => {
  it("contains nothing destructive, comments included", () => {
    expect(raw).not.toMatch(/\bDROP\s+(TABLE|COLUMN)\b|\bTRUNCATE\b|\bDELETE\s+FROM\b|\bALTER\s+COLUMN\b|\bsp_rename\b/i);
    expect(code).not.toMatch(/\b(DROP|TRUNCATE|DELETE)\b/i);
  });

  it("never rewrites existing values", () => {
    expect(code).not.toMatch(/\bUPDATE\b/i);
    expect(code).not.toMatch(/\bALTER\s+TABLE\b/i);
  });

  it("puts every CREATE behind an existence guard, ahead of the CREATE", () => {
    const guard = /^IF\s+(NOT\s+EXISTS|OBJECT_ID)\b/i;
    const creating = batches.filter((b) => /\bCREATE\b/i.test(b));
    expect(creating.length).toBeGreaterThanOrEqual(9);
    for (const batch of creating) {
      expect(batch).toMatch(guard);
      expect(batch.search(guard)).toBeLessThan(batch.search(/\bCREATE\b/i));
    }
  });

  it("seeds with MERGE ... WHEN NOT MATCHED THEN INSERT only, so an admin's edit survives a re-run", () => {
    expect(code).toMatch(/MERGE\s+dbo\.EscalationPolicies/i);
    expect(code).toMatch(/WHEN NOT MATCHED BY TARGET THEN\s+INSERT/i);
    expect(code).not.toMatch(/WHEN\s+MATCHED/i);
  });

  it("gives the new columns defaults or nulls, so no insert has to name them all", () => {
    const table = code.slice(code.indexOf("CREATE TABLE dbo.Escalations"), code.indexOf("GO", code.indexOf("CREATE TABLE dbo.Escalations")));
    const notNullWithoutDefault = table
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /\bNOT NULL\b/i.test(l) && !/\bDEFAULT\b|IDENTITY|ROWVERSION/i.test(l) && !/^CONSTRAINT/i.test(l))
      .map((l) => l.split(/\s+/)[0]);
    // Required on insert: the engine always supplies these.
    expect(notNullWithoutDefault.sort()).toEqual(["Kind", "PolicyKey", "RaisedByKind", "RaisedByName", "SubjectId", "SubjectType", "Summary"]);
  });
});

describe("dbo.Escalations", () => {
  it("has the columns PLAN §3.7 and the build brief name", () => {
    for (const column of [
      "EscalationId", "SubjectType", "SubjectId", "BuildingId", "Kind", "Urgent", "PolicyKey", "[Level]", "TargetRole", "TargetUserId",
      "RaisedByUserId", "RaisedByName", "RaisedByKind", "Reason", "Note", "Summary", "Context", "DueAt", "Status",
      "AcknowledgedAt", "AcknowledgedByUserId", "AcknowledgedByName", "ResolvedAt", "ResolvedByUserId", "ResolvedByName",
      "ResolutionCode", "ResolutionNote", "ParentEscalationId", "NoIndependentTarget", "NotificationState",
      "NotificationAttempts", "LastNotificationError", "CreatedAt", "UpdatedAt", "RowVersion",
    ]) {
      expect(code).toContain(column);
    }
    expect(code).toMatch(/EscalationId\s+BIGINT\s+IDENTITY/);
    expect(code).toMatch(/RowVersion\s+ROWVERSION/);
    expect(code).toMatch(/PRIMARY KEY CLUSTERED \(EscalationId\)/);
  });

  it("checks the status, kind and notification vocabulary and that Context is JSON", () => {
    expect(code).toMatch(/Status IN \('open', 'acknowledged', 'resolved', 'superseded', 'withdrawn'\)/);
    expect(code).toMatch(/Kind IN \('attention', 'authority'\)/);
    expect(code).toMatch(/NotificationState IN \('none', 'pending', 'sent', 'failed'\)/);
    expect(code).toMatch(/RaisedByKind IN \('user', 'system'\)/);
    expect(code).toMatch(/Context IS NULL OR ISJSON\(Context\) = 1/);
  });

  it("allows one live escalation per subject and policy, through a filtered unique index", () => {
    expect(code).toMatch(/CREATE UNIQUE INDEX UX_Escalations_Live\s+ON dbo\.Escalations \(SubjectType, SubjectId, PolicyKey\)\s+WHERE Status IN \('open', 'acknowledged'\)/);
  });

  it("indexes the inbox views: target role and user by status, raised by, due", () => {
    expect(code).toMatch(/IX_Escalations_Target\s+ON dbo\.Escalations \(TargetRole, TargetUserId, Status\)/);
    expect(code).toMatch(/IX_Escalations_RaisedBy\s+ON dbo\.Escalations \(RaisedByUserId, Status\)/);
    expect(code).toMatch(/IX_Escalations_Due\s+ON dbo\.Escalations \(Status, DueAt\)/);
  });

  it("has every column the store inserts", () => {
    const source = readFileSync(join(__dirname, "..", "escalation", "store.ts"), "utf8");
    const insert = source.match(/INSERT INTO dbo\.Escalations\s*\(([^)]*)\)/);
    expect(insert).not.toBeNull();
    const columns = (insert as RegExpMatchArray)[1].split(",").map((c) => c.trim());
    expect(columns.length).toBeGreaterThan(15);
    for (const column of columns) {
      expect(code).toContain(column);
    }
  });
});

describe("dbo.EscalationPolicies and its seed", () => {
  const seed = [...code.matchAll(/\(N'([a-z_.]+)', N'(attention|authority)', ([01]), N'(business|wall)', N'(yes|reminder|nudge|no)',\s*N'(\[.*?\])'\)/g)].map((m) => ({
    autoReescalate: m[5],
    clock: m[4],
    kind: m[2],
    ladder: m[6],
    policyKey: m[1],
    urgent: m[3] === "1",
  }));
  const byKey = Object.fromEntries(seed.map((p) => [p.policyKey, p]));

  it("has the columns the PLAN names", () => {
    const table = code.slice(code.indexOf("CREATE TABLE dbo.EscalationPolicies"), code.indexOf("GO"));
    for (const column of ["PolicyKey", "Kind", "Urgent", "Clock", "Ladder", "AutoReescalate", "Active", "UpdatedAt", "UpdatedBy"]) {
      expect(table).toContain(column);
    }
  });

  it("seeds every row of PLAN §3.7's table except the quote, invoice and purchase_order policies", () => {
    expect(seed.map((p) => p.policyKey).sort()).toEqual(
      [
        "any.manual",
        "billing.run_approval",
        "comms.arrears_exhausted",
        "comms.contractor_no_reply",
        "comms.legal_notice_approval",
        "job.critical",
        "job.invoice_waiting",
        "job.manual",
        "job.past_due",
        "job.quote_not_back",
        "job.stalled_unacknowledged",
        "job.unassigned",
        "lease.option_deadline",
        "lease.option_lapsed",
        "lease.renewal",
        "rent_review.approval",
        "rent_review.closeout",
        "rent_review.index_late",
        "rent_review.market_referral",
        "rent_review.not_commenced",
        "rent_review.overdue",
        "system.health",
      ].sort(),
    );
    expect(seed.some((p) => /^(quote|invoice|purchase_order)\./.test(p.policyKey))).toBe(false);
  });

  it("gives every seeded ladder valid JSON the engine can read", () => {
    for (const p of seed) {
      expect(() => parseLadder(p.ladder)).not.toThrow();
    }
  });

  it("matches the job policies in the table: levels, hours, clock and urgency", () => {
    const ladder = (key: string) => parseLadder(byKey[key].ladder);
    expect(ladder("job.stalled_unacknowledged")).toEqual([{ role: "facilities_manager", slaHours: 16 }, { role: "director", slaHours: 16 }]);
    expect(ladder("job.unassigned")).toEqual([{ role: "facilities_manager", slaHours: 8 }, { role: "director", slaHours: 16 }]);
    expect(ladder("job.manual")).toEqual([{ slaHours: 8, token: "raiser_manager" }, { role: "director", slaHours: 16 }]);
    expect(ladder("job.critical")).toEqual([{ role: "facilities_manager", slaHours: 2 }, { role: "director", slaHours: 4 }]);
    expect(ladder("job.quote_not_back")).toEqual([{ role: "facilities_manager", slaHours: 16 }, { role: "director", slaHours: 16 }]);
    expect(ladder("job.invoice_waiting")).toEqual([{ role: "accounts_manager", slaHours: 16 }, { role: "cfo", slaHours: 16 }, { role: "director" }]);
    expect(ladder("job.past_due")).toEqual([{ role: "facilities_manager", slaHours: 16 }, { role: "director", slaHours: 16 }]);
    expect(byKey["job.critical"]).toMatchObject({ clock: "wall", kind: "attention", urgent: true });
    for (const key of Object.keys(byKey).filter((k) => k !== "job.critical")) {
      expect(byKey[key]).toMatchObject({ clock: "business", urgent: false });
    }
    for (const key of ["job.stalled_unacknowledged", "job.unassigned", "job.manual", "job.critical", "job.quote_not_back", "job.invoice_waiting", "job.past_due"]) {
      expect(byKey[key]).toMatchObject({ autoReescalate: "yes", kind: "attention" });
    }
  });

  it("matches the other rows' kinds, hours and auto-escalation", () => {
    const ladder = (key: string) => parseLadder(byKey[key].ladder);
    expect(ladder("rent_review.not_commenced")).toEqual([{ role: "accounts_manager", slaHours: 40 }, { role: "director", slaHours: 40 }]);
    expect(ladder("rent_review.overdue")).toEqual([{ role: "accounts_manager", slaHours: 16 }, { role: "director", slaHours: 40 }]);
    expect(ladder("rent_review.approval")).toEqual([{ role: "accounts_manager", slaHours: 16 }, { role: "cfo", slaHours: 16 }, { role: "director" }]);
    expect(ladder("rent_review.market_referral")).toEqual([{ role: "director", slaHours: 80 }]);
    expect(ladder("rent_review.index_late")).toEqual([{ role: "admin" }]);
    expect(ladder("rent_review.closeout")).toEqual([{ role: "accounts_manager", slaHours: 80 }]);
    expect(ladder("billing.run_approval")).toEqual([{ role: "accounts_manager", slaHours: 8 }, { role: "cfo", slaHours: 8 }, { role: "director" }]);
    expect(ladder("comms.contractor_no_reply")).toEqual([{ role: "facilities_manager", slaHours: 16 }, { role: "director", slaHours: 16 }]);
    expect(ladder("comms.legal_notice_approval")).toEqual([{ role: "director", slaHours: 16 }]);
    expect(ladder("comms.arrears_exhausted")).toEqual([{ role: "director", slaHours: 40 }]);
    expect(ladder("lease.option_deadline")).toEqual([{ role: "accounts_manager", slaHours: 40 }, { role: "director" }]);
    expect(ladder("lease.option_lapsed")).toEqual([{ role: "director" }]);
    expect(ladder("lease.renewal")).toEqual([{ role: "director", slaHours: 80 }]);
    expect(ladder("any.manual")).toEqual([{ slaHours: 8, token: "raiser_manager" }, { role: "director", slaHours: 16 }]);
    expect(ladder("system.health")).toEqual([{ role: "admin" }]);

    const authority = ["rent_review.approval", "rent_review.market_referral", "billing.run_approval", "comms.legal_notice_approval", "comms.arrears_exhausted", "lease.renewal"];
    expect(seed.filter((p) => p.kind === "authority").map((p) => p.policyKey).sort()).toEqual(authority.sort());
    expect(byKey["rent_review.market_referral"].autoReescalate).toBe("nudge");
    expect(byKey["comms.arrears_exhausted"].autoReescalate).toBe("nudge");
    expect(byKey["lease.renewal"].autoReescalate).toBe("nudge");
    expect(byKey["comms.legal_notice_approval"].autoReescalate).toBe("reminder");
    for (const key of ["rent_review.index_late", "rent_review.closeout", "lease.option_lapsed", "system.health"]) {
      expect(byKey[key].autoReescalate).toBe("no");
    }
  });
});

describe("the CFO role needs no migration 099", () => {
  it("is not enumerated by any CHECK constraint or seed table in the schema", () => {
    // AppUsers.Role is NVARCHAR(50) NULL with no CHECK; FeatureFlags and
    // ApprovalLimits take any role name. Number 099 stays reserved and unused.
    const dir = join(__dirname, "..", "..", "migrations");
    const { readdirSync } = require("node:fs") as typeof import("node:fs");
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql"));
    expect(files.some((f) => f.startsWith("099_"))).toBe(false);
    for (const f of files) {
      const sql = stripComments(readFileSync(join(dir, f), "utf8"));
      expect(sql).not.toMatch(/CHECK\s*\([^)]*\bRole(Name)?\b[^)]*\bIN\s*\(/i);
    }
  });
});
