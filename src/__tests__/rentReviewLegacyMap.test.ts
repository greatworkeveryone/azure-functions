/// <reference types="jest" />
// The workflow writes values the legacy RentReviews CHECK constraints accept
// (migration 037 stays as it is until the contract step, migration 111). The
// accepted lists are read from the migration file itself, so the mapping can't
// drift from the constraint it has to satisfy.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  LEGACY_REVIEW_TYPES,
  LEGACY_STATUSES,
  legacyReviewType,
  legacyStatus,
} from "../rentReview/legacyMap";
import { RENT_REVIEW_STATES, type RentReviewMethod } from "../rentReviewMachine";

const MIGRATION_037 = readFileSync(join(__dirname, "..", "..", "migrations", "037_tenancy_register.sql"), "utf8");

function checkList(constraint: string): string[] {
  const match = MIGRATION_037.match(new RegExp(`CONSTRAINT ${constraint}\\s+CHECK \\(\\w+ IN \\(([^)]*)\\)\\)`));
  if (!match) throw new Error(`${constraint} not found in migration 037`);
  return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

const METHODS: RentReviewMethod[] = ["cpi", "fixed", "market", "other"];

describe("legacy RentReviews values", () => {
  it("lists exactly what CK_RentReviews_ReviewType and CK_RentReviews_Status accept", () => {
    expect([...LEGACY_REVIEW_TYPES].sort()).toEqual(checkList("CK_RentReviews_ReviewType").sort());
    expect([...LEGACY_STATUSES].sort()).toEqual(checkList("CK_RentReviews_Status").sort());
  });

  it("maps every method to a ReviewType the legacy check accepts", () => {
    const accepted = checkList("CK_RentReviews_ReviewType");
    for (const method of METHODS) expect(accepted).toContain(legacyReviewType(method));
  });

  it("maps cpi -> cpi, fixed -> fixedPercent, market -> marketReview, other -> none", () => {
    expect(legacyReviewType("cpi")).toBe("cpi");
    expect(legacyReviewType("fixed")).toBe("fixedPercent");
    expect(legacyReviewType("market")).toBe("marketReview");
    expect(legacyReviewType("other")).toBe("none");
  });

  it("maps every state to a Status the legacy check accepts, and never writes 'overdue'", () => {
    const accepted = checkList("CK_RentReviews_Status");
    for (const state of RENT_REVIEW_STATES) {
      expect(accepted).toContain(legacyStatus(state));
      expect(legacyStatus(state)).not.toBe("overdue");
    }
  });

  it("maps scheduled -> upcoming; due, in_progress, awaiting_index, referred and awaiting_approval -> due", () => {
    expect(legacyStatus("scheduled")).toBe("upcoming");
    for (const state of ["due", "in_progress", "awaiting_index", "referred", "awaiting_approval"] as const) {
      expect(legacyStatus(state)).toBe("due");
    }
  });

  it("maps approved and completed -> completed; waived and cancelled -> skipped", () => {
    expect(legacyStatus("approved")).toBe("completed");
    expect(legacyStatus("completed")).toBe("completed");
    expect(legacyStatus("waived")).toBe("skipped");
    expect(legacyStatus("cancelled")).toBe("skipped");
  });
});
