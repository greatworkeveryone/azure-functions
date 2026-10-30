export type LinkStatus = "active" | "expired" | "none" | "revoked";

export interface LinkApi {
  expiresAt: string;
  issuedAt: string;
  lastUsedAt: string | null;
  linkId: number;
  revokeReason: string | null;
  revokedAt: string | null;
  status: LinkStatus;
  useCount: number;
}

export interface ContactApi {
  archivedAt: string | null;
  archivedBy: string | null;
  authorisedForCosts: boolean;
  contactId: number;
  email: string | null;
  escalation: boolean;
  /** The newest link that was ever delivered, or null when none was. */
  link: LinkApi | null;
  linkStatus: LinkStatus;
  name: string;
  phone: string | null;
  reportsIssues: boolean;
  rowVersion: string;
  tenantId: number;
}

export interface TenancyContactsApi {
  contacts: ContactApi[];
  emailOnly: boolean;
  /** The tenancy's version: send it back with the email-only toggle. */
  tenancyRowVersion: string;
  tenantId: number;
}

export interface TenancyState {
  archivedAt: Date | null;
  buildingId: number | null;
  emailOnly: boolean;
  isTest: boolean;
  legalName: string;
  rowVersion: Buffer;
  tenantId: number;
}

export interface TenantLinkIdentity {
  buildingId: number;
  contactId: number;
  tenantId: number;
}
