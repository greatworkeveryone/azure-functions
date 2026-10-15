/// <reference types="jest" />
// Migration 099 seeds WP26's three escalation policies insert-only (PLAN §3.4).
// A regex tripwire over the raw file, like 098's, plus its values held against
// 098's seed and the ladder parser. It was also run against a real SQL Server
// (twice, and on a table without 098's rows) before it merged.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { findDestructiveStatements } from "../migrate-files";
import { parseLadder } from "../escalation/policies";

const read = (file: string): string => readFileSync(join(__dirname, "..", "..", "migrations", file), "utf8");
const stripComments = (sql: string): string => sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");

const raw = read("099_rent_review_policies.sql");
const code = stripComments(raw);
const KEYS = ["rent_review.not_commenced", "rent_review.overdue", "rent_review.approval"] as const;

/** (PolicyKey, Kind, Urgent, Clock, AutoReescalate, Ladder, Active) rows of a seed. */
function seedRows(sql: string): Map<string, string[]> {
  const rows = new Map<string, string[]>();
  for (const match of stripComments(sql).matchAll(/\(N'([\w.]+)',\s*N'(\w+)',\s*(\d),\s*N'(\w+)',\s*N'(\w+)',\s*N'(\[[^']*\])',\s*(\d)\)/g)) {
    rows.set(match[1], match.slice(2));
  }
  return rows;
}

describe("099_rent_review_policies.sql is additive and safe to run twice", () => {
  it("contains nothing destructive, and the runner's own scan agrees", () => {
    expect(raw).not.toMatch(/\bDROP\s+(TABLE|COLUMN)\b|\bTRUNCATE\b|\bDELETE\s+FROM\b|\bALTER\s+COLUMN\b|\bsp_rename\b/i);
    expect(code).not.toMatch(/\b(DROP|TRUNCATE|DELETE|ALTER)\b/i);
    expect(findDestructiveStatements(raw)).toEqual([]);
  });

  it("never rewrites a policy: MERGE ... WHEN NOT MATCHED THEN INSERT only, no UPDATE", () => {
    expect(code).toMatch(/MERGE\s+dbo\.EscalationPolicies/i);
    expect(code).toMatch(/WHEN NOT MATCHED BY TARGET THEN\s+INSERT/i);
    expect(code).not.toMatch(/WHEN\s+MATCHED/i);
    expect(code).not.toMatch(/\bUPDATE\b/i);
  });

  it("does nothing unless 098's table exists", () => {
    expect(code.trim()).toMatch(/^IF OBJECT_ID\(N'dbo\.EscalationPolicies', N'U'\) IS NOT NULL\s+BEGIN/);
  });

  it("says who inserted a row", () => {
    expect(code).toContain("N'migration:099_rent_review_policies'");
  });
});

describe("the three policies", () => {
  const rows = seedRows(raw);

  it("are E1, E2 and E3, and nothing else", () => {
    expect([...rows.keys()]).toEqual([...KEYS]);
  });

  it("match PLAN §3.4: two attention ladders to the director, one authority ladder through the CFO", () => {
    const ladder = (key: string) => parseLadder(rows.get(key)?.[4] ?? "");
    expect(rows.get("rent_review.not_commenced")?.[0]).toBe("attention");
    expect(ladder("rent_review.not_commenced")).toEqual([{ role: "accounts_manager", slaHours: 40 }, { role: "director", slaHours: 40 }]);
    expect(rows.get("rent_review.overdue")?.[0]).toBe("attention");
    expect(ladder("rent_review.overdue")).toEqual([{ role: "accounts_manager", slaHours: 16 }, { role: "director", slaHours: 40 }]);
    expect(rows.get("rent_review.approval")?.[0]).toBe("authority");
    expect(ladder("rent_review.approval")).toEqual([{ role: "accounts_manager", slaHours: 16 }, { role: "cfo", slaHours: 16 }, { role: "director" }]);
    for (const key of KEYS) expect(rows.get(key)?.slice(1, 4)).toEqual(["0", "business", "yes"]);
    for (const key of KEYS) expect(rows.get(key)?.[5]).toBe("1");
  });

  it("are exactly 098's seed for the same keys, so on a database where 098 ran this inserts nothing", () => {
    const seed098 = seedRows(read("098_escalations.sql"));
    for (const key of KEYS) expect(rows.get(key)).toEqual(seed098.get(key));
  });
});
