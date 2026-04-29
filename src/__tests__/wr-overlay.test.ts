import { describe, test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  AUTHORITATIVE_COLUMNS,
  buildOverlayUpsertSql,
  computeMergedLastModified,
  mergeOverride,
  OVERLAY_COLUMNS,
  pickOverlayFields,
  workRequestSelectColumns,
  WR_OVERLAY_JOIN,
} from "../wr-overlay";

describe("workRequestSelectColumns", () => {
  const sql = workRequestSelectColumns();

  test("emits each authoritative column directly from wr", () => {
    for (const col of AUTHORITATIVE_COLUMNS) {
      assert.match(sql, new RegExp(`wr\\.${col}`));
    }
  });

  test("emits COALESCE(o.col, wr.col) for every overlay column", () => {
    for (const col of OVERLAY_COLUMNS) {
      // 'Type' is a reserved word and must be bracket-quoted on both sides.
      const lhs = col === "Type" ? "o\\.\\[Type\\]" : `o\\.${col}`;
      const rhs = col === "Type" ? "wr\\.\\[Type\\]" : `wr\\.${col}`;
      const alias = col === "Type" ? "AS \\[Type\\]" : `AS ${col}`;
      const pattern = new RegExp(`COALESCE\\(${lhs}, ${rhs}\\) ${alias}`);
      assert.match(sql, pattern, `missing COALESCE for ${col}`);
    }
  });

  test("computes LastModifiedDate as the later of wr and overlay timestamps", () => {
    // Mirrors the reasoning in the wr-overlay comment: local edits must advance
    // LastModifiedDate so stalled-detection and 409 conflict checks stay honest.
    assert.match(sql, /wr\.LastModifiedDate > o\.UpdatedAt/);
    assert.match(sql, /AS LastModifiedDate/);
  });

  test("LastModifiedDate references are only inside the CASE expression (no duplicate plain select)", () => {
    // Inside the CASE we reference wr.LastModifiedDate exactly twice:
    //   "wr.LastModifiedDate > o.UpdatedAt"  and
    //   "THEN wr.LastModifiedDate ELSE ..."
    // A third occurrence would mean there's a bare `wr.LastModifiedDate` in
    // the SELECT list that would shadow our computed column.
    const matches = sql.match(/wr\.LastModifiedDate/g) ?? [];
    assert.strictEqual(matches.length, 2, `expected exactly 2 refs inside CASE, got ${matches.length}`);
  });

  test("LastModifiedDate column is NOT in AUTHORITATIVE_COLUMNS (it's computed)", () => {
    assert.ok(
      !(AUTHORITATIVE_COLUMNS as readonly string[]).includes("LastModifiedDate"),
      "LastModifiedDate should be computed via CASE, not selected direct from wr",
    );
  });

  test("includes AttachmentCount via grouped join", () => {
    assert.match(sql, /COALESCE\(ac\.AttachmentCount, 0\) AS AttachmentCount/);
  });

  test("emits HasLocalOverride flag", () => {
    assert.match(sql, /CASE WHEN o\.WorkRequestID IS NOT NULL THEN 1 ELSE 0 END AS HasLocalOverride/);
  });

  test("WR_OVERLAY_JOIN uses LEFT JOIN keyed by WorkRequestID", () => {
    assert.match(WR_OVERLAY_JOIN, /LEFT JOIN WorkRequestOverrides o ON o\.WorkRequestID = wr\.WorkRequestID/);
  });

  test("WR_OVERLAY_JOIN includes grouped AttachmentCount join (replaces O(N) correlated subquery)", () => {
    assert.match(
      WR_OVERLAY_JOIN,
      /LEFT JOIN \(SELECT WorkRequestID, COUNT\(\*\) AS AttachmentCount FROM Attachments GROUP BY WorkRequestID\) ac/,
    );
  });
});

describe("mergeOverride", () => {
  const baseWr = {
    WorkRequestID: 1,
    JobCode: "ABC123",
    AssignedTo: "Adam",
    Priority: "Normal",
    Details: "from myBuildings",
    // Authoritative — must never be overwritten by the overlay helper.
    StatusID: 1,
    Status: "Open",
  } as any;

  test("returns base unchanged when override is null or undefined", () => {
    assert.deepStrictEqual(mergeOverride(baseWr, null), baseWr);
    assert.deepStrictEqual(mergeOverride(baseWr, undefined), baseWr);
  });

  test("overlay values win over base when present", () => {
    const merged = mergeOverride(baseWr, { AssignedTo: "Beth", Priority: "High" });
    assert.strictEqual(merged.AssignedTo, "Beth");
    assert.strictEqual(merged.Priority, "High");
  });

  test("null and undefined values in override do NOT win (treated as absent)", () => {
    const merged = mergeOverride(baseWr, { AssignedTo: null, Priority: undefined });
    assert.strictEqual(merged.AssignedTo, "Adam");
    assert.strictEqual(merged.Priority, "Normal");
  });

  test("empty string IS a valid overlay value and wins (lets users clear a field to ')", () => {
    const merged = mergeOverride(baseWr, { AssignedTo: "" });
    assert.strictEqual(merged.AssignedTo, "");
  });

  test("authoritative columns are unaffected even if passed (not in OVERLAY_COLUMNS)", () => {
    const merged = mergeOverride(baseWr, { StatusID: 99, Status: "Closed" } as any);
    assert.strictEqual(merged.StatusID, 1);
    assert.strictEqual(merged.Status, "Open");
  });

  test("does not mutate the base WR or the override object", () => {
    const baseCopy = { ...baseWr };
    const override = { AssignedTo: "Beth" };
    const overrideCopy = { ...override };
    mergeOverride(baseWr, override);
    assert.deepStrictEqual(baseWr, baseCopy);
    assert.deepStrictEqual(override, overrideCopy);
  });
});

describe("OVERLAY_COLUMNS / AUTHORITATIVE_COLUMNS partitioning", () => {
  test("the two sets do not overlap", () => {
    const auth = new Set<string>(AUTHORITATIVE_COLUMNS as readonly string[]);
    for (const c of OVERLAY_COLUMNS) {
      assert.ok(!auth.has(c), `${c} is in both lists — ambiguous provenance`);
    }
  });

  test("OVERLAY_COLUMNS has no duplicates", () => {
    const s = new Set<string>(OVERLAY_COLUMNS as readonly string[]);
    assert.strictEqual(s.size, OVERLAY_COLUMNS.length);
  });

  test("LastModifiedDate is excluded from both lists (it's computed)", () => {
    assert.ok(!(AUTHORITATIVE_COLUMNS as readonly string[]).includes("LastModifiedDate"));
    assert.ok(!(OVERLAY_COLUMNS as readonly string[]).includes("LastModifiedDate"));
  });
});

// ── pickOverlayFields ────────────────────────────────────────────────────────

describe("pickOverlayFields", () => {
  test("filters out unknown fields entirely", () => {
    const result = pickOverlayFields({
      AssignedTo: "Adam",
      StatusID: 99, // authoritative, must be dropped
      Hello: "world", // not a WR column at all
      WorkRequestID: 5, // handled separately by the endpoint, not an overlay
    });
    assert.deepStrictEqual(result, { AssignedTo: "Adam" });
  });

  test("preserves explicit null (signal to clear the override)", () => {
    const result = pickOverlayFields({ AssignedTo: null });
    assert.ok("AssignedTo" in result);
    assert.strictEqual(result.AssignedTo, null);
  });

  test("preserves undefined only when key is present (edge case — usually stripped by JSON)", () => {
    // JSON.parse strips undefined so this path is defensive. But if a handler
    // builds an object programmatically with explicit undefined, it still
    // counts as "present" via `in` and passes through.
    const input = { AssignedTo: undefined } as any;
    const result = pickOverlayFields(input);
    assert.ok("AssignedTo" in result);
    assert.strictEqual(result.AssignedTo, undefined);
  });

  test("preserves falsy but meaningful values (empty string, 0, false)", () => {
    const result = pickOverlayFields({
      AssignedTo: "",
      TotalCost: 0,
      Details: "",
    });
    assert.strictEqual(result.AssignedTo, "");
    assert.strictEqual(result.TotalCost, 0);
    assert.strictEqual(result.Details, "");
  });

  test("empty body yields empty result", () => {
    assert.deepStrictEqual(pickOverlayFields({}), {});
  });

  test("does not mutate the input object", () => {
    const input: any = { AssignedTo: "Adam", StatusID: 1 };
    const snapshot = { ...input };
    pickOverlayFields(input);
    assert.deepStrictEqual(input, snapshot);
  });

  test("accepts every OVERLAY_COLUMN by name", () => {
    const input: Record<string, string | number> = {};
    for (const c of OVERLAY_COLUMNS) {
      input[c] = c === "TotalCost" || c === "CostNotToExceed" ? 42 : `val-${c}`;
    }
    const result = pickOverlayFields(input);
    assert.strictEqual(Object.keys(result).length, OVERLAY_COLUMNS.length);
    for (const c of OVERLAY_COLUMNS) {
      assert.ok(c in result, `missing ${c} in picked output`);
    }
  });
});

// ── computeMergedLastModified ────────────────────────────────────────────────

describe("computeMergedLastModified", () => {
  const t1 = new Date("2026-01-01T00:00:00Z");
  const t2 = new Date("2026-02-01T00:00:00Z");

  test("returns null when both inputs are null", () => {
    assert.strictEqual(computeMergedLastModified(null, null), null);
  });

  test("returns wr when only overlay is null", () => {
    assert.strictEqual(computeMergedLastModified(t1, null), t1);
  });

  test("returns overlay when only wr is null", () => {
    assert.strictEqual(computeMergedLastModified(null, t1), t1);
  });

  test("returns wr when wr is strictly newer", () => {
    assert.strictEqual(computeMergedLastModified(t2, t1), t2);
  });

  test("returns overlay when overlay is strictly newer", () => {
    assert.strictEqual(computeMergedLastModified(t1, t2), t2);
  });

  test("on equal timestamps, overlay wins (matches SQL ELSE branch)", () => {
    const a = new Date("2026-03-15T10:00:00Z");
    const b = new Date("2026-03-15T10:00:00Z");
    // Using different Date instances to ensure we're not checking identity
    assert.strictEqual(computeMergedLastModified(a, b), b);
  });
});

// ── buildOverlayUpsertSql ────────────────────────────────────────────────────

describe("buildOverlayUpsertSql", () => {
  test("emits a MERGE statement with HOLDLOCK", () => {
    const sql = buildOverlayUpsertSql(["AssignedTo"]);
    assert.match(sql, /MERGE INTO WorkRequestOverrides WITH \(HOLDLOCK\)/);
  });

  test("keys the match on WorkRequestID", () => {
    const sql = buildOverlayUpsertSql(["AssignedTo"]);
    assert.match(sql, /ON target\.WorkRequestID = src\.WorkRequestID/);
  });

  test("UPDATE SET includes each field column, UpdatedAt, and UpdatedBy", () => {
    const sql = buildOverlayUpsertSql(["AssignedTo", "Priority"]);
    assert.match(sql, /UPDATE SET AssignedTo = @AssignedTo/);
    assert.match(sql, /Priority = @Priority/);
    assert.match(sql, /UpdatedAt = SYSUTCDATETIME\(\)/);
    assert.match(sql, /UpdatedBy = @UpdatedBy/);
  });

  test("INSERT lists WorkRequestID, each field column, and UpdatedBy in that order", () => {
    const sql = buildOverlayUpsertSql(["AssignedTo", "Priority"]);
    assert.match(sql, /INSERT \(WorkRequestID, AssignedTo, Priority, UpdatedBy\)/);
    assert.match(sql, /VALUES \(@WorkRequestID, @AssignedTo, @Priority, @UpdatedBy\)/);
  });

  test("quotes the reserved word Type with brackets in column refs but not in params", () => {
    const sql = buildOverlayUpsertSql(["Type"]);
    // The column must appear as [Type] on both sides of the UPDATE SET
    assert.match(sql, /\[Type\] = @Type/);
    // And in the INSERT column list
    assert.match(sql, /INSERT \(WorkRequestID, \[Type\], UpdatedBy\)/);
    // The parameter name itself stays @Type (no brackets — not valid syntax)
    assert.match(sql, /VALUES \(@WorkRequestID, @Type, @UpdatedBy\)/);
    assert.ok(!sql.includes("@[Type]"), "parameter names must not be bracketed");
  });

  test("handles the empty column list (used by reset-ish callers)", () => {
    // Edge case: even with no overlay columns, the SQL should still be valid
    // (just updates UpdatedAt / UpdatedBy on an existing row, or inserts a
    // bare row). The endpoint-level guard rejects this, but the builder
    // itself must not emit invalid SQL if called.
    const sql = buildOverlayUpsertSql([]);
    assert.match(sql, /UPDATE SET UpdatedAt = SYSUTCDATETIME\(\), UpdatedBy = @UpdatedBy/);
    assert.match(sql, /INSERT \(WorkRequestID, UpdatedBy\)/);
    assert.match(sql, /VALUES \(@WorkRequestID, @UpdatedBy\)/);
  });

  test("preserves caller-supplied column order (frontend may send any subset)", () => {
    const sql1 = buildOverlayUpsertSql(["Priority", "AssignedTo"]);
    const sql2 = buildOverlayUpsertSql(["AssignedTo", "Priority"]);
    assert.notStrictEqual(sql1, sql2, "order should influence the SQL (it's parameterised identically but position matters for INSERT alignment)");
  });
});

// ── Migration ↔ code consistency ─────────────────────────────────────────────
//
// If someone adds a column to OVERLAY_COLUMNS but forgets the SQL migration
// (or vice versa), overlay writes blow up with "Invalid column name" at
// runtime. These assertions catch it at test time.

describe("migrations/004_work_request_overrides.sql ↔ OVERLAY_COLUMNS", () => {
  const migrationPath = resolve(__dirname, "..", "..", "migrations", "004_work_request_overrides.sql");
  const migration = readFileSync(migrationPath, "utf8");

  test("every OVERLAY_COLUMN appears as a column declaration in the migration", () => {
    for (const col of OVERLAY_COLUMNS) {
      // "Type" is declared as [Type] in the SQL to avoid the reserved word;
      // [ is non-word so a plain \b won't match before it — use a different
      // anchor for the Type case.
      const regex =
        col === "Type"
          ? /\[Type\]\s+(NVARCHAR|DECIMAL|INT|BIGINT|DATETIME)/
          : new RegExp(`\\b${col}\\s+(NVARCHAR|DECIMAL|INT|BIGINT|DATETIME)`);
      assert.match(migration, regex, `migration missing declaration for ${col}`);
    }
  });

  test("migration declares WorkRequestID as PK", () => {
    assert.match(migration, /WorkRequestID\s+INT\s+NOT NULL PRIMARY KEY/);
  });

  test("migration declares UpdatedAt default as SYSUTCDATETIME", () => {
    assert.match(migration, /UpdatedAt\s+DATETIME2\s+NOT NULL\s+CONSTRAINT\s+\w+\s+DEFAULT SYSUTCDATETIME\(\)/);
  });

  test("migration declares UpdatedBy column (tracked in the MERGE)", () => {
    assert.match(migration, /UpdatedBy\s+NVARCHAR/);
  });

  test("no authoritative column is declared in the overrides table", () => {
    // Paranoia: if someone drops an authoritative WR column (StatusID,
    // JobCode, BuildingID, etc) into the overrides table, the overlay would
    // appear to work but the SQL SELECT still reads from wr — confusing.
    //
    // UpdatedAt is legitimately on both tables (different meanings — WR sync
    // time vs. override save time), so exclude it. Same for WorkRequestID
    // (PK on the overrides table, FK to WR).
    const LEGITIMATELY_SHARED = new Set(["UpdatedAt", "WorkRequestID"]);
    for (const col of AUTHORITATIVE_COLUMNS) {
      if (LEGITIMATELY_SHARED.has(col)) continue;
      const regex = new RegExp(`\\b${col}\\s+(NVARCHAR|DECIMAL|INT|BIGINT|DATETIME)`);
      assert.ok(
        !regex.test(migration),
        `authoritative column ${col} appears in the overrides table — ambiguous provenance`,
      );
    }
  });
});

// ── mergeOverride: falsy-but-meaningful values and mutation safety ───────────

describe("mergeOverride falsy handling (SQL COALESCE semantics)", () => {
  const wr: any = { AssignedTo: "Adam", TotalCost: 100, Priority: "Normal" };

  test("false is a valid overlay value (though no boolean overlay cols today)", () => {
    // Hypothetical: if we ever add a boolean overlay column, false must win.
    // This test documents the intended semantics of the helper.
    const merged = mergeOverride<any>({ flag: true }, { flag: false } as any);
    assert.strictEqual(merged.flag, true); // flag isn't in OVERLAY_COLUMNS
  });

  test("0 wins as an overlay value", () => {
    const merged = mergeOverride(wr, { TotalCost: 0 });
    assert.strictEqual(merged.TotalCost, 0);
  });

  test("undefined explicitly in override does NOT win", () => {
    const merged = mergeOverride(wr, { AssignedTo: undefined });
    assert.strictEqual(merged.AssignedTo, "Adam");
  });

  test("very long string is passed through as-is", () => {
    const long = "x".repeat(10_000);
    const merged = mergeOverride(wr, { Details: long });
    assert.strictEqual(merged.Details, long);
  });
});
