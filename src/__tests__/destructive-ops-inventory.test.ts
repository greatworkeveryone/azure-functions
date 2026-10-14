import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// Regression guard for the cleanupAttachments bug class (removed Oct 2026).
// That timer deleted the blob of every dbo.Attachments row older than 48h on
// the assumption that every row had been pushed to myBuildings. The assumption
// held when it was written; later features (tenancy docs, claimed email
// attachments, inspection photos sharing a blob) wrote into the same table and
// the timer silently destroyed their files.
//
// These are inventory tests, not behaviour tests: adding a timer or a new
// blob-delete call site fails here until someone has answered the review
// question beside the entry and added it to the list. Same source-text style as
// no-select-star.test.ts.

const SRC = join(__dirname, "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name: string): string[] => {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) return name === "__tests__" ? [] : sourceFiles(abs);
    return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [abs] : [];
  });
}

function matchesPerFile(pattern: RegExp): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const abs of sourceFiles(SRC)) {
    const hits = [...readFileSync(abs, "utf8").matchAll(pattern)].map((m) => m[1]);
    if (hits.length > 0) found.set(relative(SRC, abs), hits);
  }
  return found;
}

// Review question for every timer: which tables does it select from, and is
// it the ONLY writer of the rows it acts on? If another feature writes to the
// same table, the timer must filter on something that feature can't produce.
const REVIEWED_TIMERS: Record<string, string> = {
  parseEmailsTimer: "parseEmails.ts — writes Emails.AI* columns only",
  parseEmailsDailyRetry: "parseEmails.ts — Graph mail sync + AI parse retry",
  tenancyCpiSyncTimer: "tenancyCpiSyncTimer.ts — CPI rows it owns",
  timesheetSyncTimer: "timesheetSyncTimer.ts — stamps Timesheets.SentToMyobDate",
  tenancyReviewScheduleTimer: "tenancyReviewScheduleTimer.ts — review schedule rows it owns",
  sqlKeepWarmTimer: "sqlKeepWarmTimer.ts — SELECT 1, no writes",
  syncAllWorkRequestsTimer: "syncAllWorkRequests.ts — MERGE into WorkRequests (local edits live in WorkRequestOverrides)",
  plannerSyncTimer: "plannerSyncTimer.ts — PlannerTasks + Graph Planner; shared with jobPlannerSync",
  renewGraphSubscription: "graphWebhook.ts — Graph subscription only",
};

// Every call that deletes a blob, by file. A blob can be referenced by more
// than one row (inspection photos copied onto jobs, email attachments claimed
// onto jobs), so a new delete site must say how it knows nothing else points
// at the blob.
const REVIEWED_BLOB_DELETES: Record<string, string[]> = {
  "blob-storage.ts": ["deleteIfExists", "deleteIfExists"],
  "functions/attachments.ts": ["deleteBlob"],
  "functions/inspections.ts": ["deleteBlob"],
  "functions/purchaseOrders.ts": ["deleteBlob"],
  "functions/vacancies.ts": ["deletePublicBlob", "deletePublicBlob", "deletePublicBlob", "deletePublicBlob"],
  "functions/buildingGallery.ts": ["deletePublicBlob", "deletePublicBlob"],
};

describe("timer inventory", () => {
  it("every app.timer registration has been reviewed for shared-table assumptions", () => {
    const registered = [...matchesPerFile(/app\.timer\(\s*"([^"]+)"/g).values()].flat().sort();
    expect(registered).toEqual(Object.keys(REVIEWED_TIMERS).sort());
  });

  it("no timer deletes blobs", () => {
    const timerFiles = [...matchesPerFile(/app\.timer\(\s*"([^"]+)"/g).keys()];
    const deleters = Object.keys(REVIEWED_BLOB_DELETES);
    expect(timerFiles.filter((f) => deleters.includes(f))).toEqual([]);
  });
});

describe("blob delete inventory", () => {
  it("every blob delete call site has been reviewed for shared blob references", () => {
    const found = Object.fromEntries(
      // Lookbehind skips the helper definitions in blob-storage.ts.
      matchesPerFile(/(?<!function )\b(deleteBlob|deletePublicBlob|deleteIfExists)\(/g),
    );
    expect(found).toEqual(REVIEWED_BLOB_DELETES);
  });
});
