// Who may see and manage tenancy contacts and personal links (TR2, PLAN §15, Q-T2).
// The frontend mirrors these through src/constants/action-roles.json (viewTenantLinks,
// manageTenantLinks); requireRole's hierarchy also admits director and admin.

import { AppRole } from "../auth";
import { VIEW_FACILITIES_ROLES } from "../facilitiesRoles";

/** Read a tenancy's contacts and the status of their links. */
export const VIEW_TENANT_LINKS_ROLES = VIEW_FACILITIES_ROLES;

/** Add, edit and archive contacts, set email only, issue, reissue and revoke links. */
export const MANAGE_TENANT_LINKS_ROLES = [AppRole.ADMIN, AppRole.DIRECTOR, AppRole.FACILITIES_APPROVAL] as const;

/** The rollout flag (dbo.FeatureFlags): hidden by default, off when unreadable. */
export const TENANT_LINKS_FLAG = "tenantLinks";
