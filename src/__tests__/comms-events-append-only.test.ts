/// <reference types="jest" />
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import * as ts from "typescript";

// dbo.CorrespondenceEvents is append-only (migration 108, database-safety rule: rows that log what
// happened are never changed). The table refuses an UPDATE or DELETE through its trigger; these tests
// make sure no source file even asks. A failure is a stop sign: review the change, then edit the
// allowlist below on purpose.

const ROOT = join(__dirname, "..", "..");
const ALLOWED_FILES: Record<string, string> = {
  "src/comms/events.ts": "inserts an event and reads a job's events",
  "src/comms/idempotency.ts": "reads a job's first event to find the job a repeated submit already made (EB2)",
};
const CHANGES_THE_TABLE = /\b(UPDATE|DELETE|TRUNCATE|DROP|ALTER|MERGE|EXEC|EXECUTE|sp_\w+|IDENTITY_INSERT|DISABLE)\b/i;
const READS_OR_APPENDS = /^\s*(SELECT|INSERT\s+INTO)\b/i;

export function literalsOf(source: string): string[] {
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

export function violationsIn(path: string, source: string): string[] {
  const named = literalsOf(source).filter((text) => text.includes("CorrespondenceEvents"));
  if (named.length === 0) return [];
  if (!(path in ALLOWED_FILES)) return [`${path} names CorrespondenceEvents but is not on the allowlist`];
  return named.flatMap((text) => {
    const found: string[] = [];
    if (text.includes(";")) found.push(`${path}: more than one statement on CorrespondenceEvents: ${text.slice(0, 60)}`);
    if (!READS_OR_APPENDS.test(text)) found.push(`${path}: a statement that is neither a read nor an append: ${text.slice(0, 60)}`);
    if (CHANGES_THE_TABLE.test(text.replace(/\bINSERTED\b/g, ""))) found.push(`${path}: a statement that changes CorrespondenceEvents: ${text.slice(0, 60)}`);
    return found;
  });
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === "node_modules" || name === "__tests__" ? [] : filesUnder(full);
    return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [full] : [];
  });
}

const sources = filesUnder(join(ROOT, "src")).map((full) => relative(ROOT, full).split("\\").join("/"));

describe("no source file changes or removes CorrespondenceEvents rows", () => {
  it("finds the source to check", () => {
    expect(sources.length).toBeGreaterThan(100);
    for (const allowed of Object.keys(ALLOWED_FILES)) expect(sources).toContain(allowed);
  });

  it.each(sources)("%s", (path) => {
    expect(violationsIn(path, readFileSync(join(ROOT, path), "utf8"))).toEqual([]);
  });

  it("holds the table's only INSERT in src/comms/events.ts, once", () => {
    const inserts = sources.flatMap((path) =>
      literalsOf(readFileSync(join(ROOT, path), "utf8")).filter((text) => /INSERT\s+INTO\s+(dbo\.)?CorrespondenceEvents\b/i.test(text)).map(() => path),
    );
    expect(inserts).toEqual(["src/comms/events.ts"]);
  });

  it("would catch an UPDATE, a DELETE and an unlisted file", () => {
    expect(violationsIn("src/comms/events.ts", 'const a = "UPDATE dbo.CorrespondenceEvents SET Detail = 1";')).not.toEqual([]);
    expect(violationsIn("src/comms/events.ts", 'const a = "DELETE FROM dbo.CorrespondenceEvents";')).not.toEqual([]);
    expect(violationsIn("src/comms/store.ts", 'const a = "SELECT 1 FROM dbo.CorrespondenceEvents";')).not.toEqual([]);
  });

  it("is backed by the trigger in migration 108", () => {
    const sql = readFileSync(join(ROOT, "migrations", "108_comms_core.sql"), "utf8");
    expect(sql).toMatch(/TR_CorrespondenceEvents_AppendOnly ON dbo\.CorrespondenceEvents INSTEAD OF UPDATE, DELETE/);
  });
});
