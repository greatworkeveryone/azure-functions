/// <reference types="jest" />
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// WP20 moved the WP18a stalled-job evaluator out of plannerSyncTimer into the
// escalation sweep (src/escalation). Two things must stay true: the Planner
// timer no longer escalates, and escalation no longer depends on anything the
// Planner timer needs (PLANNER_* group, plan and bucket ids), which is what
// stopped the old evaluator running at all when they were unset.

const ROOT = join(__dirname, "..", "..");
const read = (path: string): string => readFileSync(join(ROOT, path), "utf8");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [full] : [];
  });
}

describe("plannerSyncTimer no longer escalates", () => {
  const source = read("src/functions/plannerSyncTimer.ts");

  it("has no evaluator, no escalation email and no EscalatedAt stamping", () => {
    expect(source).not.toMatch(/Escalation evaluator/);
    expect(source).not.toMatch(/EscalatedAt/);
    expect(source).not.toMatch(/graphSendMail/);
    expect(source).not.toMatch(/FACILITIES_MANAGER_EMAILS|getFacilitiesManagerEmails|escalationThresholdDays/);
    expect(source).not.toMatch(/buildJobUrl/);
  });

  it("still runs its own Planner work", () => {
    expect(source).toMatch(/app\.timer\("plannerSyncTimer"/);
    expect(source).toMatch(/PLANNER_FACILITIES_GROUP_ID/);
  });

  it("points at the sweep", () => {
    expect(source).toMatch(/escalationSweepTimer/);
  });
});

describe("the escalation sweep is independent of the Planner timer's settings", () => {
  const files = sourceFiles(join(ROOT, "src", "escalation")).concat(join(ROOT, "src", "functions", "escalationSweepTimer.ts"));

  it.each(files.map((f) => relative(ROOT, f)))("%s reads no PLANNER_* setting and imports nothing from the Planner modules", (file) => {
    const text = readFileSync(join(ROOT, file), "utf8");
    expect(text).not.toMatch(/PLANNER_[A-Z_]+/);
    expect(text).not.toMatch(/from "\.\.\/(\.\.\/)?(planner|jobPlannerSync)"/);
    expect(text).not.toMatch(/from "\.\/(planner|jobPlannerSync)"/);
  });

  it("registers its own timer, every 30 minutes", () => {
    const text = read("src/functions/escalationSweepTimer.ts");
    expect(text).toMatch(/app\.timer\("escalationSweepTimer", \{\s*schedule: "0 \*\/30 \* \* \* \*"/);
  });
});
