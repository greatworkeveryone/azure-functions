// Who sees how much of the usage analytics, decided here and nowhere else (PLAN §14). The
// frontend mirrors the gates as capabilities (viewUsageAnalytics, viewFinanceUsageAnalytics)
// but this file is what holds: every analytics route asks for its scope after the role gate,
// and the Finance route applies it whatever filters the request sends.
//
//   admin, director  everything
//   cfo              the finance view only: accounts, accounts_manager, cfo and admin people,
//                    MYOB calls and finance decisions
//   anyone else      nothing (403)

import { AppRole } from "../auth";

export type UsageScope = "all" | "finance";

/** The roles whose own activity the CFO may see. */
export const FINANCE_USER_ROLES: readonly string[] = [AppRole.ACCOUNTS, AppRole.ACCOUNTS_APPROVAL, AppRole.CFO, AppRole.ADMIN];

/** The modules the Finance view reports a person's time in (module keys are the navigation's: constants/nav in the frontend). */
export const FINANCE_MODULE_KEYS: readonly string[] = ["finance", "finance/controls", "admin/myob", "payroll", "timesheets"];

/** DecisionLedger codes that are money decisions: the prefix before the dot. LIKE patterns, so a literal underscore is escaped. */
export const FINANCE_ACTION_LIKE: readonly string[] = [
  "invoice.%",
  "payment.%",
  "po.%",
  "quote.%",
  "myob.%",
  "approval[_]limit.%",
  "approval[_]fact.%",
];

export function usageScopeFor(roles: readonly string[]): UsageScope | null {
  if (roles.includes(AppRole.ADMIN) || roles.includes(AppRole.DIRECTOR)) return "all";
  if (roles.includes(AppRole.CFO)) return "finance";
  return null;
}

export const isFinanceUserRole = (role: string | null | undefined): boolean => FINANCE_USER_ROLES.includes((role ?? "").toLowerCase());
