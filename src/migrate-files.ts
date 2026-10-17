import { createHash } from "crypto";
import { readdir, readFile } from "fs/promises";
import path from "path";

// Migration files as the runner sees them: GO batches, a SHA-256 checksum,
// whether the runner may wrap the file in one transaction, and the checks a
// file must pass before anything is applied (DL-11). Pure — no database.

export interface MigrationFile {
  batches: string[];
  checksum: string;
  name: string;
  sql: string;
  /** False when the file declares `-- NOTRANSACTION` or manages its own. */
  transactional: boolean;
  transactionNote: string | null;
}

// Migrations before this number predate the database-safety rules.
export const FIRST_GUARDED_MIGRATION = 94;
export const APPROVAL_HEADER = /^--\s*DESTRUCTIVE:.+approved by .+\d{4}-\d{2}-\d{2}/im;

/** SHA-256 of the file with line endings normalised, so a CRLF checkout
 *  doesn't look like an edited migration. */
export function migrationChecksum(sql: string): string {
  return createHash("sha256").update(sql.replace(/\r\n/g, "\n"), "utf8").digest("hex");
}

/** Same GO split the runner has always used. */
export function splitBatches(sql: string): string[] {
  return sql
    .split(/^GO\s*$/im)
    .map((b) => b.trim())
    .filter(Boolean);
}

interface SqlScan {
  /** SQL with comments removed and every string literal reduced to ''. */
  code: string;
  /** Text of string expressions that look like dynamic SQL (EXEC(...),
   *  sp_executesql, or assigned to a variable), fragments joined across `+`. */
  dynamic: string[];
}

type Piece = { kind: "code" | "str"; text: string };

// A string is dynamic SQL when the code just before it is EXEC(, EXEC,
// sp_executesql or an assignment.
const DYNAMIC_CONTEXT = /(?:\bEXEC(?:UTE)?\s*\(?|\bsp_executesql\s+(?:@stmt\s*=\s*)?|=)\s*$/i;
// Code between two literals of one expression: `+`, optionally around operands.
const CONCAT = /^\s*\+\s*(?:[@\w.[\]]+(?:\([^()']*\))?\s*\+\s*)*$/;

/** Tokenises comments and string literals ('' escapes, N prefix) so neither a
 *  `--` inside a string nor a keyword inside a comment fools the scan. */
export function scanSql(sql: string): SqlScan {
  const pieces: Piece[] = [];
  let buf = "";
  let i = 0;
  const flush = () => {
    if (buf) pieces.push({ kind: "code", text: buf });
    buf = "";
  };
  while (i < sql.length) {
    const two = sql.slice(i, i + 2);
    if (two === "--") {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? sql.length : end;
    } else if (two === "/*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 2;
      buf += " ";
    } else if (sql[i] === "[") {
      const end = sql.indexOf("]", i);
      const stop = end === -1 ? sql.length : end + 1;
      buf += sql.slice(i, stop);
      i = stop;
    } else if (sql[i] === "'") {
      if (/(^|\W)N$/i.test(buf)) buf = buf.slice(0, -1);
      let text = "";
      let j = i + 1;
      while (j < sql.length && !(sql[j] === "'" && sql[j + 1] !== "'")) {
        text += sql[j];
        j += sql[j] === "'" ? 2 : 1;
      }
      flush();
      pieces.push({ kind: "str", text });
      i = j + 1;
    } else {
      buf += sql[i];
      i += 1;
    }
  }
  flush();

  const dynamic: string[] = [];
  for (let k = 0; k < pieces.length; k++) {
    const before = pieces[k - 1];
    if (pieces[k].kind !== "str" || (before && !DYNAMIC_CONTEXT.test(before.text))) continue;
    let text = pieces[k].text;
    while (pieces[k + 2]?.kind === "str" && CONCAT.test(pieces[k + 1].text)) {
      const operands = pieces[k + 1].text.split("+").length - 2;
      text += " x".repeat(operands) + pieces[k + 2].text;
      k += 2;
    }
    dynamic.push(text);
  }
  const code = pieces.map((p) => (p.kind === "str" ? "''" : p.text)).join("");
  return { code, dynamic };
}

const DESTRUCTIVE_PATTERNS: [string, RegExp][] = [
  ["DROP TABLE", /\bDROP\s+TABLE\b/i],
  ["DROP COLUMN", /\bDROP\s+COLUMN\b/i],
  ["DROP INDEX", /\bDROP\s+INDEX\b/i],
  ["DROP CONSTRAINT", /\bDROP\s+CONSTRAINT\b/i],
  ["DROP TRIGGER", /\bDROP\s+TRIGGER\b/i],
  ["DISABLE TRIGGER", /\bDISABLE\s+TRIGGER\b/i],
  ["TRUNCATE", /\bTRUNCATE\b/i],
  // A DELETE statement in any form (with FROM, alias + FROM, or with no FROM
  // at all before the table and its WHERE); not ON DELETE (FK action) or a
  // trigger's event list (INSTEAD OF UPDATE, DELETE AS …).
  [
    "DELETE",
    /(?<!(?:\b(?:ON|OF|FOR|AFTER)\s+|,\s*))\bDELETE\s+(?:TOP\s*\(\s*\d+\s*\)\s*)?(?:FROM\b|[\w.@#[\]]+\s+(?:FROM|WHERE|OUTPUT)\b|[\w.@#[\]]+\s*;)/i,
  ],
  ["MERGE … THEN DELETE", /\bTHEN\s+DELETE\b/i],
  ["ALTER COLUMN", /\bALTER\s+COLUMN\b/i],
  ["sp_rename", /\bsp_rename\b/i],
];

/** Top-level comma split (ignores commas inside parentheses). */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "(") depth += 1;
    else if (text[i] === ")") depth -= 1;
    else if (text[i] === "," && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

const UPDATE_STATEMENT = /\bUPDATE\s+(?:TOP\s*\(\s*\d+\s*\)\s*)?[\w.@#[\]]+\s+SET\b([\s\S]*?)(?=;|\n\s*\n|\bGO\b|\bEND\b|$)/gi;

/**
 * An UPDATE that rewrites values already there (database-safety rule 3), as
 * opposed to a backfill of a column that is still NULL: every column it SETs
 * must be pinned `<column> IS NULL` in its WHERE. Strings are already blanked.
 */
function rewritesExistingValues(code: string): boolean {
  for (const match of code.matchAll(UPDATE_STATEMENT)) {
    const statement = match[1];
    const setPart = statement.split(/\b(?:FROM|WHERE)\b/i)[0];
    const where = statement.match(/\bWHERE\b([\s\S]*)$/i)?.[1] ?? "";
    const columns = splitTopLevel(setPart)
      .map((assignment) => assignment.split("=")[0].trim().split(".").pop()?.replace(/[[\]]/g, "") ?? "")
      .filter(Boolean);
    const pinned = (column: string) =>
      new RegExp(`(?:^|[\\s(.\\]])\\[?${column}\\]?\\s+IS\\s+NULL\\b`, "i").test(where);
    if (columns.some((column) => !pinned(column))) return true;
  }
  return false;
}

/** Destructive statements in the file's code and in its dynamic SQL strings. */
export function findDestructiveStatements(sql: string): string[] {
  const { code, dynamic } = scanSql(sql);
  const texts = [code, ...dynamic];
  const hits = DESTRUCTIVE_PATTERNS.filter(([, re]) => texts.some((t) => re.test(t))).map(([label]) => label);
  if (texts.some((t) => rewritesExistingValues(scanSql(t).code))) hits.push("UPDATE (rewrites existing values)");
  return hits;
}

/** Leading comment block contains `-- NOTRANSACTION`. */
function declaresNoTransaction(sql: string): boolean {
  for (const line of sql.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    if (!trimmed.startsWith("--")) return false;
    if (/^--\s*NOTRANSACTION\b/i.test(trimmed)) return true;
  }
  return false;
}

// Statements that run their own transaction or error handling, or that SQL
// Server refuses inside a user transaction. A TRY/CATCH fallback (094, 115,
// 116) cannot continue inside an outer XACT_ABORT transaction.
const SELF_MANAGED = /\bBEGIN\s+(?:TRY|TRAN(?:SACTION)?|DISTRIBUTED)\b|\bALTER\s+DATABASE\b|\bFULLTEXT\b/i;

export function migrationFromSql(name: string, sql: string): MigrationFile {
  const noTx = declaresNoTransaction(sql);
  const selfManaged = !noTx && SELF_MANAGED.test(scanSql(sql).code);
  return {
    batches: splitBatches(sql),
    checksum: migrationChecksum(sql),
    name,
    sql,
    transactional: !noTx && !selfManaged,
    transactionNote: noTx
      ? "declares -- NOTRANSACTION"
      : selfManaged
        ? "manages its own transaction or TRY/CATCH"
        : null,
  };
}

/** Reasons the runner must refuse this file; empty when it may be applied. */
export function validateMigration(file: MigrationFile): string[] {
  const errors: string[] = [];
  if (file.batches.length === 0 || scanSql(file.sql).code.trim() === "") {
    errors.push(`${file.name}: no SQL to run`);
  }
  if (Number.parseInt(file.name, 10) >= FIRST_GUARDED_MIGRATION && !APPROVAL_HEADER.test(file.sql)) {
    for (const hit of findDestructiveStatements(file.sql)) {
      errors.push(`${file.name}: ${hit} needs a "-- DESTRUCTIVE: <reason> · approved by <person> <YYYY-MM-DD>" header`);
    }
  }
  return errors;
}

/** Top-level *.sql files without `_seed_`, in filename order. */
export async function loadMigrations(dir: string): Promise<MigrationFile[]> {
  const names = (await readdir(dir)).filter((f) => f.endsWith(".sql") && !f.includes("_seed_")).sort();
  return Promise.all(names.map(async (name) => migrationFromSql(name, await readFile(path.join(dir, name), "utf-8"))));
}
