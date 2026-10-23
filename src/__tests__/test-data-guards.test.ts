import { readFileSync } from "node:fs";
import { join } from "node:path";

// D9 guard: test records stay out of every list, count, figure and export
// unless an admin has Show test data on. Each allowlisted read must carry the
// toggle predicate (and its handler must pass @ShowTest), or — for timers and
// emails that no one can toggle — the hard predicate. A new list query joins
// this table when it is written.

const SRC = join(__dirname, "..");
const TOGGLE = /IsTest = 0\)*\s*OR @ShowTest = 1/;
// Positive only (database-safety rule 2): `NOT EXISTS (… IsTest = 1)` and
// `NOT IN (… IsTest = 1)` let through whatever the subquery misses.
const HARD = /\bIsTest = 0\b/;
const NEGATIVE = /NOT\s+(?:EXISTS|IN)\s*\([^)]*IsTest = 1/;

type Read = { anchor: string; file: string; mode: "hard" | "toggle"; passes?: string; passesIn?: string };

const READS: Read[] = [
  // Lists, counts and figures people see: the admin toggle can show test records.
  { anchor: "async function getJobs(", file: "functions/jobs.ts", mode: "toggle" },
  // The job by id, which J6 opens Done and archived jobs from links with (J6b).
  { anchor: "async function getJob(", file: "functions/jobs.ts", mode: "toggle" },
  { anchor: "const REGISTER_SQL =", file: "functions/tenancy.ts", mode: "toggle", passes: "async function getRegisterTenants(" },
  { anchor: "const REGISTER_WITH_ARCHIVED_SQL =", file: "functions/tenancy.ts", mode: "toggle", passes: "async function getRegisterTenants(" },
  { anchor: "async function getReviewsDue(", file: "functions/tenancy.ts", mode: "toggle" },
  { anchor: "const FIGURES_HEAD =", file: "portfolioOccupancy.ts", mode: "toggle", passes: "async function getPortfolioOccupancy(", passesIn: "functions/tenancy.ts" },
  { anchor: "async function getTenants(", file: "functions/tenants.ts", mode: "toggle" },
  { anchor: "async function getInspections(", file: "functions/inspections.ts", mode: "toggle" },
  { anchor: "async function getKeys(", file: "functions/keys.ts", mode: "toggle" },
  { anchor: "async function handleGetVacancies(", file: "functions/vacancies.ts", mode: "toggle" },
  { anchor: "async function getEmails(", file: "functions/emails.ts", mode: "toggle" },
  { anchor: "const TENANTS_SQL =", file: "functions/search.ts", mode: "toggle", passes: "async function search(" },
  { anchor: "const JOBS_SQL =", file: "functions/search.ts", mode: "toggle", passes: "async function search(" },
  { anchor: "const KEYS_SQL =", file: "functions/search.ts", mode: "toggle", passes: "async function search(" },
  { anchor: "export async function loadReviews(", file: "rentReview/store.ts", mode: "toggle", passes: "async function getRentReviews(", passesIn: "functions/getRentReviews.ts" },
  { anchor: "async function getQuotes(", file: "functions/quotes.ts", mode: "toggle" },
  { anchor: "const LINKED_JOBS =", file: "functions/getMaintenanceOverview.ts", mode: "toggle", passes: "async function getMaintenanceOverview(" },
  { anchor: "const NOT_TEST_SCOPE =", file: "functions/getDecisions.ts", mode: "toggle", passes: "async function getDecisions(" },
  // The inbox and its top-bar count (one where clause), and the Next 90 days feed with its pending changes (D9 review).
  { anchor: "const NOT_TEST_SUBJECT_SQL =", file: "escalation/store.ts", mode: "toggle", passes: "async function getEscalations(", passesIn: "functions/getEscalations.ts" },
  { anchor: "const TENANCIES_SQL =", file: "functions/getUpcomingLeaseEvents.ts", mode: "toggle", passes: "async function getUpcomingLeaseEvents(" },
  { anchor: "const REVIEWS_SQL =", file: "functions/getUpcomingLeaseEvents.ts", mode: "toggle", passes: "async function getUpcomingLeaseEvents(" },
  { anchor: "function scopeSql(", file: "scheduleChange/pending.ts", mode: "toggle", passes: "async function getUpcomingLeaseEvents(", passesIn: "functions/getUpcomingLeaseEvents.ts" },
  // (Purchase orders and payments are listed only per job, so the job is what is shown or not.)
  // Reads nobody can toggle: timers and emails.
  { anchor: "export async function listWaitingApprovals(", file: "digest/store.ts", mode: "hard" },
  { anchor: "export async function listDueJobs(", file: "digest/store.ts", mode: "hard" },
  { anchor: "export async function listOverdueKeys(", file: "digest/store.ts", mode: "hard" },
  { anchor: "export async function loadDailyFacts(", file: "myob/daily/store.ts", mode: "hard" },
];

function regionOf(source: string, anchor: string): string {
  const start = source.indexOf(anchor);
  if (start === -1) return "";
  if (anchor.startsWith("const ")) {
    const open = source.indexOf("`", start);
    return source.slice(start, source.indexOf("`", open + 1) + 1);
  }
  const end = source.indexOf("\n}\n", start);
  return source.slice(start, end === -1 ? undefined : end);
}

describe("test records stay out of lists, counts, figures and exports (D9)", () => {
  it.each(READS)("$file $anchor", ({ anchor, file, mode, passes, passesIn }) => {
    const source = readFileSync(join(SRC, file), "utf8");
    const region = regionOf(source, anchor);
    expect(region).not.toBe("");
    expect(region).toMatch(mode === "toggle" ? TOGGLE : HARD);
    expect(region).not.toMatch(NEGATIVE);
    if (mode === "toggle") {
      const handlerSource = passesIn ? readFileSync(join(SRC, passesIn), "utf8") : source;
      const handler = passes ? regionOf(handlerSource, passes) : region;
      expect(handler).toMatch(/showTestParam\(request\)/);
    }
  });
});
