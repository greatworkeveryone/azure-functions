// What a tenant link is FOR (decision of 31 Oct 2026, PLAN §15). Anyone can issue a link; the purpose
// decides who may issue it, who may receive it and which parts of the tenant page it opens.
// The frontend mirrors this in src/constants/tenantLinkPurposes.ts: keep the two in sync.
//
// Only `requests` is live. A later `costs` purpose (quote approvals, on-charges, invoices) is a one-entry
// addition here and in the CHECK constraint of dbo.TenantLinks.Purpose: issued by accounts and managers,
// received by contacts who are "authorised for costs", opening a `costs` section.

import { AppRole } from "../auth";

export type LinkPurpose = "requests";
/** A part of the tenant page. Each tenant endpoint names the section it serves. */
export type PageSection = "requests";
/** The contact flag a purpose is meant for. */
export type ReceiverFlag = "reportsIssues";

export const LINK_PURPOSES: readonly LinkPurpose[] = ["requests"];
export const DEFAULT_PURPOSE: LinkPurpose = "requests";

export interface PurposePolicy {
  description: string;
  /** The staff roles that may issue, reissue and revoke a link of this purpose. */
  issuerRoles: readonly AppRole[];
  label: string;
  /** Sentence for "For: ...". */
  forText: string;
  /** Contacts with this flag act on the page; others are issued a view-only link. */
  receiverFlag: ReceiverFlag;
  sections: readonly PageSection[];
}

/** Every role a signed-in staff member holds with access to tenancies (the baseline `user` role cannot see a tenancy's contacts). */
export const ALL_STAFF_ROLES = [
  AppRole.ADMIN,
  AppRole.DIRECTOR,
  AppRole.CFO,
  AppRole.FACILITIES_APPROVAL,
  AppRole.FACILITIES,
  AppRole.ACCOUNTS_APPROVAL,
  AppRole.ACCOUNTS,
] as const;

export const PURPOSE_POLICY: Record<LinkPurpose, PurposePolicy> = {
  requests: {
    description: "The contact can report maintenance problems and follow the progress of their requests.",
    forText: "reporting and tracking maintenance requests",
    issuerRoles: ALL_STAFF_ROLES,
    label: "Report and track maintenance requests",
    receiverFlag: "reportsIssues",
    sections: ["requests"],
  },
};

export const isLinkPurpose = (value: unknown): value is LinkPurpose =>
  typeof value === "string" && Object.prototype.hasOwnProperty.call(PURPOSE_POLICY, value);

/** The union of every purpose's issuers: the route-level gate (the handler then checks the purpose itself). */
export const ANY_PURPOSE_ISSUER_ROLES: readonly AppRole[] = [...new Set(LINK_PURPOSES.flatMap((p) => PURPOSE_POLICY[p].issuerRoles))];

export function mayIssuePurpose(purpose: LinkPurpose, roles: readonly string[]): boolean {
  // requireRole's hierarchy already admits admin and director through any gate; list-membership covers the rest.
  return roles.some((r) => r === AppRole.ADMIN || r === AppRole.DIRECTOR || (PURPOSE_POLICY[purpose].issuerRoles as readonly string[]).includes(r));
}

export const purposeOpens = (purpose: string, section: PageSection): boolean =>
  isLinkPurpose(purpose) && PURPOSE_POLICY[purpose].sections.includes(section);

/** Whether this contact may act (not just view) on a link of this purpose. */
export function contactMayAct(purpose: LinkPurpose, contact: { reportsIssues: boolean }): boolean {
  return contact[PURPOSE_POLICY[purpose].receiverFlag] === true;
}
