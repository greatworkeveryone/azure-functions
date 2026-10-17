// Who may do what in the facilities lane (sprint F: defects periods, service
// schedules, the maintenance overview). Handlers pass these straight to
// requireRole, whose hierarchy also admits director through any gate that is
// not admin-only and facilities_manager wherever facilities is listed, so
// DIRECTOR is listed only to say what already happens. The frontend mirrors
// these in src/constants/roles.ts (manageDefectsPeriods, manageServiceSchedules,
// viewMaintenanceOverview).

import { AppRole } from "./auth";

/** Read defects periods, schedules and the maintenance overview: every
 *  operational role (job creators need the warnings), not the baseline user. */
export const VIEW_FACILITIES_ROLES = [
  AppRole.ADMIN,
  AppRole.DIRECTOR,
  AppRole.FACILITIES,
  AppRole.FACILITIES_APPROVAL,
  AppRole.ACCOUNTS,
  AppRole.ACCOUNTS_APPROVAL,
] as const;

/** Add, edit, archive and restore defects periods (Simone's request; managed by
 *  the facilities manager, directors and admin). */
export const MANAGE_DEFECTS_PERIODS_ROLES = [AppRole.ADMIN, AppRole.DIRECTOR, AppRole.FACILITIES_APPROVAL] as const;

/** "Book anyway": create planned maintenance inside a blocking defects period,
 *  with a reason that is ledgered. Facilities manager and above. */
export const DEFECTS_OVERRIDE_ROLES = [AppRole.ADMIN, AppRole.DIRECTOR, AppRole.FACILITIES_APPROVAL] as const;

/** Add, edit, archive, restore and import service schedules (Adam's tracker). */
export const MANAGE_SERVICE_SCHEDULES_ROLES = [AppRole.ADMIN, AppRole.DIRECTOR, AppRole.FACILITIES_APPROVAL] as const;

/** Run the scheduler by hand (with or without the dry-run flag). Admin only. */
export const RUN_SCHEDULER_ROLES = [AppRole.ADMIN] as const;
