/// <reference types="jest" />
// WP26's smaller rules: who may do what (and the frontend mirrors), which
// review dates count as settled (a cancelled review's doesn't), and the
// outcome an applied review shows.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AppRole } from "../auth";
import { RESOLVED_REVIEW_DATES_SQL } from "../nextReviewDate";
import { toReviewDto } from "../rentReview/dto";
import {
  approverRank,
  holdsApproverRole,
  isManagerOrAbove,
  REVIEW_APPLY_ROLES,
  REVIEW_APPROVE_ROLES,
  REVIEW_CANCEL_ROLES,
  TENANCY_EDIT_ROLES,
} from "../rentReview/http";
import { legacyStatus } from "../rentReview/legacyMap";
import { reviewRow } from "./fixtures/rentReviewFakes";

const source = (file: string) => readFileSync(join(__dirname, "..", "functions", `${file}.ts`), "utf8");

describe("who may do what (PLAN WP26), each list mirrored by a frontend capability", () => {
  it("apply / submit: accounts, accounts_manager, cfo (hierarchy), director, admin — the tenancy editors", () => {
    expect(REVIEW_APPLY_ROLES).toEqual([AppRole.ACCOUNTS, AppRole.ACCOUNTS_APPROVAL, AppRole.ADMIN, AppRole.DIRECTOR]);
    expect(REVIEW_APPLY_ROLES).toEqual(TENANCY_EDIT_ROLES);
  });

  it("approve, return, waive, revert: accounts_manager, cfo, director, and never admin", () => {
    expect(REVIEW_APPROVE_ROLES).toEqual([AppRole.ACCOUNTS_APPROVAL, AppRole.CFO, AppRole.DIRECTOR]);
    expect(holdsApproverRole(["admin"])).toBe(false);
    expect(holdsApproverRole(["accounts"])).toBe(false);
    for (const role of ["accounts_manager", "cfo", "director"]) expect(holdsApproverRole([role])).toBe(true);
  });

  it("ranks the approval ladder accounts_manager < cfo < director", () => {
    expect(approverRank(["accounts_manager"])).toBeLessThan(approverRank(["cfo"]));
    expect(approverRank(["cfo"])).toBeLessThan(approverRank(["director"]));
    expect(approverRank(["admin", "accounts"])).toBe(0);
  });

  it("cancel: an accounts manager and above, admin included, as isManagerOrAbove", () => {
    expect(REVIEW_CANCEL_ROLES).toEqual([AppRole.ACCOUNTS_APPROVAL, AppRole.ADMIN, AppRole.DIRECTOR]);
    for (const role of ["accounts_manager", "cfo", "director", "admin"]) expect(isManagerOrAbove([role])).toBe(true);
    expect(isManagerOrAbove(["accounts"])).toBe(false);
  });

  it.each([
    ["calculateRentReview", "TENANCY_EDIT_ROLES", /Gate: the roles that may edit a tenancy/],
    ["submitRentReview", "REVIEW_APPLY_ROLES", /REVIEW_APPLY_ROLES/],
    ["approveRentReview", "REVIEW_APPROVE_ROLES", /REVIEW_APPROVE_ROLES/],
    ["returnRentReview", "REVIEW_APPROVE_ROLES", /REVIEW_APPROVE_ROLES/],
    ["waiveRentReview", "REVIEW_APPROVE_ROLES", /REVIEW_APPROVE_ROLES/],
    ["revertRentReview", "REVIEW_APPROVE_ROLES", /REVIEW_APPROVE_ROLES/],
    ["cancelRentReview", "REVIEW_CANCEL_ROLES", /REVIEW_CANCEL_ROLES/],
  ])("%s gates on %s and says so in its header", (file, list, comment) => {
    const text = source(file);
    expect(text).toContain(`requireRole(request, ${list})`);
    expect(text.slice(0, text.indexOf("import "))).toMatch(comment);
  });

  it("the approvers' handlers also refuse admin, whom requireRole lets through", () => {
    for (const file of ["approveRentReview", "returnRentReview", "waiveRentReview", "revertRentReview"]) {
      expect(source(file)).toMatch(/holdsApproverRole|approverRank/);
    }
  });
});

describe("which review dates are settled (RESOLVED_REVIEW_DATES_SQL)", () => {
  const sql = RESOLVED_REVIEW_DATES_SQL.replace(/\s+/g, " ");

  it("a workflow review settles its date once approved, completed or waived; a cancelled one never does", () => {
    expect(sql).toContain("rr.State IN ('approved', 'completed', 'waived')");
    expect(sql).not.toMatch(/State IN \([^)]*cancelled/);
  });

  it("a review from before the workflow still settles by its legacy status", () => {
    expect(sql).toContain("(rr.State IS NULL AND rr.Status IN ('completed', 'skipped', 'waived'))");
  });

  it("which matters because a cancelled workflow review still carries the legacy 'skipped'", () => {
    expect(legacyStatus("cancelled")).toBe("skipped");
    expect(legacyStatus("waived")).toBe("skipped");
  });
});

describe("the review's outcome", () => {
  it("shows what an applied review did, with the arrears to the day it was applied (Darwin), unbilled", () => {
    const dto = toReviewDto(
      reviewRow({
        ApprovedAt: new Date("2026-08-14T23:30:00Z"), // 15 Aug in Darwin
        IncreasePercent: 3.2,
        NewRentPerAnnum: 127670.1,
        OldRentPerAnnum: 123711.34,
        ScheduledFor: new Date("2026-07-01T00:00:00Z"),
        State: "approved",
      }),
      "2026-08-20",
    );
    expect(dto.outcome).toEqual({
      appliedPercent: 3.2,
      arrears: {
        amount: Math.round(((127670.1 - 123711.34) * 45) / 365 * 100) / 100,
        billed: false,
        from: "2026-07-01",
        lines: [{ amount: Math.round(((127670.1 - 123711.34) * 45) / 365 * 100) / 100, kind: "rent", label: "Rent" }],
        months: 1.48,
        to: "2026-08-15",
      },
      newAnnual: 127670.1,
      oldAnnual: 123711.34,
    });
  });

  it("marks the arrears billed once billing is confirmed", () => {
    const dto = toReviewDto(
      reviewRow({
        ApprovedAt: new Date("2026-08-15T01:00:00Z"),
        BillingConfirmedAt: new Date("2026-09-01T01:00:00Z"),
        IncreasePercent: 3.2,
        NewRentPerAnnum: 127670.1,
        OldRentPerAnnum: 123711.34,
        ScheduledFor: new Date("2026-07-01T00:00:00Z"),
        State: "completed",
      }),
      "2026-09-20",
    );
    expect(dto.outcome?.arrears?.billed).toBe(true);
  });

  it("is null for a review that hasn't been applied", () => {
    expect(toReviewDto(reviewRow({ NewRentPerAnnum: 1, OldRentPerAnnum: 1, State: "in_progress" }), "2026-08-20").outcome).toBeNull();
    expect(toReviewDto(reviewRow({ State: "approved" }), "2026-08-20").outcome).toBeNull();
  });

  it("reads the calc as the receipt, and nothing that isn't one", () => {
    const calc = { appliedPercent: 3, cascade: [], currentAnnual: 100, method: "cpi", newAnnual: 103, scheduleVersion: 1 };
    expect(toReviewDto(reviewRow({ Calc: JSON.stringify(calc) }), "2026-08-20").calc).toEqual(calc);
    expect(toReviewDto(reviewRow({ Calc: JSON.stringify({ capPercent: 5 }) }), "2026-08-20").calc).toBeNull();
  });
});
