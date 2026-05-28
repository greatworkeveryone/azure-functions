// Lease administration helpers (m078).
//
// Stored as a single JSON object in the LeaseAdministration NVARCHAR(MAX)
// column on dbo.Tenants, following the same pattern as InfoSheetSections /
// MiscFees / Incentives. Unlike those, the whole object is replaced on each
// save (the frontend owns the per-field edit + history note), so the backend
// only needs to parse defensively and normalise to a stable shape.
//
// `otherDocuments` and `detailsEntered` are flexible lists of fields: each
// tenancy starts from a standard set of defaults (deletable) and rows can be
// added with a chosen type. Older records that stored these as fixed objects
// are migrated to the default rows on read, merging any saved values by key.

import { randomUUID } from "crypto";

export interface LeaseDocument {
  id: string;
  displayOrder: number;
  docType: string;
  executedByLessee?: string; // ISO date
  executedByLessor?: string; // ISO date
  mortgageeConsent?: string; // ISO date
  registeredWithLto?: string; // ISO date
  scannedToFile?: boolean;
  hardCopyFiled?: boolean;
}

export type LeaseFieldType = "date" | "text" | "yesno";

/** One row in the otherDocuments / detailsEntered lists. */
export interface LeaseField {
  id: string;
  label: string;
  fieldType: LeaseFieldType;
  /** ISO date | "n/a" (date) · free text (text) · "yes" | "no" (yesno). */
  value?: string;
  displayOrder: number;
}

export interface LeaseManagerRef {
  name: string;
  email: string;
}

export interface LeaseAdministration {
  leaseDocuments: LeaseDocument[];
  otherDocuments: LeaseField[];
  detailsEntered: LeaseField[];
  leaseManager: LeaseManagerRef | null;
}

const FIELD_TYPES: LeaseFieldType[] = ["date", "text", "yesno"];

// Default rows use their legacy object key as a stable id so migration from the
// old fixed-object shape (and repeated reads) is idempotent.
const DEFAULT_OTHER_DOCS: LeaseField[] = [
  { id: "carParkLicence", label: "Car Park Licence", fieldType: "date", displayOrder: 0 },
  { id: "roofTopLicence", label: "Roof-top licence", fieldType: "date", displayOrder: 1 },
  { id: "signageLicence", label: "Signage licence", fieldType: "date", displayOrder: 2 },
  { id: "otherLicences", label: "Other licences", fieldType: "date", displayOrder: 3 },
  { id: "certOfOccupancy", label: "Cert of Occupancy", fieldType: "date", displayOrder: 4 },
  { id: "cocInsurance", label: "CoC Insurance", fieldType: "date", displayOrder: 5 },
];

const DEFAULT_DETAILS: LeaseField[] = [
  { id: "myobCard", label: "MYOB card", fieldType: "date", displayOrder: 0 },
  { id: "tenancySch", label: "Tenancy Sch", fieldType: "date", displayOrder: 1 },
  { id: "checked", label: "Checked", fieldType: "date", displayOrder: 2 },
  { id: "checkedBy", label: "Checked by", fieldType: "text", displayOrder: 3 },
];

function defaultFields(defaults: LeaseField[]): LeaseField[] {
  return defaults.map((field) => ({ ...field }));
}

/** Coerce a stored field list (new array, legacy object, or missing). */
function normaliseFieldList(value: unknown, defaults: LeaseField[]): LeaseField[] {
  if (Array.isArray(value)) {
    return value
      .filter(
        (row): row is Record<string, unknown> =>
          !!row && typeof row === "object" && typeof (row as any).id === "string",
      )
      .map((row, index) => ({
        id: String(row.id),
        label: typeof row.label === "string" ? row.label : "",
        fieldType: FIELD_TYPES.includes(row.fieldType as LeaseFieldType)
          ? (row.fieldType as LeaseFieldType)
          : "date",
        value: typeof row.value === "string" ? row.value : undefined,
        displayOrder: typeof row.displayOrder === "number" ? row.displayOrder : index,
      }));
  }
  if (value && typeof value === "object") {
    // Legacy fixed-object shape — seed defaults, merging values by key.
    const obj = value as Record<string, unknown>;
    return defaults.map((field) => ({
      ...field,
      value: typeof obj[field.id] === "string" ? (obj[field.id] as string) : undefined,
    }));
  }
  return defaultFields(defaults);
}

/** Parse the stored JSON, tolerating null / malformed / partial objects. */
export function parseLeaseAdministration(
  json: string | null | undefined,
): LeaseAdministration {
  if (!json) {
    return {
      leaseDocuments: [],
      otherDocuments: defaultFields(DEFAULT_OTHER_DOCS),
      detailsEntered: defaultFields(DEFAULT_DETAILS),
      leaseManager: null,
    };
  }
  try {
    return normaliseLeaseAdministration(JSON.parse(json));
  } catch {
    return {
      leaseDocuments: [],
      otherDocuments: defaultFields(DEFAULT_OTHER_DOCS),
      detailsEntered: defaultFields(DEFAULT_DETAILS),
      leaseManager: null,
    };
  }
}

/** Coerce an arbitrary value into a well-formed LeaseAdministration object. */
export function normaliseLeaseAdministration(value: unknown): LeaseAdministration {
  if (!value || typeof value !== "object") {
    return {
      leaseDocuments: [],
      otherDocuments: defaultFields(DEFAULT_OTHER_DOCS),
      detailsEntered: defaultFields(DEFAULT_DETAILS),
      leaseManager: null,
    };
  }
  const obj = value as Record<string, unknown>;
  const leaseDocuments = Array.isArray(obj.leaseDocuments)
    ? (obj.leaseDocuments as LeaseDocument[])
    : [];
  const lm = obj.leaseManager as Record<string, unknown> | null | undefined;
  const leaseManager =
    lm && typeof lm === "object" && typeof lm.email === "string"
      ? { name: String(lm.name ?? ""), email: String(lm.email) }
      : null;
  return {
    leaseDocuments,
    otherDocuments: normaliseFieldList(obj.otherDocuments, DEFAULT_OTHER_DOCS),
    detailsEntered: normaliseFieldList(obj.detailsEntered, DEFAULT_DETAILS),
    leaseManager,
  };
}

/**
 * Seed every new tenancy with a starter scaffold: one lease document plus the
 * standard other-documents and details-entered fields. Fully editable — rows
 * can be renamed, added, or deleted afterwards.
 */
export function defaultLeaseAdministration(): LeaseAdministration {
  return {
    leaseDocuments: [
      { id: randomUUID(), displayOrder: 0, docType: "Original Lease" },
    ],
    otherDocuments: defaultFields(DEFAULT_OTHER_DOCS),
    detailsEntered: defaultFields(DEFAULT_DETAILS),
    leaseManager: null,
  };
}
