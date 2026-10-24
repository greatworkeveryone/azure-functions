// Who may call the cover routes. Mirrors the frontend capabilities in command-centre
// src/constants/roles.ts (viewAbsenceCover, manageAbsenceCover, viewLeave): change them
// together, through action-roles.ts. These are the gates only. What a caller may do with
// a given person's work or nominations is decided in access.ts and nominate.ts.

import { AppRole } from "../auth";

/** Managers, the CFO and directors see who is away and what is waiting (director and admin pass through the hierarchy). */
export const VIEW_COVER_ROLES = [AppRole.FACILITIES_APPROVAL, AppRole.ACCOUNTS_APPROVAL, AppRole.CFO, AppRole.DIRECTOR] as const;

/** The same people move or keep items for their team. Admin passes the gate and is refused by the handler (decision 4). */
export const MANAGE_COVER_ROLES = VIEW_COVER_ROLES;

/** Any signed-in staff member: their own nominations and handback. The handler checks whose they are. */
export const OWN_COVER_ROLES = [AppRole.USER] as const;
