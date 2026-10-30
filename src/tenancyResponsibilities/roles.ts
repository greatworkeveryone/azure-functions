// Who may see and edit a tenancy's "who maintains what" list (TR7, PLAN §15).
// The frontend mirrors these through src/constants/action-roles.json (viewTenancyResponsibilities,
// editTenancyResponsibilities); requireRole's hierarchy also admits director.

import { AppRole } from "../auth";
import { VIEW_FACILITIES_ROLES } from "../facilitiesRoles";

/**
 * Read the list: every operational role, facilities included, because Facilities triages a tenant's fault with it.
 * Same people as viewTenantLinks.
 */
export const VIEW_RESPONSIBILITIES_ROLES = VIEW_FACILITIES_ROLES;

/** Add, edit, archive and restore items: the people who edit tenancy information today (the editTenancy desk). */
export const EDIT_RESPONSIBILITIES_ROLES = [AppRole.ACCOUNTS, AppRole.ACCOUNTS_APPROVAL, AppRole.ADMIN, AppRole.DIRECTOR] as const;

/** The rollout flag (dbo.FeatureFlags): hidden by default, off when unreadable. */
export const RESPONSIBILITIES_FLAG = "tenancyResponsibilities";
