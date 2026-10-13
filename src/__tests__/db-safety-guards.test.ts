import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// Guards for the database-safety rules (~/.claude/rules/database-safety.md):
// a destructive migration needs a written approval header, and every place
// that hard-deletes rows or blobs is on a reviewed allowlist. A failure here
// is a stop sign — review the change, then update the allowlist deliberately.

const ROOT = join(__dirname, "..", "..");
const MIGRATIONS_DIR = join(ROOT, "migrations");
const SRC_DIR = join(ROOT, "src");

// Migrations before this number predate the rules and are grandfathered.
const FIRST_GUARDED_MIGRATION = 94;

const DESTRUCTIVE = [
  /\bDROP\s+TABLE\b/i,
  /\bDROP\s+COLUMN\b/i,
  /\bTRUNCATE\b/i,
  /\bDELETE\s+FROM\b/i,
  /\bALTER\s+COLUMN\b/i,
  /\bsp_rename\b/i,
];
const APPROVAL_HEADER = /^--\s*DESTRUCTIVE:.+approved by .+\d{4}-\d{2}-\d{2}/im;

function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--.*$/gm, "");
}

describe("migrations are additive unless explicitly approved", () => {
  const files = readdirSync(MIGRATIONS_DIR).filter(
    (f) => f.endsWith(".sql") && Number.parseInt(f, 10) >= FIRST_GUARDED_MIGRATION,
  );

  it.each(files.length ? files : ["(none yet)"])("%s", (file) => {
    if (file === "(none yet)") return;
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    const hits = DESTRUCTIVE.filter((re) => re.test(stripSqlComments(sql)));
    if (hits.length > 0) {
      expect(sql).toMatch(APPROVAL_HEADER);
    }
  });
});

// Hard-delete call sites as reviewed on 13 Oct 2026. Existing entries are
// grandfathered pending the money-controls review (LAUNCH-READINESS WP42);
// a new file or a higher count fails until someone reviews it and edits this.
const DELETE_ALLOWLIST: Record<string, { deleteBlob?: number; deleteFrom?: number }> = {
  "src/blob-storage.ts": { deleteBlob: 1 },
  "src/functions/attachments.ts": { deleteBlob: 1, deleteFrom: 2 },
  "src/functions/cleanupAttachments.ts": { deleteBlob: 1 },
  "src/functions/inspections.ts": { deleteBlob: 1, deleteFrom: 6 },
  "src/functions/invoices.ts": { deleteFrom: 1 },
  "src/functions/jobRequestedContractors.ts": { deleteFrom: 1 },
  "src/functions/purchaseOrders.ts": { deleteBlob: 1, deleteFrom: 1 },
  "src/functions/quotes.ts": { deleteFrom: 1 },
  "src/functions/tenancy.ts": { deleteFrom: 4 },
  "src/functions/tenants.ts": { deleteFrom: 1 },
  // Removes only the blob this same request just uploaded, when the database insert that follows it fails.
  "src/functions/uploadAssetAttachment.ts": { deleteBlob: 1 },
  "src/functions/vacancies.ts": { deleteFrom: 1 },
  "src/functions/workRequests.ts": { deleteFrom: 1 },
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === "__tests__" ? [] : sourceFiles(full);
    return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [full] : [];
  });
}

function count(text: string, re: RegExp): number {
  return (text.match(re) ?? []).length;
}

describe("hard deletes only happen at reviewed call sites", () => {
  const found = sourceFiles(SRC_DIR)
    .map((full) => {
      const text = readFileSync(full, "utf8");
      return {
        deleteBlob: count(text, /deleteBlob\(/g),
        deleteFrom: count(text, /DELETE\s+FROM/gi),
        file: relative(ROOT, full).split("\\").join("/"),
      };
    })
    .filter((f) => f.deleteBlob > 0 || f.deleteFrom > 0);

  it.each(found)("$file", ({ deleteBlob, deleteFrom, file }) => {
    const allowed = DELETE_ALLOWLIST[file] ?? {};
    expect(deleteBlob).toBeLessThanOrEqual(allowed.deleteBlob ?? 0);
    expect(deleteFrom).toBeLessThanOrEqual(allowed.deleteFrom ?? 0);
  });
});
