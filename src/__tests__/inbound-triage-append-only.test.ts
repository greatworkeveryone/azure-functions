import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// Database-safety rules 1 and 3 for the inbound triage routing log (migration 176): its three
// tables only ever take INSERTs. This reads every non-test source file and script, so a statement
// that updates, deletes, merges into, truncates, drops or alters one of them fails here, in review,
// before the tables' own triggers would refuse it at run time. A failure is a stop sign, not
// something to allowlist.

const ROOT = join(__dirname, "..", "..");
const TABLE = String.raw`(?:dbo\.)?\[?EmailRouting(?:Sets|Items|Outcomes)\b`;

const WRITES: [string, RegExp][] = [
  ["UPDATE", new RegExp(String.raw`\bUPDATE\s+(?:TOP\s*\(\s*\d+\s*\)\s*)?${TABLE}`, "i")],
  ["UPDATE through an alias", new RegExp(String.raw`\bUPDATE\s+\w+\s+SET\b[\s\S]{0,600}?\bFROM\s+${TABLE}`, "i")],
  ["DELETE", new RegExp(String.raw`\bDELETE\s+(?:TOP\s*\(\s*\d+\s*\)\s*)?(?:FROM\s+)?${TABLE}`, "i")],
  ["DELETE through an alias", new RegExp(String.raw`\bDELETE\s+\w+\s+FROM\s+${TABLE}`, "i")],
  ["MERGE", new RegExp(String.raw`\bMERGE\s+(?:INTO\s+)?${TABLE}`, "i")],
  ["TRUNCATE", new RegExp(String.raw`\bTRUNCATE\s+TABLE\s+${TABLE}`, "i")],
  ["DROP", new RegExp(String.raw`\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?${TABLE}`, "i")],
  ["ALTER", new RegExp(String.raw`\bALTER\s+TABLE\s+${TABLE}`, "i")],
];

/** Every way the code is allowed to name one of the tables: written to by INSERT, read by FROM or JOIN. */
const ALLOWED_USE = /(?:INSERT\s+INTO|\bFROM|\bJOIN)\s+(?:dbo\.)?$/i;
const MENTION = /(?:dbo\.)?\[?EmailRouting(?:Sets|Items|Outcomes)\b/gi;

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
}

function filesUnder(dir: string, keep: (name: string) => boolean): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === "node_modules" || name === "dist" || name === ".review-local") return [];
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return filesUnder(full, keep);
    return keep(name) ? [full] : [];
  });
}

const SOURCES = [
  ...filesUnder(join(ROOT, "src"), (name) => name.endsWith(".ts") && !name.endsWith(".test.ts")),
  ...filesUnder(join(ROOT, "scripts"), (name) => name.endsWith(".cjs") || name.endsWith(".js")),
].filter((file) => !file.includes(`${join("src", "__tests__")}`));

function writesIn(text: string): string[] {
  const code = stripComments(text);
  return WRITES.filter(([, pattern]) => pattern.test(code)).map(([label]) => label);
}

function strayMentions(text: string): string[] {
  const code = stripComments(text);
  return [...code.matchAll(MENTION)].filter((hit) => !ALLOWED_USE.test(code.slice(Math.max(0, (hit.index ?? 0) - 40), hit.index))).map((hit) => hit[0]);
}

describe("the inbound triage routing log is append-only in code", () => {
  it("finds the sources that use it", () => {
    const users = SOURCES.filter((file) => /EmailRouting(Sets|Items|Outcomes)/.test(readFileSync(file, "utf8")));
    expect(users.map((file) => relative(ROOT, file)).sort()).toEqual(
      ["scripts/eval-triage-ranker.cjs", "src/inboundTriage/eventLog.ts", "src/inboundTriage/routingView.ts", "src/inboundTriage/run.ts"].sort(),
    );
  });

  it("no source or script updates, deletes, merges into, truncates, drops or alters it", () => {
    const offenders = SOURCES.flatMap((file) => writesIn(readFileSync(file, "utf8")).map((label) => `${relative(ROOT, file)}: ${label}`));
    expect(offenders).toEqual([]);
  });

  it("every source and script names its tables only to INSERT INTO, or to read FROM or JOIN", () => {
    const strays = SOURCES.flatMap((file) => strayMentions(readFileSync(file, "utf8")).map((hit) => `${relative(ROOT, file)}: ${hit}`));
    expect(strays).toEqual([]);
  });

  it("only inserts from the event log: its INSERT statements are the whole of its writes", () => {
    const log = stripComments(readFileSync(join(ROOT, "src", "inboundTriage", "eventLog.ts"), "utf8"));
    const writes = log.match(/\b(INSERT\s+INTO|UPDATE|DELETE|MERGE)\b/gi) ?? [];
    expect(new Set(writes.map((word) => word.replace(/\s+/g, " ").toUpperCase()))).toEqual(new Set(["INSERT INTO"]));
  });
});

describe("the scan, on crafted text", () => {
  it.each([
    ["an UPDATE", "UPDATE dbo.EmailRoutingSets SET Category = 'x' WHERE SetId = 1"],
    ["an UPDATE with TOP", "UPDATE TOP (1) dbo.EmailRoutingItems SET Score = 0"],
    ["an alias UPDATE", "UPDATE o SET o.Outcome = 'x' FROM dbo.EmailRoutingOutcomes o"],
    ["a DELETE with FROM", "DELETE FROM dbo.EmailRoutingOutcomes WHERE SetId = 1"],
    ["a DELETE without FROM", "DELETE dbo.EmailRoutingItems WHERE SetId = 1"],
    ["an alias DELETE", "DELETE i FROM dbo.EmailRoutingItems i WHERE i.SetId = 1"],
    ["a MERGE", "MERGE dbo.EmailRoutingOutcomes AS t USING x ON 1=1"],
    ["a TRUNCATE", "TRUNCATE TABLE dbo.EmailRoutingSets"],
    ["a DROP", "DROP TABLE IF EXISTS dbo.EmailRoutingItems"],
    ["an ALTER", "ALTER TABLE dbo.EmailRoutingSets ADD Note NVARCHAR(10) NULL"],
  ])("flags %s", (_label, sql) => {
    expect(writesIn(sql)).not.toEqual([]);
  });

  it.each([
    ["an INSERT", "INSERT INTO dbo.EmailRoutingSets (ActorName) VALUES (@A)"],
    ["a SELECT", "SELECT SetId FROM dbo.EmailRoutingSets WHERE SetId = @SetId"],
    ["a JOIN", "SELECT 1 FROM dbo.Emails e JOIN dbo.EmailRoutingSets s ON s.EmailId = e.EmailID"],
    ["a comment that names a forbidden statement", "// never UPDATE dbo.EmailRoutingSets\nSELECT 1"],
  ])("leaves %s alone", (_label, sql) => {
    expect(writesIn(sql)).toEqual([]);
    expect(strayMentions(sql)).toEqual([]);
  });

  it("flags a mention that is neither a write nor a read, such as a table name passed around", () => {
    expect(strayMentions("const t = 'dbo.EmailRoutingSets';")).toEqual(["dbo.EmailRoutingSets"]);
  });
});
