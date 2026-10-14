import { describe, expect, it } from "@jest/globals";
import type { AuthorityFacts, AuthorityInput, Identity, RoleLimit, Subject } from "../approvalAuthority";
import { approvalOutcome } from "../approvalOutcome";

// What an approve click does (J1): approve on the caller's own authority, send
// it up the ladder, send it to the director, or refuse. Admin approves test
// records only (beta sprint decision 4).

/** Production rows on 13 Oct 2026, normalised as the loader reads them ('Admin' → admin). */
const PROD_TODAY: RoleLimit[] = [
  { limit: 5000, role: "accounts" },
  { limit: 5000, role: "facilities" },
  { limit: 20000, role: "accounts_manager" },
  { limit: 20000, role: "facilities_manager" },
  { limit: null, role: "director" },
  { limit: null, role: "admin" },
  { limit: 10000, role: "timesheet_approval_accounts" },
  { limit: 10000, role: "timesheet_approval_facilities" },
];
/** The same rows after migration 121. */
const PROD_AFTER_121: RoleLimit[] = [
  { limit: 5000, role: "accounts" },
  { limit: 5000, role: "facilities" },
  { limit: 20000, role: "accounts_manager" },
  { limit: 20000, role: "facilities_manager" },
  { limit: null, role: "director" },
  { limit: 50000, role: "admin" },
  { limit: null, role: "cfo" },
];

function facts(limits: RoleLimit[], directorThreshold: number | null): AuthorityFacts {
  return { directorThreshold, isResidence: false, limits, residenceApprovers: [], residenceDirectorFallback: true, today: "2026-10-14" };
}
const BEFORE = facts(PROD_TODAY, null);
const AFTER = facts(PROD_AFTER_121, 50000);

const who = (role: string, userId = 1): Identity => ({ email: `${role}@example.com`, roles: [role], userId });
const item = (subject: Subject, amount: number): AuthorityInput => ({ amount, buildingId: 5, jobId: 9, subject });
const REAL = { isTest: false };
const TEST = { isTest: true };

describe("approvalOutcome", () => {
  it("a facilities manager approves a $4,000 quote on their own authority", () => {
    expect(approvalOutcome(who("facilities_manager"), item("quote", 4000), AFTER, REAL)).toMatchObject({ kind: "approved" });
  });

  it("accounts approves a $4,000 invoice on their own authority", () => {
    expect(approvalOutcome(who("accounts"), item("invoice", 4000), AFTER, REAL)).toMatchObject({ kind: "approved" });
  });

  it("before the threshold is set, $21,000 goes to the director (today's derived $20,000 gate)", () => {
    const outcome = approvalOutcome(who("accounts_manager"), item("quote", 21000), BEFORE, REAL);
    expect(outcome).toMatchObject({ kind: "awaiting_director" });
    expect(outcome.route.map((step) => step.role)).toEqual(["director"]);
  });

  it("with DIRECTOR_APPROVAL_THRESHOLD=50000, $45,000 waits for the CFO or a director, and the CFO approves it", () => {
    const outcome = approvalOutcome(who("accounts_manager"), item("quote", 45000), AFTER, REAL);
    expect(outcome).toMatchObject({ actorLimit: 20000, kind: "awaiting_approval" });
    expect(outcome.route.map((step) => step.role)).toEqual(["cfo", "director"]);
    expect(approvalOutcome(who("cfo"), item("quote", 45000), AFTER, REAL)).toMatchObject({ kind: "approved" });
    expect(approvalOutcome(who("cfo"), item("invoice", 45000), AFTER, REAL)).toMatchObject({ kind: "approved" });
  });

  it("above the threshold everyone, the director included, sends it to the director's own step", () => {
    for (const role of ["accounts_manager", "cfo", "director"]) {
      expect(approvalOutcome(who(role), item("quote", 50000.01), AFTER, REAL)).toMatchObject({ kind: "awaiting_director" });
    }
  });

  it.each([NaN, -1, Infinity])("an unknown amount (%p) goes to the director, never treated as $0", (amount) => {
    expect(approvalOutcome(who("accounts_manager"), item("quote", amount), AFTER, REAL)).toMatchObject({ kind: "awaiting_director" });
    expect(approvalOutcome(who("accounts"), item("invoice", amount), BEFORE, REAL)).toMatchObject({ kind: "awaiting_director" });
  });

  describe("admin (decision 4)", () => {
    it("is refused on a real record, even for $500", () => {
      expect(approvalOutcome(who("admin"), item("quote", 500), AFTER, REAL)).toEqual({
        kind: "refused",
        message: "Admin can approve test records only. Real spend is approved by a manager, the CFO or a director.",
        reason: "admin_test_records_only",
        route: expect.any(Array),
      });
    });

    it("is refused on a real record above the threshold too: it cannot even send one to the director", () => {
      expect(approvalOutcome(who("admin"), item("invoice", 60000), AFTER, REAL)).toMatchObject({ kind: "refused" });
    });

    it("approves a test record within its own row", () => {
      expect(approvalOutcome(who("admin"), item("quote", 500), AFTER, TEST)).toMatchObject({ kind: "approved" });
      expect(approvalOutcome(who("admin"), item("quote", 60000), AFTER, TEST)).toMatchObject({ kind: "awaiting_director" });
    });

    it("never borrows authority from the admin row when it also holds a real role", () => {
      const both: Identity = { roles: ["admin", "accounts"], userId: 3 };
      expect(approvalOutcome(both, item("invoice", 4000), AFTER, REAL)).toMatchObject({ kind: "approved" });
      expect(approvalOutcome(both, item("invoice", 30000), AFTER, REAL)).toMatchObject({ actorLimit: 5000, kind: "awaiting_approval" });
    });

    it("matches the role however it is written", () => {
      expect(approvalOutcome({ roles: [" Admin "] }, item("quote", 500), AFTER, REAL)).toMatchObject({ kind: "refused" });
    });
  });

  it("refuses a role with no authority over the subject, and says so", () => {
    expect(approvalOutcome(who("facilities"), item("invoice", 100), AFTER, REAL)).toMatchObject({
      kind: "refused",
      message: "Your role can't approve this invoice.",
      reason: "not_eligible",
    });
  });

  it("refuses a CFO with no limit row: no row, no authority", () => {
    const noCfo = facts(PROD_AFTER_121.filter((row) => row.role !== "cfo"), 50000);
    expect(approvalOutcome(who("cfo"), item("quote", 100), noCfo, REAL)).toMatchObject({ kind: "refused", reason: "not_eligible" });
  });

  it("refuses plain facilities on a quote until attributed approval ships", () => {
    expect(approvalOutcome(who("facilities"), item("quote", 100), AFTER, REAL)).toMatchObject({
      kind: "refused",
      reason: "attribution_required",
    });
  });

  it("refuses the creator of a purchase order", () => {
    const input: AuthorityInput = { ...item("purchase_order", 100), createdBy: { userId: 7 } };
    expect(approvalOutcome(who("facilities_manager", 7), input, AFTER, REAL)).toMatchObject({
      kind: "refused",
      message: "You raised this purchase order, so someone else has to approve it.",
      reason: "creator",
    });
  });

  it("always reports the route, so the caller can say who acts next", () => {
    const outcome = approvalOutcome(who("accounts"), item("invoice", 4000), AFTER, REAL);
    expect(outcome.route.map((step) => step.role)).toEqual(["accounts", "accounts_manager", "cfo", "director"]);
  });
});
