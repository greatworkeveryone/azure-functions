import { defaultLeaseAdministration } from "./leaseAdministrationLogic";

// What makes a tenancy more than an empty draft (D11 re-check S1-2; database-safety
// rule 1). "Delete empty draft" removes the Tenants row for good, so it is allowed
// only when a positive rule passes: every column a person can fill in is empty and
// no table refers to the tenancy. The first check counted the rent schedule and
// the areas and notes, and missed the lease clauses, the lease administration,
// the miscellaneous fees and the incentives: a tenancy with clauses and no areas
// was offered "delete" and lost them.
//
// This file is the one list. A column that is not named here is content unless
// it has something in it that is plainly empty, so a column added later makes
// deletes refuse (safe) until it is classified, and a guard test
// (src/__tests__/tenancyDraftColumns.test.ts) reads the migrations and fails
// until it is. The frontend keeps the same list for its own pre-check
// (command-centre src/helpers/tenancyDraftContent.ts).

export type ContentKind = "date" | "flag" | "json" | "leaseAdministration" | "number" | "reviewType" | "text";

export interface ContentColumn {
  column: string;
  /** A list column's phrase with its count: "2 lease clause sections". */
  counted?: { many: string; one: string };
  kind: ContentKind;
  /** What a person reads in "<name> has …"; columns that share a label are named once. */
  label: string;
}

const list = (column: string, label: string, one: string, many: string): ContentColumn => ({ column, counted: { many, one }, kind: "json", label });
const json = (column: string, label: string): ContentColumn => ({ column, kind: "json", label });
const text = (column: string, label: string): ContentColumn => ({ column, kind: "text", label });
const number = (column: string, label: string): ContentColumn => ({ column, kind: "number", label });
const date = (column: string, label: string): ContentColumn => ({ column, kind: "date", label });

export const TENANCY_CONTENT_COLUMNS: readonly ContentColumn[] = [
  list("InfoSheetSections", "lease clauses", "lease clause section", "lease clause sections"),
  { column: "LeaseAdministration", kind: "leaseAdministration", label: "lease administration details" },
  list("MiscFees", "miscellaneous fees", "miscellaneous fee", "miscellaneous fees"),
  list("Incentives", "incentives", "incentive", "incentives"),
  json("ScheduledRateSteps", "a rent schedule"),
  list("CarparkScheduleGroups", "car park rate groups", "car park rate group", "car park rate groups"),
  json("SecurityDepositSteps", "a security deposit schedule"),
  list("RentReliefs", "rent reliefs", "rent relief", "rent reliefs"),
  text("HoldoverTerms", "holdover terms"),
  text("Comments", "comments"),
  json("EscalationSchedule", "escalation terms"),
  number("EscalationPercent", "escalation terms"),
  text("TradingName", "company details"),
  text("Abn", "company details"),
  text("Acn", "company details"),
  text("IdNo", "company details"),
  text("PostalAddress", "address and contact details"),
  text("StreetAddress", "address and contact details"),
  text("AccountsPhone", "address and contact details"),
  text("AccountsEmail", "address and contact details"),
  text("PrimaryContactName", "address and contact details"),
  text("PrimaryContactEmail", "address and contact details"),
  text("PrimaryContactPhone", "address and contact details"),
  date("Expiry", "lease terms"),
  number("TermMonths", "lease terms"),
  number("OptionsTotal", "lease options"),
  number("OptionsRemaining", "lease options"),
  number("OptionTermMonths", "lease options"),
  text("OptionPeriods", "lease terms"),
  number("OptionNoticeMonths", "lease terms"),
  text("RenewalLetterIssueBy", "lease terms"),
  text("BusinessTenanciesAct", "lease terms"),
  text("LeaseType", "lease terms"),
  text("Lot", "lease terms"),
  text("InformationSheetAsAt", "lease terms"),
  text("InformationSheetReference", "lease terms"),
  number("RentPerAnnum", "rent figures"),
  { column: "ReviewType", kind: "reviewType", label: "rent review settings" },
  number("ReviewIntervalMonths", "rent review settings"),
  date("LastReviewDate", "rent review settings"),
  number("LastReviewIncreasePercent", "rent review settings"),
  number("FixedReviewPercent", "rent review settings"),
  text("CpiRegion", "rent review settings"),
  number("CpiCapPercent", "rent review settings"),
  number("CpiFloorPercent", "rent review settings"),
  text("CpiReferenceQuarterRule", "rent review settings"),
  { column: "ReviewRatchet", kind: "flag", label: "rent review settings" },
  { column: "EmailOnly", kind: "flag", label: "an email-only setting" },
  text("SecurityDepositRequired", "security deposit details"),
  text("SecurityDepositMethod", "security deposit details"),
  number("SecurityDepositHeld", "security deposit details"),
];

/**
 * Columns that are not content, and why. The first group is what the New tenancy
 * form sets, so a tenancy created and not touched since is still an empty draft;
 * the whole row is written to the ledger when a draft is deleted, so these are
 * kept anyway. Sign-off is counted as its own fact (ScheduleSignedOffAt).
 */
export const TENANCY_OTHER_COLUMNS: Readonly<Record<string, string>> = {
  ArchivedAt: "stamp: an archived empty draft may still be deleted",
  ArchivedBy: "stamp",
  BuildingId: "which building: set at creation",
  Commencement: "the New tenancy form's optional commencement date",
  CreatedAt: "audit",
  CreatedById: "audit",
  CreatedByName: "audit",
  GstBasis: "how its money figures read (ex or inc GST, migration 160): a basis the New tenancy form may set, not content; kept in the ledger copy",
  InfoSheetVersion: "counter: its lease clauses are InfoSheetSections",
  IsTest: "test-data flag: set at creation",
  LegalName: "the name: set at creation",
  MyobId: "the New tenancy form's optional MYOB id",
  NextReviewDate: "worked out from Commencement when the tenancy is created, so a new draft with a commencement date has one",
  RowVersion: "write counter",
  ScheduleSignedOffAt: "counted as the sign-off fact",
  ScheduleSignedOffById: "counted as the sign-off fact",
  ScheduleSignedOffByName: "counted as the sign-off fact",
  ScheduleSignOffNote: "counted as the sign-off fact",
  ScheduleVersion: "counter: its rent schedule is ScheduledRateSteps and its history RentScheduleChangeLog",
  Status: "set at creation, current or vacated",
  TenantId: "the key",
  UpdatedAt: "audit",
  UpdatedById: "audit",
  UpdatedByName: "audit",
};

/** Every table that refers to a tenancy, as dbo.<table>. The delete's fact queries read each under a range lock. */
export const TENANCY_CHILD_TABLES = [
  "Carparks",
  "DecisionLedger",
  "DefectsPeriods",
  "Jobs",
  "Keys",
  "LeaseEvents",
  "RegisterDocuments",
  "RentReviews",
  "RentScheduleChangeLog",
  "ScheduleChangeRequests",
  "TenancyAttachments",
  "TenancyContacts",
  "TenancyResponsibilities",
  "TenantLinks",
  "TenantNotes",
  "TenantNotices",
  "TenantOccupancies",
  "TenantOccupancyHistory",
  "TenantRequestPhotos",
  "Vacancies",
] as const;

/** Nothing in it: null, blank text, an empty list or object, or one whose every part is nothing. Unreadable text is something. */
function jsonIsNothing(parsed: unknown): boolean {
  if (parsed === null || parsed === undefined) return true;
  if (typeof parsed === "string") return parsed.trim() === "";
  if (Array.isArray(parsed)) return parsed.every(jsonIsNothing);
  if (typeof parsed === "object") return Object.values(parsed).every(jsonIsNothing);
  return false;
}

function parseJson(value: string): { ok: true; parsed: unknown } | { ok: false } {
  try {
    return { ok: true, parsed: JSON.parse(value) };
  } catch {
    return { ok: false };
  }
}

/** How many entries a list column holds, or null when it is empty (0) or can't be counted. */
function entries(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = parseJson(value);
  return parsed.ok && Array.isArray(parsed.parsed) ? parsed.parsed.filter((entry) => !jsonIsNothing(entry)).length : null;
}

/** The same JSON whatever order its keys were written in, for comparing. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value).filter(([, entry]) => entry !== undefined).sort(([one], [two]) => (one < two ? -1 : 1)).map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** The lease administration with its seeded lease document's random id blanked, so two can be compared. */
function withoutDocumentIds(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const { leaseDocuments, ...rest } = value as Record<string, unknown>;
  return { ...rest, leaseDocuments: Array.isArray(leaseDocuments) ? leaseDocuments.map((doc) => (typeof doc === "object" && doc !== null ? { ...doc, id: "" } : doc)) : leaseDocuments };
}

/**
 * A new tenancy is created with a standard lease administration: the seeded "Original Lease"
 * document and the default fields (leaseAdministrationLogic.ts). That, and nothing added,
 * renamed, removed or filled in, is untouched: anything else, an unknown key included, is content.
 */
function isUntouchedLeaseAdministration(parsed: unknown): boolean {
  return stable(withoutDocumentIds(parsed)) === stable(withoutDocumentIds(defaultLeaseAdministration()));
}

/** A value with nothing in it. For anything not a plain null or blank string, being unsure counts as something. */
function isEmpty(kind: ContentKind, value: unknown): boolean {
  if (value === null || value === undefined) return true;
  switch (kind) {
    case "flag":
      return value === false;
    case "json": {
      if (typeof value !== "string") return false;
      if (value.trim() === "") return true;
      const parsed = parseJson(value);
      return parsed.ok && jsonIsNothing(parsed.parsed);
    }
    case "leaseAdministration": {
      if (typeof value !== "string") return false;
      if (value.trim() === "") return true;
      const parsed = parseJson(value);
      return parsed.ok && (jsonIsNothing(parsed.parsed) || isUntouchedLeaseAdministration(parsed.parsed));
    }
    case "reviewType":
      return typeof value === "string" && ["", "none"].includes(value.trim().toLowerCase());
    case "text":
      return typeof value === "string" && value.trim() === "";
    default:
      return false;
  }
}

/** An unclassified column: false is a default; text that is blank or an empty list or object is nothing; anything else is something. */
function unknownIsEmpty(value: unknown): boolean {
  return value === false || isEmpty(typeof value === "string" ? "json" : "number", value);
}

const counted = (n: number, spec: { many: string; one: string }) => `${n} ${n === 1 ? spec.one : spec.many}`;
const isKnown = (column: string) => column in TENANCY_OTHER_COLUMNS || TENANCY_CONTENT_COLUMNS.some((entry) => entry.column === column);

/**
 * What the tenancy row holds, as phrases for "<name> has …", in the list's order
 * with each label once; empty when nothing a person could have entered is there.
 * A column on the row that this file has never heard of, with something in it,
 * is "other details".
 */
export function draftContents(row: Record<string, unknown>): string[] {
  const phrases: string[] = [];
  const add = (phrase: string) => {
    if (!phrases.includes(phrase)) phrases.push(phrase);
  };
  for (const entry of TENANCY_CONTENT_COLUMNS) {
    const value = row[entry.column];
    if (isEmpty(entry.kind, value)) continue;
    const count = entry.counted ? entries(value) : null;
    add(entry.counted && count !== null && count > 0 ? counted(count, entry.counted) : entry.label);
  }
  for (const [column, value] of Object.entries(row)) {
    if (!isKnown(column) && !unknownIsEmpty(value)) add("other details");
  }
  return phrases;
}

/** The row as the ledger keeps it: JSON-safe (dates as ISO text, the row version as hex), every column present. */
export function tenancyRowForLedger(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([column, value]) => [
      column,
      value instanceof Date ? value.toISOString() : Buffer.isBuffer(value) ? value.toString("hex") : value,
    ]),
  );
}
