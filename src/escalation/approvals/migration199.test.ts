import { readFileSync } from "node:fs";
import { join } from "node:path";
import { APPROVAL_POLICIES } from "./policies";

const sql = readFileSync(join(__dirname, "../../../migrations/199_approval_and_chase_policies.sql"), "utf8");

describe("migration 199", () => {
  it("seeds every approval policy, each inactive, so nothing fires on deploy", () => {
    // contractor.contact_changed is a security notice seeded active by migration 198, not here.
    for (const key of Object.values(APPROVAL_POLICIES).filter((k) => k !== APPROVAL_POLICIES.contractorContact)) {
      expect(sql).toContain(`(N'${key}'`);
      // the row's last value is Active
      const block = sql.slice(sql.indexOf(`(N'${key}'`));
      const closing = block.slice(0, block.indexOf("),") > 0 ? block.indexOf("),") : block.indexOf(")\n    ) AS v"));
      expect(closing.trimEnd().endsWith(", 0")).toBe(true);
    }
  });

  it("is idempotent and never rewrites an existing policy", () => {
    expect(sql).toMatch(/WHEN NOT MATCHED BY TARGET THEN\s+INSERT/);
    expect(sql).not.toMatch(/WHEN MATCHED/i);
    expect(sql.replace(/--.*$/gm, "")).not.toMatch(/\b(DROP|DELETE|TRUNCATE|UPDATE)\b/i);
  });
});
