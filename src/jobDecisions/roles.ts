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
import { FLAG_ROLES } from "../jobTransitionGuard";

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

/** Everyone who can open the escalation inbox (escalation/http ESCALATION_ROLES), where
 *  a request or a next step lands. The baseline `user` role can't open it, so
 *  something put to one would never be seen. */
const INBOX_ROLES: readonly AppRole[] = [
  AppRole.ACCOUNTS,
  AppRole.ACCOUNTS_APPROVAL,
  AppRole.ADMIN,
  AppRole.CFO,
  AppRole.DIRECTOR,
  AppRole.FACILITIES,
  AppRole.FACILITIES_APPROVAL,
];

/** AppUsers.Role values a person can be asked to decide with: whoever can use the
 *  escalation inbox, except admin. Admin is IT oversight and approves nothing real
 *  (beta sprint decision 4, D20), so a question is never put to it, by name or as a
 *  role; the Ask form already leaves it out. */
export const DECISION_MAKER_ROLES: readonly string[] = INBOX_ROLES.filter((role) => role !== AppRole.ADMIN);

/** The first half of the sentence that says so, when someone tries to ask admin. */
export const ADMIN_DOES_NOT_DECIDE = "Admin looks after Floorplan and doesn't decide on jobs";

// ── Answering, and doing what the answer hands on (jobs plan A2) ─────────────

/**
 * Who may call the endpoints that answer a decision request and mark its next step
 * done: whoever can open the inbox, since an answer is the asked person's and a step
 * lands in the escalation inbox of the person it is handed to. That is the people who
 * can be asked, and admin, who is let in so that it is refused for a reason that is
 * ledgered (standing.ts: admin answers on a test job only). This is the gate only.
 * Whether THIS person may answer THIS request is for the request to say (standing.ts:
 * the people named, or whoever holds the role now), and whether they may finish THIS
 * step is for the step to say (owner, or a manager and above).
 */
export const RESPOND_TO_DECISION_ROLES: readonly AppRole[] = INBOX_ROLES;

export const COMPLETE_NEXT_STEP_ROLES: readonly AppRole[] = RESPOND_TO_DECISION_ROLES;

/** AppUsers.Role values a next step may be handed to: those that can open the
 *  escalation inbox, where it lands, admin included. The baseline `user` role cannot,
 *  so a step handed to one would never be seen. Doing a step approves nothing, so
 *  unlike a question this is not closed to admin. */
export const NEXT_STEP_OWNER_ROLES: readonly string[] = INBOX_ROLES;

/** "A manager and above": who may mark ANY next step done, not only their own. It is
 *  FLAG_ROLES of the job guard (jobTransitionGuard.ts), the rule that already means
 *  this for jobs, so the two cannot drift. */
export const MANAGER_AND_ABOVE_ROLES: readonly string[] = FLAG_ROLES;
