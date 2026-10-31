// Who may read and edit the after-hours line. Kept apart from afterHours.ts (which pulls in the ledger and the
// database) so the who-can-do-what table (action-roles.ts) stays light. ADMIN, DIRECTOR and FACILITIES_APPROVAL
// (the facilities manager, the role that approves work).

import { AppRole } from "../auth";

export const EDIT_AFTER_HOURS_ROLES = [AppRole.ADMIN, AppRole.DIRECTOR, AppRole.FACILITIES_APPROVAL] as const;
