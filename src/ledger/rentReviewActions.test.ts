/// <reference types="jest" />
// The WP25 and WP26 blocks of the action registry: what a rent review decision may record.
import { AppRole } from "../auth";
import { TENANCY_VIEW_ROLES } from "../rentReview/http";
import { assertLedgerEntry, LEDGER_ACTIONS, LedgerValidationError, type LedgerEntryInput } from "./index";
import { historyReadRoles } from "./historyRoles";

const WP25_CODES = ["rent_review.basis_update", "rent_review.commence", "rent_review.open_window", "rent_review.schedule"] as const;
const WP26_CODES = [
  "rent_review.apply",
  "rent_review.approve",
  "rent_review.basis_departure",
  "rent_review.calculate",
  "rent_review.cancel",
  "rent_review.director_override",
  "rent_review.index_available",
  "rent_review.index_pending",
  "rent_review.override",
  "rent_review.return",
  "rent_review.revert",
  "rent_review.submit",
  "rent_review.waive",
] as const;

const system = { kind: "system", name: "tenancyReviewScheduleTimer" } as const;
const ann = { kind: "user", name: "Ann Accounts", role: "accounts", userId: 7 } as const;
const entry = (action: LedgerEntryInput["action"], over: Partial<LedgerEntryInput> = {}): LedgerEntryInput => ({
  action,
  actor: ann,
  subject: { id: "9f0c1c9e-0a64-4a52-9a44-7bdf6c3fd5e1", type: "rent_review" },
  tenantId: 7,
  ...over,
});

describe("the rent review action codes", () => {
  it("has exactly the codes of WP25 and WP26, all about a rent_review", () => {
    const found = Object.keys(LEDGER_ACTIONS).filter((code) => code.startsWith("rent_review."));
    expect(found.sort()).toEqual([...WP25_CODES, ...WP26_CODES].sort());
    for (const code of [...WP25_CODES, ...WP26_CODES]) {
      expect(LEDGER_ACTIONS[code].subjects).toEqual(["rent_review"]);
      expect(code.length).toBeLessThanOrEqual(64);
    }
  });

  it("asks for a reason only on a basis update, which is also the one that shows as an exception", () => {
    expect(LEDGER_ACTIONS["rent_review.basis_update"]).toMatchObject({ exception: true, reasonRequired: true });
    for (const code of ["rent_review.commence", "rent_review.open_window", "rent_review.schedule"] as const) {
      expect(LEDGER_ACTIONS[code]).toMatchObject({ exception: false, reasonRequired: false });
    }
  });

  it("WP26: waive, cancel, revert and an override are exceptions that need a reason; return needs its note", () => {
    for (const code of ["rent_review.waive", "rent_review.cancel", "rent_review.revert", "rent_review.override"] as const) {
      expect(LEDGER_ACTIONS[code]).toMatchObject({ exception: true, reasonRequired: true });
      expect(() => assertLedgerEntry(entry(code))).toThrow(/reason is required/);
      expect(() => assertLedgerEntry(entry(code, { reason: "Tenant hardship, agreed by the directors" }))).not.toThrow();
    }
    expect(LEDGER_ACTIONS["rent_review.return"]).toMatchObject({ exception: false, reasonRequired: true });
    for (const code of ["rent_review.calculate", "rent_review.index_pending", "rent_review.index_available", "rent_review.submit", "rent_review.approve", "rent_review.apply"] as const) {
      expect(LEDGER_ACTIONS[code]).toMatchObject({ exception: false, reasonRequired: false });
    }
  });

  it("WP26: a basis departure is an exception without a reason of its own (the basis edits carried theirs)", () => {
    expect(LEDGER_ACTIONS["rent_review.basis_departure"]).toMatchObject({ exception: true, reasonRequired: false });
    expect(() => assertLedgerEntry(entry("rent_review.basis_departure"))).not.toThrow();
  });

  it("WP26: a director's override of a check is an exception that needs its reason", () => {
    expect(LEDGER_ACTIONS["rent_review.director_override"]).toMatchObject({ exception: true, reasonRequired: true });
    expect(() => assertLedgerEntry(entry("rent_review.director_override"))).toThrow(/reason is required/);
    expect(() => assertLedgerEntry(entry("rent_review.director_override", { reason: "Lease checked by hand" }))).not.toThrow();
  });

  it("WP26: takes the CPI timer's system actor for index_available", () => {
    expect(() => assertLedgerEntry(entry("rent_review.index_available", { actor: { kind: "system", name: "tenancyCpiSyncTimer" } }))).not.toThrow();
  });

  it("takes the generator's system actor for schedule and open_window", () => {
    expect(() => assertLedgerEntry(entry("rent_review.schedule", { actor: system }))).not.toThrow();
    expect(() => assertLedgerEntry(entry("rent_review.open_window", { actor: system }))).not.toThrow();
  });

  it("takes a person for commence", () => {
    expect(() => assertLedgerEntry(entry("rent_review.commence"))).not.toThrow();
  });

  it("refuses a basis update with no reason, or a blank one", () => {
    expect(() => assertLedgerEntry(entry("rent_review.basis_update"))).toThrow(LedgerValidationError);
    expect(() => assertLedgerEntry(entry("rent_review.basis_update", { reason: "  " }))).toThrow(/reason is required/);
    expect(() => assertLedgerEntry(entry("rent_review.basis_update", { reason: "Lease caps it at 4%" }))).not.toThrow();
  });

  it("refuses any of them about something that isn't a rent_review", () => {
    for (const code of [...WP25_CODES, ...WP26_CODES]) {
      expect(() => assertLedgerEntry(entry(code, { reason: "x", subject: { id: 7, type: "tenancy" } }))).toThrow(/does not apply to a tenancy/);
    }
  });

  it("holds a review's uuid as the subject id", () => {
    expect(() => assertLedgerEntry(entry("rent_review.commence", { subject: { id: "x".repeat(36), type: "rent_review" } }))).not.toThrow();
  });
});

describe("who may read a review's decision history", () => {
  it("is whoever may read the tenancy: accounts, accounts managers, directors and admin (cfo through the hierarchy)", () => {
    expect(historyReadRoles("rent_review")).toEqual([AppRole.ACCOUNTS, AppRole.ACCOUNTS_APPROVAL, AppRole.ADMIN, AppRole.DIRECTOR]);
    expect(historyReadRoles("rent_review")).toEqual(historyReadRoles("tenancy"));
    expect(historyReadRoles("rent_review")).toEqual([...TENANCY_VIEW_ROLES]);
  });
});
