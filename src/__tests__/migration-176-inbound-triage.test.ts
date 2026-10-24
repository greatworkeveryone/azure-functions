import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FEATURE_SCHEMA_VERSION } from "../inboundTriage/features";
import { migrationFromSql, validateMigration } from "../migrate-files";

// Migration 176 (EB3) adds the email assignment columns and the append-only triage log.
// These pin its shape to the code that writes it and to the database-safety rules.

const FILE = "176_inbound_triage.sql";
const RAW = readFileSync(join(__dirname, "..", "..", "migrations", FILE), "utf8");
const CODE = RAW.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");
const EVENT_LOG = readFileSync(join(__dirname, "..", "inboundTriage", "eventLog.ts"), "utf8");
const TABLES = ["EmailRoutingSets", "EmailRoutingItems", "EmailRoutingOutcomes"];
const EMAIL_COLUMNS = ["Mailbox", "InReplyTo", "ReferenceIds", "LinkedSendKind", "LinkedSendId", "LinkedSendSubject", "LinkedAt", "AssignedToUserId", "AssignedAt", "AssignedBy", "AssignmentReason"];

function columnsOf(table: string): string[] {
  const create = CODE.match(new RegExp(`CREATE TABLE dbo\\.${table} \\(([\\s\\S]*?)\\n  \\);`));
  expect(create).not.toBeNull();
  return (create?.[1] ?? "")
    .split("\n")
    .map((line) => line.trim().replace(/^\[(\w+)\]/, "$1").split(/\s+/)[0])
    .filter((word) => /^[A-Z]\w*$/.test(word) && !/^(CONSTRAINT|CHECK|OR|AND)$/.test(word));
}

function insertedInto(table: string): string[] {
  const insert = EVENT_LOG.match(new RegExp("INSERT INTO dbo\\." + table + "\\s*\\(([^)]*)\\)"));
  expect(insert).not.toBeNull();
  return (insert?.[1] ?? "").split(",").map((column) => column.trim().replace(/^\[|\]$/g, ""));
}

describe("migration 176", () => {
  it("is accepted by the runner without a destructive-statement approval header", () => {
    expect(validateMigration(migrationFromSql(FILE, RAW))).toEqual([]);
    expect(RAW).not.toMatch(/DESTRUCTIVE/);
  });

  it("adds exactly the Emails columns the code uses, each nullable and behind its own existence check", () => {
    const adds = [...CODE.matchAll(/COL_LENGTH\(N'dbo\.Emails', N'(\w+)'\) IS NULL\s+ALTER TABLE dbo\.Emails ADD (\w+) ([^;]+);/g)];
    expect(adds.map((add) => add[1])).toEqual(EMAIL_COLUMNS);
    for (const add of adds) {
      expect(add[2]).toBe(add[1]);
      expect(add[3].trim()).toMatch(/NULL$/);
      expect(add[3]).not.toMatch(/NOT NULL|DEFAULT/);
    }
  });

  it("creates its three tables behind existence guards and alters nothing else but Emails", () => {
    for (const table of TABLES) expect(CODE).toContain(`IF OBJECT_ID(N'dbo.${table}', N'U') IS NULL`);
    expect(CODE.match(/CREATE TABLE/g)).toHaveLength(3);
    const alters = CODE.match(/ALTER TABLE dbo\.(\w+)/g) ?? [];
    expect(new Set(alters)).toEqual(new Set(["ALTER TABLE dbo.Emails"]));
  });

  it("is safe to run twice: every index, constraint and trigger checks for itself", () => {
    const indexes = CODE.match(/CREATE (?:UNIQUE )?INDEX (\w+)/g) ?? [];
    expect(indexes).toHaveLength(9);
    for (const create of indexes) expect(CODE).toContain(`name = N'${create.match(/INDEX (\w+)/)?.[1]}'`);
    expect(CODE).toContain("name = N'FK_Emails_AssignedToUser'");
    for (const table of TABLES) expect(CODE).toContain(`IF OBJECT_ID(N'dbo.TR_${table}_AppendOnly', N'TR') IS NULL`);
  });

  it("contains no DROP, TRUNCATE, DELETE, UPDATE or MERGE outside the append-only triggers' own event list", () => {
    expect(CODE.replace(/INSTEAD OF UPDATE, DELETE/g, "")).not.toMatch(/\b(DROP|TRUNCATE|DELETE|UPDATE|MERGE)\b/i);
  });

  it("makes each table refuse UPDATE and DELETE itself, with THROW 51000", () => {
    for (const table of TABLES) {
      expect(CODE).toContain(`CREATE TRIGGER dbo.TR_${table}_AppendOnly ON dbo.${table} INSTEAD OF UPDATE, DELETE AS BEGIN THROW 51000, ''${table} is append-only'', 1; END;`);
    }
  });

  it("references no other table by foreign key but the log's own sets, and the Emails link to AppUsers", () => {
    const references = [...CODE.matchAll(/REFERENCES\s+dbo\.(\w+)/g)].map((match) => match[1]).sort();
    expect(references).toEqual(["AppUsers", "EmailRoutingSets", "EmailRoutingSets"]);
  });

  it("has every column the code inserts, and leaves to the server only the identity and the clock", () => {
    for (const table of TABLES) for (const written of insertedInto(table)) expect(columnsOf(table)).toContain(written);
    const unwritten = (table: string) => columnsOf(table).filter((column) => !insertedInto(table).includes(column));
    expect(unwritten("EmailRoutingSets")).toEqual(["SetId", "CreatedAt"]);
    expect(unwritten("EmailRoutingItems")).toEqual([]);
    expect(unwritten("EmailRoutingOutcomes")).toEqual(["OutcomeId", "CreatedAt"]);
  });

  it("allows exactly the decisions, lanes, sources and outcomes the code uses", () => {
    const list = (pattern: RegExp) => (CODE.match(pattern)?.[1] ?? "").split(",").map((value) => value.trim().replace(/'/g, ""));
    expect(list(/CK_EmailRoutingSets_Decision CHECK \(Decision IN \(([^)]*)\)\)/)).toEqual(["auto", "queued", "manual"]);
    expect(list(/CK_EmailRoutingSets_Lane CHECK \(Lane IN \(([^)]*)\)\)/)).toEqual(["facilities", "accounts", "both"]);
    expect(list(/CK_EmailRoutingSets_WorkSource CHECK \(WorkSource IN \(([^)]*)\)\)/)).toEqual(["rules", "toddler", "ai"]);
    expect(list(/CK_EmailRoutingOutcomes_Outcome CHECK \(Outcome IN \(([^)]*)\)\)/)).toEqual(["auto_assigned", "accepted", "chose_other", "reassigned"]);
  });

  it("requires the person a reassignment moved the email from, and holds features and context as JSON the database has checked", () => {
    expect(CODE).toContain("CK_EmailRoutingOutcomes_Shape CHECK (Outcome <> 'reassigned' OR PreviousUserId IS NOT NULL)");
    expect(CODE).toContain("CHECK (ISJSON(ContextJson) = 1)");
    expect(CODE).toContain("CHECK (ISJSON(FeaturesJson) = 1)");
    expect(CODE).toContain("PRIMARY KEY (SetId, CandidateUserId)");
    expect(CODE).toContain("UNIQUE INDEX UX_EmailRoutingItems_SetRank ON dbo.EmailRoutingItems (SetId, [Rank])");
  });

  it("stores the feature schema version as a column, so a new schema is a new value and not a new migration", () => {
    expect(FEATURE_SCHEMA_VERSION).toBe("triage-features@1");
    expect(CODE).toMatch(/FeatureSchemaVersion\s+NVARCHAR\(32\)\s+NOT NULL/);
  });

  it("adds no per-mailbox watermark table: dbo.EmailSyncState (129) is already keyed by mailbox", () => {
    expect(CODE).not.toMatch(/EmailSyncState/);
    expect(readFileSync(join(__dirname, "..", "..", "migrations", "129_email_intake_watermark.sql"), "utf8")).toMatch(/Mailbox\s+NVARCHAR\(320\) NOT NULL CONSTRAINT PK_EmailSyncState PRIMARY KEY/);
  });
});
