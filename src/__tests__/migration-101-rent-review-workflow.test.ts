/// <reference types="jest" />
// Migration 101 runs by hand in production (npm run migrate -- --apply), and the
// local Docker database applies it at startup, so a failing or destructive one
// is not an option (database-safety rules). This is a regex tripwire over the
// raw file, not a SQL parser. When it was built the migration was also applied
// twice to a real SQL Server 2022 container holding a legacy review row: the
// row came out identical and every workflow write passed the legacy checks.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RENT_REVIEW_STATES } from "../rentReviewMachine";
import { LEGACY_REVIEW_TYPES, LEGACY_STATUSES } from "../rentReview/legacyMap";

const FILE = "101_rent_review_workflow.sql";
const MIGRATIONS = join(__dirname, "..", "..", "migrations");
const raw = readFileSync(join(MIGRATIONS, FILE), "utf8");

const stripComments = (sql: string): string => sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");
const code = stripComments(raw);
const batches = code.split(/^GO\s*$/im).map((b) => b.trim()).filter(Boolean);

const NEW_COLUMNS: Array<[string, string]> = [
  ["Method", "NVARCHAR(16)"],
  ["State", "NVARCHAR(20)"],
  ["StepId", "NVARCHAR(40)"],
  ["BuildingId", "INT"],
  ["OwnerUserId", "INT"],
  ["Basis", "NVARCHAR(MAX)"],
  ["Calc", "NVARCHAR(MAX)"],
  ["PreparedById", "INT"],
  ["PreparedByName", "NVARCHAR(200)"],
  ["PreparedAt", "DATETIME2"],
  ["SubmittedAt", "DATETIME2"],
  ["ApprovedById", "INT"],
  ["ApprovedByName", "NVARCHAR(200)"],
  ["ApprovedAt", "DATETIME2"],
  ["ApprovalBasis", "NVARCHAR(32)"],
  ["NoticeIssuedAt", "DATETIME2"],
  ["NoticeIssuedBy", "NVARCHAR(200)"],
  ["NoticeMethod", "NVARCHAR(16)"],
  ["BillingConfirmedAt", "DATETIME2"],
  ["BillingConfirmedBy", "NVARCHAR(200)"],
  ["WaiveReason", "NVARCHAR(2000)"],
  ["ExpectedIndexAt", "DATE"],
  ["UpdatedAt", "DATETIME2"],
  ["Version", "ROWVERSION"],
];

describe("101_rent_review_workflow.sql is additive and safe to run twice", () => {
  it("contains nothing destructive, comments included", () => {
    expect(raw).not.toMatch(/\bDROP\s+(TABLE|COLUMN|CONSTRAINT|INDEX)\b|\bTRUNCATE\b|\bDELETE\s+FROM\b|\bALTER\s+COLUMN\b|\bsp_rename\b/i);
    expect(code).not.toMatch(/\b(DROP|TRUNCATE|DELETE)\b/i);
  });

  it("never rewrites a row: no UPDATE, INSERT, MERGE or SELECT INTO", () => {
    expect(code).not.toMatch(/\b(UPDATE|INSERT|MERGE)\b/i);
    expect(code).not.toMatch(/\bSELECT\b[^;]*\bINTO\b/i);
  });

  it("does not need the destructive approval header, because it has no destructive statement", () => {
    expect(raw).not.toMatch(/^--\s*DESTRUCTIVE:/im);
  });

  it("only ever alters dbo.RentReviews, and only by adding", () => {
    const alters = [...code.matchAll(/ALTER\s+TABLE\s+([\w.]+)\s+(\w+(?:\s+CONSTRAINT)?)/gi)];
    expect(alters.length).toBeGreaterThan(20);
    for (const [, table, verb] of alters) {
      expect(table).toBe("dbo.RentReviews");
      expect(verb.toUpperCase().startsWith("ADD")).toBe(true);
    }
    expect(code).not.toMatch(/\bCREATE\s+TABLE\b/i);
    expect(code).not.toMatch(/\bALTER\s+TABLE\s+dbo\.(?!RentReviews\b)/i);
  });

  it("puts every ALTER and CREATE behind an existence guard, in its own batch, ahead of the statement", () => {
    const guard = /^IF\s+(NOT\s+EXISTS|COL_LENGTH|OBJECT_ID|INDEXPROPERTY)\b/i;
    const ddl = batches.filter((batch) => /\b(CREATE|ALTER)\b/i.test(batch));
    // 24 columns, 4 checks, 1 index
    expect(ddl).toHaveLength(29);
    for (const batch of ddl) {
      expect(batch).toMatch(guard);
      expect(batch.search(guard)).toBeLessThan(batch.search(/\b(CREATE|ALTER)\b/i));
      expect(batch.match(/\b(CREATE|ALTER)\b/gi)).toHaveLength(1);
    }
  });

  it("guards each column with COL_LENGTH on that column", () => {
    for (const [column] of NEW_COLUMNS) {
      expect(code).toContain(`IF COL_LENGTH('dbo.RentReviews', '${column}') IS NULL`);
    }
  });

  it("guards each check constraint and the index by name", () => {
    for (const name of ["CK_RentReviews_Method", "CK_RentReviews_State", "CK_RentReviews_Basis", "CK_RentReviews_Calc"]) {
      const guard = "sys\\.check_constraints\\s+WHERE name = '" + name + "' AND parent_object_id = OBJECT_ID\\('dbo\\.RentReviews'\\)";
      expect(code).toMatch(new RegExp(guard));
    }
    expect(code).toMatch(/sys\.indexes\s+WHERE name = 'UX_RentReviews_OpenPerTenant' AND object_id = OBJECT_ID\('dbo\.RentReviews'\)/);
  });

  it("adds a column in one batch and refers to it only in later ones", () => {
    const added = new Set<string>();
    for (const batch of batches) {
      const adds = [...batch.matchAll(/ADD\s+(?!CONSTRAINT\b)(\w+)\s+/gi)].map((m) => m[1]);
      const mentioned = NEW_COLUMNS.map(([column]) => column).filter((column) => new RegExp(`\\b${column}\\b`).test(batch.replace(/COL_LENGTH\([^)]*\)/g, "")));
      for (const column of mentioned) {
        if (adds.includes(column)) continue;
        expect(added.has(column)).toBe(true); // used by a later batch than the one that added it
      }
      for (const column of adds) added.add(column);
    }
  });
});

describe("the columns", () => {
  it("adds exactly the PLAN's columns with their types, all NULLable except the rowversion", () => {
    const adds = [...code.matchAll(/ALTER TABLE dbo\.RentReviews ADD (\w+) ([A-Z0-9()]+)( NULL)?;/g)].map((m) => [m[1], m[2], m[3] ?? ""]);
    const found = new Map(adds.map(([column, type, nullable]) => [column, { nullable: nullable === " NULL", type }]));
    for (const [column, type] of NEW_COLUMNS) {
      const entry = found.get(column);
      expect(entry).toBeDefined();
      expect(entry?.type).toBe(type);
      expect(entry?.nullable).toBe(column !== "Version");
    }
    expect(found.size).toBe(NEW_COLUMNS.length);
  });

  it("has a rowversion, so a write can carry the version it read", () => {
    expect(code).toMatch(/ADD Version ROWVERSION;/);
  });

  it("leaves the legacy Status and ReviewType columns and their checks alone", () => {
    for (const legacy of ["Status", "ReviewType", "CK_RentReviews_Status", "CK_RentReviews_ReviewType", "ScheduledFor", "TenantId", "ReviewId"]) {
      expect(code).not.toMatch(new RegExp(`ADD\\s+${legacy}\\b`));
      expect(code).not.toMatch(new RegExp(`CONSTRAINT\\s+${legacy}\\b`));
    }
  });
});

describe("the checks", () => {
  it("limits Method to the four methods, allowing NULL for the rows that have none", () => {
    expect(code).toMatch(/CK_RentReviews_Method\s+CHECK \(Method IS NULL OR Method IN \('cpi', 'fixed', 'market', 'other'\)\)/);
  });

  it("limits State to the ten states of PLAN §3.1", () => {
    const check = code.match(/CK_RentReviews_State\s+CHECK \(State IS NULL OR State IN \(([^)]*)\)\)/);
    expect(check).not.toBeNull();
    const states = [...(check as RegExpMatchArray)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(states.sort()).toEqual([...RENT_REVIEW_STATES].sort());
    expect(states).toHaveLength(10);
  });

  it("requires Basis and Calc to be JSON when present", () => {
    expect(code).toMatch(/CK_RentReviews_Basis\s+CHECK \(Basis IS NULL OR ISJSON\(Basis\) = 1\)/);
    expect(code).toMatch(/CK_RentReviews_Calc\s+CHECK \(Calc IS NULL OR ISJSON\(Calc\) = 1\)/);
  });

  it("lets every existing row through: each check passes for NULL", () => {
    for (const column of ["Method", "State", "Basis", "Calc"]) {
      expect(code).toContain(`${column} IS NULL OR`);
    }
  });
});

describe("one open review per tenancy", () => {
  it("is a filtered unique index on TenantId over the six open states", () => {
    const index = code.match(/CREATE UNIQUE INDEX UX_RentReviews_OpenPerTenant\s+ON dbo\.RentReviews \(TenantId\)\s+WHERE State IN \(([^)]*)\)/);
    expect(index).not.toBeNull();
    const states = [...(index as RegExpMatchArray)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(states.sort()).toEqual(["awaiting_approval", "awaiting_index", "due", "in_progress", "referred", "scheduled"]);
  });

  it("leaves the settled states out of the index, so a tenancy can have many of those", () => {
    const filter = code.match(/UX_RentReviews_OpenPerTenant[\s\S]*?WHERE State IN \(([^)]*)\)/) as RegExpMatchArray;
    for (const settled of ["approved", "completed", "waived", "cancelled"]) expect(filter[1]).not.toContain(`'${settled}'`);
  });
});

describe("the legacy checks stay satisfiable", () => {
  it("still accepts what the workflow writes: the mapping lands inside migration 037's lists", () => {
    const m037 = readFileSync(join(MIGRATIONS, "037_tenancy_register.sql"), "utf8");
    for (const value of [...LEGACY_REVIEW_TYPES, ...LEGACY_STATUSES]) expect(m037).toContain(`'${value}'`);
  });

  it("is numbered where the plan reserved it and runs after the migrations it builds on", () => {
    expect(FILE.startsWith("101_")).toBe(true);
    const names = ["037_tenancy_register.sql", "094_decision_ledger.sql", "098_escalations.sql"];
    for (const name of names) expect(name < FILE).toBe(true);
  });
});
