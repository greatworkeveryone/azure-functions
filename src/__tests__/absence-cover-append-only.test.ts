/// <reference types="jest" />
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import * as ts from "typescript";

// dbo.CoverActions is append-only (migration 177, database-safety rule: rows that log
// what the system did with someone's work are never changed). The database refuses an
// UPDATE or DELETE; these tests make sure no source file even asks. A failure here is a
// stop sign: review the change, then edit the allowlist on purpose.

const ROOT = join(__dirname, "..", "..");

// The only files that may name the table, and what each does with it. Anything else that
// mentions it fails, so a new reader or writer is reviewed before it ships.
const ALLOWED_FILES: Record<string, string> = {
  "src/absenceCover/coverActionStore.ts": "inserts a row per move or suggestion and reads the latest per item and the recent ones",
  "src/absenceCover/handback.ts": "asks whether a move was already taken back",
  "src/absenceCover/notes.ts": "reads the latest hand-over per job for Covered by Y while X is away",
  "src/escalation/adapters/absenceCover.ts": "reads a move to describe its notice and to see whether it was taken back",
};

const CHANGES_THE_TABLE = /\b(UPDATE|DELETE|TRUNCATE|DROP|ALTER|MERGE|EXEC|EXECUTE|sp_\w+|IDENTITY_INSERT|DISABLE)\b/i;
const READS_OR_APPENDS = /^\s*(SELECT|INSERT\s+INTO)\b/i;

function literalsOf(source: string): string[] {
  const file = ts.createSourceFile("source.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) found.push(node.text);
    else if (ts.isTemplateExpression(node)) found.push(node.head.text + node.templateSpans.map((span) => `\${}${span.literal.text}`).join(""));
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

function violationsIn(path: string, source: string): string[] {
  const named = literalsOf(source).filter((text) => text.includes("CoverActions"));
  if (named.length === 0) return [];
  if (!(path in ALLOWED_FILES)) return [`${path} names CoverActions but is not on the allowlist`];
  return named.flatMap((text) => {
    const found: string[] = [];
    if (text.includes(";")) found.push(`${path}: more than one statement on CoverActions: ${text.slice(0, 60)}`);
    if (!READS_OR_APPENDS.test(text)) found.push(`${path}: a statement on CoverActions that is neither a read nor an append: ${text.slice(0, 60)}`);
    if (CHANGES_THE_TABLE.test(text.replace(/\bINSERTED\b/g, ""))) found.push(`${path}: a statement that changes CoverActions: ${text.slice(0, 60)}`);
    return found;
  });
}

function filesUnder(dir: string, keep: (name: string) => boolean, skipDirs: string[] = []): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return skipDirs.includes(name) || name === "node_modules" ? [] : filesUnder(full, keep, skipDirs);
    return keep(name) ? [full] : [];
  });
}

const sourceFiles = filesUnder(join(ROOT, "src"), (name) => name.endsWith(".ts") && !name.endsWith(".test.ts"), ["__tests__"]);
const rel = (full: string) => relative(ROOT, full).split("\\").join("/");

describe("no source file changes or removes CoverActions rows", () => {
  it("finds the source to check", () => {
    expect(sourceFiles.length).toBeGreaterThan(100);
    for (const allowed of Object.keys(ALLOWED_FILES)) expect(sourceFiles.map(rel)).toContain(allowed);
  });

  it.each(sourceFiles.map(rel))("%s", (path) => {
    expect(violationsIn(path, readFileSync(join(ROOT, path), "utf8"))).toEqual([]);
  });

  it("holds the table's only INSERT in coverActionStore.ts, once", () => {
    const inserts = sourceFiles.flatMap((full) =>
      literalsOf(readFileSync(full, "utf8")).filter((text) => /INSERT\s+INTO\s+(dbo\.)?CoverActions\b/i.test(text)).map(() => rel(full)),
    );
    expect(inserts).toEqual(["src/absenceCover/coverActionStore.ts"]);
  });

  it("keeps scripts away from it too", () => {
    const scripts = filesUnder(join(ROOT, "scripts"), (name) => /\.(cjs|mjs|js|ts)$/.test(name));
    expect(scripts.filter((full) => readFileSync(full, "utf8").includes("CoverActions")).map(rel)).toEqual([]);
  });

  it("offers no update or delete function from the store", () => {
    const store = readFileSync(join(ROOT, "src", "absenceCover", "coverActionStore.ts"), "utf8");
    expect(store).not.toMatch(/export (async )?function (update|delete|remove|archive)\w*/i);
  });
});

describe("the check itself, on crafted source", () => {
  const store = "src/absenceCover/coverActionStore.ts";
  const bad = (statement: string, path = store) => violationsIn(path, `const sql = ${statement};`);

  it.each([
    ["an UPDATE", "`UPDATE dbo.CoverActions SET Action = N'kept' WHERE CoverActionId = @Id`"],
    ["an UPDATE after a SELECT", "`SELECT 1 FROM dbo.CoverActions; UPDATE dbo.CoverActions SET Action = N'kept'`"],
    ["an aliased UPDATE", "`UPDATE c SET c.Action = N'kept' FROM dbo.CoverActions c`"],
    ["a DELETE", '"DELETE FROM dbo.CoverActions WHERE CoverActionId = @Id"'],
    ["a TRUNCATE", "'TRUNCATE TABLE dbo.CoverActions'"],
    ["a DROP", "'DROP TABLE dbo.CoverActions'"],
    ["a MERGE", "`MERGE dbo.CoverActions AS t USING (SELECT 1) AS s ON 1 = 1 WHEN MATCHED THEN DELETE;`"],
    ["a switch-off of the trigger", "'ALTER TABLE dbo.CoverActions DISABLE TRIGGER ALL'"],
    ["a table name on its own, as in 'UPDATE ' + name", "'dbo.CoverActions'"],
  ])("flags %s", (_label, statement) => {
    expect(bad(statement)).not.toEqual([]);
  });

  it("flags any mention in a file that is not on the allowlist, even a SELECT", () => {
    expect(bad("`SELECT * FROM dbo.CoverActions`", "src/functions/somethingElse.ts")).toEqual([expect.stringContaining("not on the allowlist")]);
  });

  it("lets the allowlisted file append and read", () => {
    expect(bad("`INSERT INTO dbo.CoverActions (A) OUTPUT INSERTED.CoverActionId VALUES (@A)`")).toEqual([]);
    expect(bad("`SELECT ${COLUMNS} FROM dbo.CoverActions WHERE CoverActionId = @Id`")).toEqual([]);
  });
});
