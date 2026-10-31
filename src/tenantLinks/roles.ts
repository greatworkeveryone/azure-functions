// Who may see and manage tenancy contacts and personal links (TR2, PLAN §15, Q-T2).
// The frontend mirrors these through src/constants/action-roles.json (viewTenantLinks,
// manageTenantLinks, issueTenantLinks); requireRole's hierarchy also admits director and admin.
//
// Decision of 31 Oct 2026: anyone can issue a link; WHAT THE LINK IS FOR decides who. Issue, reissue and
// revoke are therefore gated per purpose (purposes.ts); the route gate below is the union of every purpose's
// issuers and the handler checks the purpose itself. Contact add/edit/archive and the email-only switch keep
// the manager gate.

import { AppRole } from "../auth";
import { VIEW_FACILITIES_ROLES } from "../facilitiesRoles";
import { ANY_PURPOSE_ISSUER_ROLES } from "./purposes";

/** Read a tenancy's contacts and the status of their links. */
export const VIEW_TENANT_LINKS_ROLES = VIEW_FACILITIES_ROLES;

/** Add, edit and archive contacts, set email only. */
export const MANAGE_TENANT_LINKS_ROLES = [AppRole.ADMIN, AppRole.DIRECTOR, AppRole.FACILITIES_APPROVAL] as const;

/** Issue, reissue and revoke links: the route gate (the union over purposes; see purposes.ts for each purpose). */
export const ISSUE_TENANT_LINKS_ROLES = ANY_PURPOSE_ISSUER_ROLES;

/** The rollout flag (dbo.FeatureFlags): hidden by default, off when unreadable. */
export const TENANT_LINKS_FLAG = "tenantLinks";
