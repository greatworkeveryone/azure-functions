// Who may do what with a decision request (jobs plan A1).
//
// Asking, withdrawing and reading follow the jobs themselves: whoever may create
// and edit jobs may ask for a decision on one, and whoever may read a job may read
// the request. The two lists mirror EDIT_JOBS_ROLES and VIEW_JOBS_ROLES in
// functions/jobs.ts (not exported from there: that file registers a dozen
// endpoints and nothing else may import it); roles.test.ts reads jobs.ts and
// fails when they differ. Change them together.
//
// Who can be ASKED is a separate list: the roles that can open the escalation
// inbox, since that is where the request lands.

import { AppRole } from "../auth";

/** Mirror of EDIT_JOBS_ROLES in functions/jobs.ts. */
export const ASK_FOR_DECISION_ROLES = [
  AppRole.ADMIN,
  AppRole.DIRECTOR,
  AppRole.FACILITIES,
  AppRole.FACILITIES_APPROVAL,
  AppRole.ACCOUNTS,
  AppRole.ACCOUNTS_APPROVAL,
] as const;

/** Mirror of VIEW_JOBS_ROLES in functions/jobs.ts. */
export const READ_DECISION_REQUEST_ROLES = [
  AppRole.ADMIN,
  AppRole.DIRECTOR,
  AppRole.FACILITIES,
  AppRole.FACILITIES_APPROVAL,
  AppRole.ACCOUNTS,
  AppRole.ACCOUNTS_APPROVAL,
] as const;

/** AppUsers.Role values a person can be asked to decide with: whoever can use the
 *  escalation inbox (escalation/http ESCALATION_ROLES). The baseline `user` role
 *  can't open it, so a request to one would never be seen. */
export const DECISION_MAKER_ROLES: readonly string[] = [
  AppRole.ACCOUNTS,
  AppRole.ACCOUNTS_APPROVAL,
  AppRole.ADMIN,
  AppRole.CFO,
  AppRole.DIRECTOR,
  AppRole.FACILITIES,
  AppRole.FACILITIES_APPROVAL,
];
