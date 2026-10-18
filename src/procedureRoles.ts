// Who works on procedures (beta sprint U4). Shared by the three procedure
// handlers and the request-for-approval one; the who-can-do-what table
// (action-roles.ts) names these as the gates of editProcedures and approveProcedures.

import { AppRole } from "./auth";

/**
 * Writing a draft, and asking for it to be approved. requireRole's hierarchy
 * admits admin, director and (through accounts_manager) the CFO as well.
 * Mirrors the frontend's editProcedures capability.
 */
export const PROCEDURE_EDITOR_GATE = [AppRole.FACILITIES_APPROVAL, AppRole.ACCOUNTS_APPROVAL] as const;

/** The role a draft is sent to for approval: publishing is a director's act. */
export const PROCEDURE_APPROVER_ROLE = AppRole.DIRECTOR;
