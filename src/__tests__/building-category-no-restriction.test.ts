/// <reference types="jest" />
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// U8: Buildings.Category only changes how the picker groups buildings. A
// residence is a building like any other: jobs, work requests, keys,
// inspections, tenancy and assets can all be raised against one. This is a
// tripwire for the day someone filters on it in a query: the only server code
// that may read Buildings.Category is the list the picker reads and the screen
// that sets it. Anything else is a new restriction and needs a decision first.
//
// One decided exception: company/commercial reporting covers commercial
// buildings only, because residences are the family's own houses (Connor,
// 22 Oct 2026; TENANCY-SCHEDULE-REPORT decision T10). That governs what a report
// totals, never what can be raised against a residence, so it is listed here by
// file, each with its reason, and nothing operational joins it. The jobs, keys,
// inspections, maintenance and tenancy-register reads, the Next 90 days feed and the
// rent-review queue stay unfiltered.

const SRC = join(__dirname, "..");
const ALLOWED = new Set(["functions/getBuildings.ts", "functions/upsertManualBuilding.ts", "manualBuildingInput.ts"]);
const COMPANY_REPORTING_REASONS: Record<string, string> = {
  "complianceReport/load.ts": "the Compliance report's reads (spare-capacity package SC-RP2): commercial buildings only, like the Tenancy Schedule",
  "maintenanceSpend/load.ts": "the Maintenance spend report's reads (spare-capacity package SC-RP1): commercial buildings only, like the Tenancy Schedule",
  "portfolioOccupancy.ts": "the portfolio occupancy, rent, WALE and tenant figures the Overview and dashboard total",
  "scheduleChange/pending.ts": "the `commercial` scope: the pending-changes count that rides on those company figures",
  "tenancySchedule/load.ts": "the Tenancy Schedule report's reads",
};
const COMPANY_REPORTING = new Set(Object.keys(COMPANY_REPORTING_REASONS));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return entry === "__tests__" ? [] : sourceFiles(full);
    return full.endsWith(".ts") && !full.endsWith(".test.ts") ? [full] : [];
  });
}

describe("a residence is never restricted by its category", () => {
  const files = sourceFiles(SRC).map((f) => ({ path: relative(SRC, f), text: readFileSync(f, "utf8") }));

  it("only the building list and the manual-buildings upsert mention a building's Category", () => {
    const readers = files
      .filter(({ text }) => /\b(?:b|bld|building|Buildings)\.Category\b/.test(text))
      .map(({ path }) => path)
      .filter((path) => !ALLOWED.has(path) && !COMPANY_REPORTING.has(path));
    expect(readers).toEqual([]);
  });

  it("no query filters Buildings on a category value", () => {
    const filters = files
      .filter(({ path }) => !ALLOWED.has(path) && !COMPANY_REPORTING.has(path))
      .filter(({ text }) => /Buildings[^`"]{0,400}Category\s*(?:=|<>|!=|\bIN\b)\s*\(?\s*N?'(?:commercial|residence)'/i.test(text))
      .map(({ path }) => path);
    expect(filters).toEqual([]);
  });

  it("company reporting may only narrow to commercial buildings, never single out residences", () => {
    for (const path of COMPANY_REPORTING) {
      const text = files.find((file) => file.path === path)?.text ?? "";
      expect(text).toMatch(/Category = N'commercial'/);
      expect(text).not.toMatch(/Category\s*(?:=|<>|!=)\s*N?'residence'/i);
    }
  });

  it("the check can fail: it sees a category read in the building list itself", () => {
    expect(files.find(({ path }) => path === "functions/getBuildings.ts")?.text).toMatch(/\bCategory\b/);
  });
});
