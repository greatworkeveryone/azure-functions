// The broadcast audience (EB2): what a request may select, what the loaders read and what the resolver returns.

import type { RecipientType } from "../compose";

export const CONTACT_KINDS = ["primary", "accounts"] as const;
export type ContactKind = (typeof CONTACT_KINDS)[number];
export const BUILDING_CATEGORIES = ["commercial", "residence"] as const;
export type BuildingCategory = (typeof BUILDING_CATEGORIES)[number];

export interface BuildingSelection {
  buildingId: number;
  /** Empty means the whole building. */
  levels: string[];
}

export interface AudienceRequest {
  contractors: { buildingIds: number[]; trades: string[] } | null;
  staff: { roles: string[] } | null;
  tenancies: { categories: BuildingCategory[]; contacts: ContactKind[]; selections: BuildingSelection[] } | null;
  /** Raw typed addresses: each is checked, and one that fails is listed as left out. */
  typed: string[];
}

export interface TenancyRow {
  accountsEmail: string | null;
  buildingAddress: string | null;
  buildingCategory: BuildingCategory;
  buildingId: number;
  buildingName: string | null;
  commencement: string | null;
  expiry: string | null;
  isTest: boolean;
  legalName: string;
  nextReviewDate: string | null;
  primaryContactEmail: string | null;
  primaryContactName: string | null;
  tenantId: number;
}

export interface OccupancyRow {
  area: string;
  buildingId: number;
  level: string;
  tenantId: number;
}

export interface ContractorRow {
  contactName: string | null;
  contractorId: number;
  email: string | null;
  name: string;
}

export interface StaffRow {
  email: string;
  name: string;
  role: string;
  userId: number;
}

export interface Candidate {
  address: string;
  /** Who this is, for the list: the tenancy, contractor or person, and what they are to it. */
  description: string;
  mergeValues: Record<string, string>;
  name: string | null;
  recipientRefId: string | null;
  recipientType: RecipientType;
}

export interface AudienceRecipient extends Candidate {
  /** Every kind of selection that reached this address (the first is the record kept). */
  sources: RecipientType[];
}

export type ExclusionReason = "invalid_address" | "no_address" | "test_record";

export interface Exclusion {
  address: string | null;
  description: string;
  reason: ExclusionReason;
  source: RecipientType;
}

export interface ResolvedAudience {
  counts: { contractor: number; duplicatesMerged: number; manual: number; staff: number; tenancy: number; total: number };
  excluded: Exclusion[];
  recipients: AudienceRecipient[];
}
