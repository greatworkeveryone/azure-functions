// The role an approver must hold to approve a review now (C7, PLAN §3.4): a
// director, whatever the rung, for a rent below the current one (A3); else the
// highest rung E3 has reached since the review was last submitted, read with
// the review (store.ts APPROVAL_RUNG), so withdrawing or losing the live E3
// never lowers it (L3); an accounts manager when none was raised (or its policy
// is off). APPROVE checks it on the locked row; the review's DTO shows it as
// approval.requiredRole. Pure.

import type { SqlRow } from "../db";
import { isReduction, type RentReviewCalc } from "../rentReviewCalc";

export type ApproverRole = "accounts_manager" | "cfo" | "director";

export function requiredApprovalRoleOf(row: SqlRow, calc: RentReviewCalc | null): ApproverRole {
  if (calc && isReduction(calc)) return "director";
  const rung = row.ApprovalRung === null || row.ApprovalRung === undefined ? 0 : Number(row.ApprovalRung);
  if (rung >= 3) return "director";
  return rung === 2 ? "cfo" : "accounts_manager";
}
