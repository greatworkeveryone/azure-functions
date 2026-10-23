import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FEATURE_SCHEMA_VERSION } from "../contractorSuggestions/features";
import { SUGGESTION_CONTEXTS } from "../contractorSuggestions/types";
import { migrationFromSql, validateMigration } from "../migrate-files";

// Migration 171 (SC-AI3) creates the append-only contractor suggestion log.
// These pin its shape to the code that writes it and to the database-safety rules.

const FILE = "171_contractor_suggestion_events.sql";
const RAW = readFileSync(join(__dirname, "..", "..", "migrations", FILE), "utf8");
const CODE = RAW.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");
const EVENT_LOG = readFileSync(join(__dirname, "..", "contractorSuggestions", "eventLog.ts"), "utf8");
const TABLES = ["ContractorSuggestionSets", "ContractorSuggestionItems", "ContractorSuggestionOutcomes"];

/** The columns of one CREATE TABLE, by name. */
function columnsOf(table: string): string[] {
  const create = CODE.match(new RegExp(`CREATE TABLE dbo\\.${table} \\(([\\s\\S]*?)\\n  \\);`));
  expect(create).not.toBeNull();
  return (create?.[1] ?? "")
    .split("\n")
    .map((line) => line.trim().replace(/^\[(\w+)\]/, "$1").split(/\s+/)[0])
    .filter((word) => /^[A-Z]\w*$/.test(word) && !/^(CONSTRAINT|CHECK|OR|AND)$/.test(word));
}

/** The column list of the INSERT in eventLog.ts that goes into `table`. */
function insertedInto(table: string): string[] {
  const insert = EVENT_LOG.match(new RegExp("INSERT INTO dbo\\." + table + "\\s*\\(([^)]*)\\)"));
  expect(insert).not.toBeNull();
  return (insert?.[1] ?? "").split(",").map((column) => column.trim().replace(/^\[|\]$/g, ""));
}

describe("migration 171", () => {
  it("is accepted by the runner without a destructive-statement approval header", () => {
    expect(validateMigration(migrationFromSql(FILE, RAW))).toEqual([]);
    expect(RAW).not.toMatch(/DESTRUCTIVE/);
  });

  it("creates its three tables behind existence guards and changes nothing that exists", () => {
    for (const table of TABLES) expect(CODE).toContain(`IF OBJECT_ID('dbo.${table}', 'U') IS NULL`);
    expect(CODE).not.toMatch(/\bALTER\s+TABLE\b/i);
    expect(CODE.match(/CREATE TABLE/g)).toHaveLength(3);
  });

  it("is safe to run twice: every CREATE is guarded, and the indexes and triggers check for themselves", () => {
    const indexes = CODE.match(/CREATE (?:UNIQUE )?INDEX (\w+)/g) ?? [];
    expect(indexes).toHaveLength(6);
    for (const create of indexes) {
      const name = create.match(/INDEX (\w+)/)?.[1];
      expect(CODE).toContain(`name = '${name}'`);
    }
    for (const table of TABLES) expect(CODE).toContain(`IF OBJECT_ID('dbo.TR_${table}_AppendOnly', 'TR') IS NULL`);
  });

  it("contains no DROP, TRUNCATE, DELETE, UPDATE or MERGE outside the append-only triggers' own event list", () => {
    const withoutTriggerEvents = CODE.replace(/INSTEAD OF UPDATE, DELETE/g, "");
    expect(withoutTriggerEvents).not.toMatch(/\b(DROP|TRUNCATE|DELETE|UPDATE|MERGE)\b/i);
  });

  it("makes each table refuse UPDATE and DELETE itself, with THROW 51000", () => {
    for (const table of TABLES) {
      expect(CODE).toContain(
        `CREATE TRIGGER dbo.TR_${table}_AppendOnly ON dbo.${table} INSTEAD OF UPDATE, DELETE AS BEGIN THROW 51000, ''${table} is append-only'', 1; END;`,
      );
    }
  });

  it("references no other table by foreign key, so the log outlives jobs, buildings and contractors", () => {
    const references = [...CODE.matchAll(/REFERENCES\s+dbo\.(\w+)/g)].map((match) => match[1]).sort();
    expect(references).toEqual(["ContractorSuggestionSets", "ContractorSuggestionSets"]);
  });

  it("has every column the code inserts, and leaves to the server only the identity and the clock", () => {
    for (const table of TABLES) {
      const columns = columnsOf(table);
      for (const written of insertedInto(table)) expect(columns).toContain(written);
    }
    const unwritten = (table: string) => columnsOf(table).filter((column) => !insertedInto(table).includes(column));
    expect(unwritten("ContractorSuggestionSets")).toEqual(["SetId", "CreatedAt"]);
    expect(unwritten("ContractorSuggestionItems")).toEqual([]);
    expect(unwritten("ContractorSuggestionOutcomes")).toEqual(["OutcomeId", "CreatedAt"]);
  });

  it("keeps the identity and the clock on the server, never taken from the caller", () => {
    expect(CODE).toMatch(/SetId\s+INT\s+IDENTITY\(1,1\)/);
    expect(CODE).toMatch(/OutcomeId\s+INT\s+IDENTITY\(1,1\)/);
    expect(CODE.match(/CreatedAt\s+DATETIME2\s+NOT NULL CONSTRAINT \w+ DEFAULT SYSUTCDATETIME\(\)/g)).toHaveLength(2);
  });

  it("allows exactly the contexts and outcomes the code uses", () => {
    const list = (pattern: RegExp) =>
      (CODE.match(pattern)?.[1] ?? "")
        .split(",")
        .map((value) => value.trim().replace(/'/g, ""));
    expect(list(/CK_ContractorSuggestionSets_Context CHECK \(Context IN \(([^)]*)\)\)/)).toEqual([...SUGGESTION_CONTEXTS]);
    expect(list(/CK_ContractorSuggestionOutcomes_Outcome CHECK \(Outcome IN \(([^)]*)\)\)/)).toEqual(["chose_suggested", "chose_other", "dismissed"]);
  });

  it("ties ChosenRank to the outcome: only a suggested choice has one, and a dismissal has no contractor", () => {
    const shape = CODE.match(/CK_ContractorSuggestionOutcomes_Shape CHECK \(([\s\S]*?)\n    \),/)?.[1] ?? "";
    expect(shape).toMatch(/Outcome = 'dismissed'\s+AND ChosenContractorId IS NULL\s+AND ChosenRank IS NULL/);
    expect(shape).toMatch(/Outcome = 'chose_suggested' AND ChosenContractorId IS NOT NULL AND ChosenRank IS NOT NULL/);
    expect(shape).toMatch(/Outcome = 'chose_other'\s+AND ChosenContractorId IS NOT NULL AND ChosenRank IS NULL/);
  });

  it("holds the features as JSON the database has checked, one item per contractor and per rank in a set, one outcome per contractor in a set", () => {
    expect(CODE).toContain("CHECK (ISJSON(FeaturesJson) = 1)");
    expect(CODE).toContain("PRIMARY KEY (SetId, ContractorId)");
    expect(CODE).toContain("UNIQUE INDEX UX_ContractorSuggestionItems_SetRank ON dbo.ContractorSuggestionItems (SetId, [Rank])");
    expect(CODE).toContain("UNIQUE INDEX UX_ContractorSuggestionOutcomes_SetContractor ON dbo.ContractorSuggestionOutcomes (SetId, ChosenContractorId)");
  });

  it("indexes the evaluation reads: by ranker and feature version over time, by job, by contractor", () => {
    expect(CODE).toContain("ON dbo.ContractorSuggestionSets (RankerVersion, FeatureSchemaVersion, CreatedAt)");
    expect(CODE).toContain("ON dbo.ContractorSuggestionSets (JobId, CreatedAt) WHERE JobId IS NOT NULL");
    expect(CODE).toContain("ON dbo.ContractorSuggestionItems (ContractorId, SetId)");
    expect(CODE).toContain("ON dbo.ContractorSuggestionOutcomes (ChosenContractorId, SetId)");
  });

  it("stores the feature schema version as a column, so a new schema is a new value and not a new migration", () => {
    expect(FEATURE_SCHEMA_VERSION).toBe("cs-features@1");
    expect(CODE).toMatch(/FeatureSchemaVersion\s+NVARCHAR\(32\)\s+NOT NULL/);
  });
});
