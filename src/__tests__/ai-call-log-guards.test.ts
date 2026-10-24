/// <reference types="jest" />
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import * as ts from "typescript";
import { findDestructiveStatements } from "../migrate-files";

// dbo.AiCallLog is append-only (migration 170, database-safety rule: rows that log
// decisions or AI calls are never changed). The database refuses an UPDATE or
// DELETE; these tests make sure no source file even asks, and that nothing but the
// gateway reaches a model. A failure here is a stop sign: review the change, then
// edit the allowlist below on purpose.

const ROOT = join(__dirname, "..", "..");

// The only files that may name the table, and what each does with it. Anything
// else that mentions it fails, so a new reader or writer is reviewed before it ships.
const ALLOWED_FILES: Record<string, string> = {
  "src/ai/callLog.ts": "inserts a row per call and counts a person's recent ones",
  "src/ai/callQuery.ts": "reads a page of rows for Admin → AI activity",
};

// Statements that change or remove rows, the table, or its protection.
const CHANGES_THE_TABLE = /\b(UPDATE|DELETE|TRUNCATE|DROP|ALTER|MERGE|EXEC|EXECUTE|sp_\w+|IDENTITY_INSERT|DISABLE)\b/i;
const READS_OR_APPENDS = /^\s*(SELECT|INSERT\s+INTO)\b/i;

/** The text of every string and template literal in a TypeScript source, `${}` standing for each substitution. */
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

/** What is wrong with a source file's dealings with the table, as sentences; empty when nothing is. */
export function violationsIn(path: string, source: string): string[] {
  const named = literalsOf(source).filter((text) => text.includes("AiCallLog"));
  if (named.length === 0) return [];
  if (!(path in ALLOWED_FILES)) return [`${path} names AiCallLog but is not on the allowlist`];
  return named.flatMap((text) => {
    const found: string[] = [];
    if (text.includes(";")) found.push(`${path}: more than one statement on AiCallLog: ${text.slice(0, 60)}`);
    if (!READS_OR_APPENDS.test(text)) found.push(`${path}: a statement on AiCallLog that is neither a read nor an append: ${text.slice(0, 60)}`);
    if (CHANGES_THE_TABLE.test(text.replace(/\bINSERTED\b/g, ""))) found.push(`${path}: a statement that changes AiCallLog: ${text.slice(0, 60)}`);
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

describe("no source file changes or removes AiCallLog rows", () => {
  it("finds the source to check", () => {
    expect(sourceFiles.length).toBeGreaterThan(100);
    for (const allowed of Object.keys(ALLOWED_FILES)) expect(sourceFiles.map(rel)).toContain(allowed);
  });

  it.each(sourceFiles.map(rel))("%s", (path) => {
    expect(violationsIn(path, readFileSync(join(ROOT, path), "utf8"))).toEqual([]);
  });

  it("holds the table's only INSERT in src/ai/callLog.ts, once", () => {
    const inserts = sourceFiles.flatMap((full) =>
      literalsOf(readFileSync(full, "utf8")).filter((text) => /INSERT\s+INTO\s+(dbo\.)?AiCallLog\b/i.test(text)).map(() => rel(full)),
    );
    expect(inserts).toEqual(["src/ai/callLog.ts"]);
  });

  it("keeps scripts away from it too", () => {
    const scripts = filesUnder(join(ROOT, "scripts"), (name) => /\.(cjs|mjs|js|ts)$/.test(name));
    expect(scripts.filter((full) => readFileSync(full, "utf8").includes("AiCallLog")).map(rel)).toEqual([]);
  });
});

describe("the check itself, on crafted source", () => {
  const callLog = "src/ai/callLog.ts";
  const bad = (statement: string, path = callLog) => violationsIn(path, `const sql = ${statement};`);

  it.each([
    ["an UPDATE", "`UPDATE dbo.AiCallLog SET Outcome = N'ok' WHERE Id = @Id`"],
    ["an UPDATE after a SELECT", "`SELECT 1 FROM dbo.AiCallLog; UPDATE dbo.AiCallLog SET Outcome = N'ok'`"],
    ["an aliased UPDATE", "`UPDATE a SET a.Outcome = N'ok' FROM dbo.AiCallLog a`"],
    ["a DELETE", '"DELETE FROM dbo.AiCallLog WHERE Id = @Id"'],
    ["an aliased DELETE", "`DELETE a FROM dbo.AiCallLog a WHERE a.Id = 1`"],
    ["a DELETE with no FROM", "'DELETE dbo.AiCallLog'"],
    ["a TRUNCATE", "'TRUNCATE TABLE dbo.AiCallLog'"],
    ["a DROP", "'DROP TABLE dbo.AiCallLog'"],
    ["a MERGE, which can update or delete", "`MERGE dbo.AiCallLog AS t USING (SELECT 1) AS s ON 1 = 1 WHEN MATCHED THEN DELETE;`"],
    ["a rename", "\"EXEC sp_rename 'dbo.AiCallLog', 'Old'\""],
    ["a switch-off of the trigger", "'ALTER TABLE dbo.AiCallLog DISABLE TRIGGER ALL'"],
    ["a statement built in pieces", "`SELECT 1 FROM dbo.AiCallLog; ${\"DEL\"}ETE FROM dbo.AiCallLog`"],
    ["a table name on its own, as in 'UPDATE ' + name", "'dbo.AiCallLog'"],
    ["an UPDATE hidden in a longer template", "`WITH x AS (SELECT 1) UPDATE dbo.AiCallLog SET ErrorCode = NULL`"],
  ])("flags %s", (_label, statement) => {
    expect(bad(statement)).not.toEqual([]);
  });

  it("flags any mention in a file that is not on the allowlist, even a SELECT", () => {
    expect(bad("`SELECT * FROM dbo.AiCallLog`", "src/functions/somethingElse.ts")).toEqual([expect.stringContaining("not on the allowlist")]);
  });

  it("ignores a mention in a comment, and a file that never names the table", () => {
    expect(violationsIn("src/functions/other.ts", "// UPDATE dbo.AiCallLog SET x = 1\n/* DELETE FROM dbo.AiCallLog */\nconst a = 1;")).toEqual([]);
    expect(violationsIn("src/functions/other.ts", "const sql = `UPDATE dbo.Jobs SET Status = 1`;")).toEqual([]);
  });

  it.each([
    ["the insert", "`INSERT INTO dbo.AiCallLog (A, B)\\n  OUTPUT INSERTED.Id\\n  VALUES (@A, @B)`"],
    ["a count", "`SELECT COUNT(*) AS Calls FROM dbo.AiCallLog WHERE CreatedAt >= @From`"],
    ["a page", "`SELECT ${COLUMNS} FROM dbo.AiCallLog ${whereSql} ORDER BY Id DESC${suffix}`"],
  ])("lets the allowlisted file do %s", (_label, statement) => {
    expect(bad(statement)).toEqual([]);
  });
});

describe("no code writes prompt or answer text into the log (review M2)", () => {
  const nonTest = sourceFiles;

  it("names neither InputText nor OutputText in any string in the source, or in a script", () => {
    const scripts = filesUnder(join(ROOT, "scripts"), (name) => /\.(cjs|mjs|js|ts)$/.test(name));
    const mentions = [...nonTest, ...scripts].filter((full) => {
      const text = readFileSync(full, "utf8");
      const code = full.endsWith(".ts") ? literalsOf(text).join("\n") : text;
      return /\b(InputText|OutputText)\b/.test(code);
    });
    expect(mentions.map(rel)).toEqual([]);
  });

  it("has no setting that would switch it on: AI_LOG_CONTENT is read nowhere", () => {
    const scripts = filesUnder(join(ROOT, "scripts"), (name) => /\.(cjs|mjs|js|ts)$/.test(name));
    expect([...nonTest, ...scripts].filter((full) => readFileSync(full, "utf8").includes("AI_LOG_CONTENT")).map(rel)).toEqual([]);
  });

  it("leaves the two text columns in migration 170 as they are: nullable, and unused", () => {
    const migration = readFileSync(join(ROOT, "migrations", "170_ai_call_log.sql"), "utf8");
    expect(migration).toMatch(/InputText\s+NVARCHAR\(MAX\)\s+NULL/);
    expect(migration).toMatch(/OutputText\s+NVARCHAR\(MAX\)\s+NULL/);
  });

  it("would catch a write to either column", () => {
    for (const statement of ["`INSERT INTO dbo.AiCallLog (InputText) VALUES (@Text)`", "'OutputText'", '"InputText = @x"']) {
      const strings = literalsOf(`const sql = ${statement};`).join("\n");
      expect(/\b(InputText|OutputText)\b/.test(strings)).toBe(true);
    }
  });
});

describe("nothing but the gateway reaches a model", () => {
  // The gateway's own settings (docs/runbooks/switches.md); AI_PARSE_* belong to the older email parser.
  const GATEWAY_SETTINGS = /process\.env(?:\.|\[\s*["'`])AI_(?:ENABLED|PROVIDER|BASE_URL|MODEL|API_KEY|PURPOSES_ENABLED|TIMEOUT_MS|RATE_PER_MINUTE)\b/;
  const outsideAi = sourceFiles.filter((full) => !rel(full).startsWith("src/ai/"));

  it("keeps the providers and the AI settings inside src/ai", () => {
    const strays = outsideAi.flatMap((full) => {
      const text = readFileSync(full, "utf8");
      const found: string[] = [];
      if (/from\s+["'][^"']*ai\/providers/.test(text)) found.push("imports a provider");
      if (GATEWAY_SETTINGS.test(text)) found.push("reads an AI gateway setting");
      return found.map((what) => `${rel(full)} ${what}`);
    });
    expect(strays).toEqual([]);
  });

  it("has one door in: the gateway's index exports runAi and no provider", () => {
    const code = readFileSync(join(ROOT, "src", "ai", "index.ts"), "utf8")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    expect(code).toMatch(/export \{ runAi \} from "\.\/runAi"/);
    expect(code).not.toMatch(/providers|callProvider|redactText|callLog/);
  });
});

describe("migration 170 only ever appends", () => {
  const migrations = filesUnder(join(ROOT, "migrations"), (name) => name.endsWith(".sql"));
  const touching = migrations.filter((full) => readFileSync(full, "utf8").includes("AiCallLog"));

  it("is the only migration that creates or changes the table: 177 names it in a comment only, as the pattern its own ledger follows", () => {
    expect(touching.map((full) => relative(join(ROOT, "migrations"), full))).toEqual(["170_ai_call_log.sql", "177_absence_cover.sql"]);
  });

  it.each(touching.map(rel))("%s holds no statement that changes or removes rows, drops the table or its trigger, or switches the trigger off", (path) => {
    expect(findDestructiveStatements(readFileSync(join(ROOT, path), "utf8"))).toEqual([]);
  });
});
