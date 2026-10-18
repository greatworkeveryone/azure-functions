// Tenancy Register — v2 of the tenants module. The legacy /getTenants +
// /upsertTenant in `tenants.ts` stays alive for the keys/jobs flows; the
// endpoints here back the rich spreadsheet + info-sheet UI that replaces
// the old read-only tenancy schedule.
//
// Wire convention mirrors inspections: responses are camelCase JSON ready
// for the frontend (no transform layer in the client lib), payloads are
// PascalCase to match the parameterised-SQL pattern.

import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from "@azure/functions";
import { Connection, TYPES } from "tedious";
import {
  beginTransaction,
  closeConnection,
  commitTransaction,
  createRequestConnection,
  executeQuery,
  SqlParam,
  SqlRow,
} from "../db";
import {
  AppRole,
  errorResponse,
  extractToken,
  oidFromToken,
  requireRole,
  unauthorizedResponse,
} from "../auth";
import { checkRateLimit } from "../rateLimit";
import {
  getCachedTenantList,
  setCachedTenantList,
  getCachedTenantDetail,
  setCachedTenantDetail,
  invalidateTenant,
  invalidateTenantAndBuilding,
} from "../tenant-register-cache";
import {
  deleteIncentive,
  NOT_FOUND,
  parseIncentives,
  TenancyIncentive,
  upsertIncentive,
  validateDeleteEnvelope,
  validateUpsertEnvelope,
} from "../incentiveLogic";
import {
  CarparkScheduleGroup,
  closeOpenPredecessor,
  computeScheduleRows,
  deleteGroup,
  deleteMiscFee,
  deleteStep,
  diffSteps,
  MiscFee,
  normaliseLegacyEnds,
  NOT_FOUND as STEP_NOT_FOUND,
  parseGroups,
  parseMiscFees,
  parseSteps,
  resolveScheduleAnnual,
  ScheduledRateStep,
  StepDiff,
  upsertGroup,
  upsertMiscFee,
  upsertStep,
  validateDeleteFeeEnvelope,
  validateDeleteGroupEnvelope,
  validateDeleteStepEnvelope,
  validateUpsertFeeEnvelope,
  validateUpsertGroupEnvelope,
  validateUpsertStepEnvelope,
} from "../scheduledRateStepLogic";
import { daysBetweenIso, todayInDarwin } from "../darwinDate";
import { hasLeaseEventWithin } from "../tenancyLeaseEvents";
import * as ledger from "../ledger";
import { resolveLedgerActor } from "../ledger/actor";
import {
  deriveNextReviewDate,
  nextReviewInputFromRow,
  RESOLVED_REVIEW_DATES_SQL,
  sqlDateToIso,
} from "../nextReviewDate";
import {
  conflictResponse,
  isoTimestamp,
  type LedgerDraft,
  ledgerRefusal,
  parseExpectedVersion,
  rollbackQuietly,
  rowVersionHex,
  runScheduleWrite,
  scheduleWriteResponse,
  withNextReviewDate,
} from "../tenancyScheduleWrite";
import { resolveActivePlannerTasks } from "../planner";
import { CPI_REFERENCE_RULES } from "../rentReview/basis";
import { chargedOn, computeCharges, parseReliefs, type RentRelief } from "../scheduleCharges";
import { loadPendingChanges, pendingChangesOf, pendingFor, type PendingChanges } from "../scheduleChange/pending";
import { scheduleTermsOf } from "../scheduleTerms";
import { insertRentScheduleChangeLog } from "../rentScheduleChangeLog";
import { ACTION_ROLES } from "../action-roles";
import { deleteTenancyDraft, TENANCY_DELETE_ROLES } from "../tenancy-records";
import {
  CLEAR_SIGN_OFF_SQL,
  readSignOffClearReason,
  recordSignOffCleared,
  type ScheduleSignOff,
  scheduleSignOffFromRow,
  SIGN_OFF_COLUMNS,
  signOffReasonRequiredResponse,
} from "../scheduleSignOff";
import {
  deleteInfoSheetRow,
  deleteInfoSheetSection,
  InfoSheetRow as InfoSheetRowApi,
  InfoSheetSection as InfoSheetSectionApi,
  parseInfoSheetSections,
  upsertInfoSheetRow,
  upsertInfoSheetSection,
} from "../infoSheetLogic";
import {
  defaultLeaseAdministration,
  LeaseAdministration,
  normaliseLeaseAdministration,
  parseLeaseAdministration,
} from "../leaseAdministrationLogic";

// Decimal column precision/scale — tedious defaults Decimal to scale 0 and
// silently truncates fractional values, so every Decimal param must pass
// the column's precision/scale explicitly. Keys match SQL column names.
const DECIMAL_OPTS = {
  // DECIMAL(20,10) — money columns
  RentPerAnnum: { precision: 20, scale: 10 },
  SecurityDepositHeld: { precision: 20, scale: 10 },
  OldRentPerAnnum: { precision: 20, scale: 10 },
  NewRentPerAnnum: { precision: 20, scale: 10 },
  // DECIMAL(13,10) — percent columns
  CpiCapPercent: { precision: 13, scale: 10 },
  CpiFloorPercent: { precision: 13, scale: 10 },
  EscalationPercent: { precision: 13, scale: 10 },
  FixedReviewPercent: { precision: 13, scale: 10 },
  LastReviewIncreasePercent: { precision: 13, scale: 10 },
  IncreasePercent: { precision: 13, scale: 10 },
  // DECIMAL(16,10) — CPI index values
  CpiBaseValue: { precision: 16, scale: 10 },
  CpiCurrentValue: { precision: 16, scale: 10 },
  // DECIMAL(16,10) — size
  SizeSqm: { precision: 16, scale: 10 },
} as const;

// ── Caller identity (same shape as inspections.ts) ───────────────────────────

interface UserRef {
  id: string;
  name: string;
}

function buildPlannerTaskTitle(
  triggerType: string,
  leadTimeDays: number,
  displayName: string,
): string {
  switch (triggerType) {
    case "lease_expiry":
      return `Lease expiry — ${displayName} (${leadTimeDays} days)`;
    case "option_notice":
      return `Option deadline — ${displayName} (${leadTimeDays} days)`;
    case "rent_review":
      return `Rent review — ${displayName} (${leadTimeDays} days)`;
    default:
      return `Reminder — ${displayName}`;
  }
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = payload.padEnd(
      payload.length + ((4 - (payload.length % 4)) % 4),
      "=",
    );
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function callerFromToken(token: string): UserRef {
  const claims = decodeJwtPayload(token);
  const id =
    oidFromToken(token) ?? (claims?.preferred_username as string) ?? "unknown";
  const name =
    (claims?.name as string) ??
    (claims?.preferred_username as string) ??
    "Unknown user";
  return { id, name };
}

// Tedious errors carry SQL-side metadata (msg number, state, line) on top of
// .message. Surfacing all of it in logs + the API error body turns "Upsert
// register tenant failed: …" into something diagnosable from the browser.
function formatSqlError(err: any): string {
  if (!err) return "(no error)";
  const parts: string[] = [];
  if (typeof err.number === "number") parts.push(`SQL ${err.number}`);
  if (typeof err.state === "number") parts.push(`state ${err.state}`);
  if (typeof err.lineNumber === "number") parts.push(`line ${err.lineNumber}`);
  if (err.code) parts.push(String(err.code));
  const prefix = parts.length ? `[${parts.join(" · ")}] ` : "";
  return `${prefix}${err.message ?? String(err)}`;
}

// Strip undefined keys + truncate long values so logged payloads stay readable
// in the func host stream without leaking giant blobs.
function summariseBody(
  body: Record<string, any> | null | undefined,
): Record<string, any> {
  if (!body) return {};
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(body)) {
    if (v === undefined) continue;
    if (typeof v === "string" && v.length > 80) out[k] = `${v.slice(0, 77)}…`;
    else out[k] = v;
  }
  return out;
}

// ── API shapes (match src/types/tenancy.ts on the client) ────────────────────

interface SecurityDepositStep {
  effectiveFrom: string;
  monthsRequired: number;
  actualHeld: number | null;
}

interface RegisterTenantApi {
  abn?: string;
  accountsEmail?: string;
  accountsPhone?: string;
  acn?: string;
  buildingId: number;
  // BTA was per-occupancy in m037; m038 moved it to the tenant; m039 changed
  // it from boolean to free-form string (e.g. "Not Retail") since the source
  // workbook stores label values, not yes/no.
  businessTenanciesAct?: string;
  comments?: string;
  commencement?: string;
  costPerSqm: number;
  cpiCapPercent?: number;
  cpiFloorPercent?: number;
  /** M4 (m099): the lease's CPI reference-quarter rule; absent = the default, quarter_before_review_date. */
  cpiReferenceQuarterRule?: "latest_published_before_review" | "quarter_before_review_date";
  cpiRegion?: "AUS" | "DARWIN";
  createdAt: string;
  createdBy: UserRef;
  daysToExpiry?: number;
  dollarsToExpiry?: number;
  /** WP26c: the ratified reliefs in force today (a chip on the register). */
  activeReliefIds: string[];
  /** WP26c: what is charged a year today: effectiveRentPerAnnum (the lease's) less a ratified relief on the rent in force today. */
  chargedRentPerAnnum: number;
  effectiveRentPerAnnum: number;
  escalationPercent?: number;
  escalationSchedule?: string;
  expiry?: string;
  fixedReviewPercent?: number;
  idNo?: string;
  /** m052 — lease incentives (rent-free months / monthly reductions). */
  incentives: TenancyIncentive[];
  scheduledRateSteps: ScheduledRateStep[];
  carparkScheduleGroups: CarparkScheduleGroup[];
  /** m059 — miscellaneous fees (air con, cleaning, etc.). */
  miscFees: MiscFee[];
  /** m069 — info sheet general sections (header / subheader / body rows). */
  infoSheetSections: InfoSheetSectionApi[];
  /** m078 — lease document administration (execution dates, licences, etc.). */
  leaseAdministration: LeaseAdministration;
  /** WP26c: changes awaiting a director (relief requests, reviews awaiting approval),
   *  on every read; absent from a write's response, which reads the row alone. */
  pendingChanges?: PendingChanges;
  /** WP26c (m099): the ratified rent reliefs, an overlay on the schedule (scheduleCharges.ts). */
  rentReliefs: RentRelief[];
  /** Per m040 — text date like "5/1/19". */
  informationSheetAsAt?: string;
  /** Per m040 — file path/reference for the info-sheet doc. */
  informationSheetReference?: string;
  lastReviewDate?: string;
  lastReviewIncreasePercent?: number;
  legalName: string;
  monthlyRental: number;
  /** Per m040 — title/lot reference. */
  lot?: string;
  myobId?: string;
  nextReviewDate?: string;
  noteCountByAnchor: Record<string, number>;
  occupancies: TenantOccupancyApi[];
  optionNoticeMonths?: number;
  optionPeriods?: string;
  postalAddress?: string;
  primaryContactEmail?: string;
  primaryContactName?: string;
  primaryContactPhone?: string;
  holdoverTerms?: string;
  renewalLetterIssueBy?: string;
  rentPerAnnum?: number;
  /** First schedule date when the schedule hasn't started (no current rent). */
  rentStartsOn?: string;
  reviewIntervalMonths?: number;
  /** "No rent decreases on review" — the schedule holds every review at ≥ 0%. */
  reviewRatchet: boolean;
  /** REVIEW_WORKFLOW_LIVE_FROM, or null: the schedule engine's terms.workflowLiveFrom
   *  (an unsettled review row dated on or after it waits for its review, WP26c M2). */
  reviewWorkflowLiveFrom: string | null;
  reviewState: "amber" | "green" | "grey" | "red";
  /** Set when the tenancy is archived (D4): out of the register unless asked for. */
  archivedAt: string | null;
  archivedBy: string | null;
  /** Hex of Tenants.RowVersion — tenant writes send it back; a mismatch is a 409. */
  rowVersion: string;
  /** Tenants.ScheduleVersion — schedule writes send it back; a mismatch is a 409. */
  scheduleVersion: number;
  /** Who signed this tenancy's schedule off as verified, and when; null = not signed off (m097). */
  scheduleSignOff: ScheduleSignOff | null;
  // Free-form per m038: e.g. "CPI Darwin (June)", "Fixed 3%", "Market".
  reviewType: string;
  securityDepositHeld?: number;
  // Free-form per m038: e.g. "Bank Transfer", "Cash", "Bank Guarantee".
  securityDepositMethod?: string;
  // Free-form per m038: e.g. "Amount equal to 3 months rent plus GST".
  securityDepositRequired?: string;
  securityDepositSteps: SecurityDepositStep[];
  status: "current" | "holdover" | "pending" | "vacated";
  /** Per m040 — physical street address (vs. PostalAddress). */
  streetAddress?: string;
  tenantId: number;
  termMonths?: number;
  totalSizeSqm: number;
  tradingName?: string;
  updatedAt: string;
  updatedBy: UserRef;
}

interface TenantOccupancyApi {
  area: string;
  buildingId: number;
  createdAt: string;
  level: string;
  notes?: string;
  occupancyId: string;
  sizeSqm: number;
  tenantId: number;
  updatedAt: string;
}

interface TenantNoteApi {
  anchorKind: "field" | "occupancy" | "tenant";
  body: string;
  createdAt: string;
  createdBy: UserRef;
  fieldKey?: string;
  noteId: string;
  occupancyId?: string;
  tenantId: number;
}

interface RentReviewApi {
  completedAt?: string;
  completedBy?: UserRef;
  cpiBaseValue?: number;
  cpiCurrentValue?: number;
  cpiIndexUsed?: string;
  increasePercent?: number;
  newRentPerAnnum?: number;
  notes?: string;
  oldRentPerAnnum?: number;
  reviewId: string;
  reviewType: "cpi" | "fixedPercent" | "marketReview" | "none";
  scheduledFor: string;
  status: "completed" | "due" | "overdue" | "skipped" | "upcoming";
  tenantId: number;
}

interface TenantOccupancyHistoryApi {
  effectiveFrom: string;
  effectiveTo?: string;
  historyId: string;
  occupancyId: string;
  rentPerAnnum?: number;
  sizeSqm: number;
  snapshot: string;
  tenantId: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function toIso(d: any): string {
  if (!d) return "";
  if (d instanceof Date) return d.toISOString();
  return new Date(d).toISOString();
}

function toIsoDate(d: any): string | undefined {
  if (!d) return undefined;
  const date = d instanceof Date ? d : new Date(d);
  return Number.isNaN(date.getTime())
    ? undefined
    : date.toISOString().slice(0, 10);
}

function asNum(v: any): number | undefined {
  if (v === null || v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function asStr(v: any): string | undefined {
  return v === null || v === undefined ? undefined : String(v);
}

function asBool(v: any): boolean | undefined {
  if (v === null || v === undefined) return undefined;
  return Boolean(v);
}

function parseDepositSteps(raw: string | null | undefined): SecurityDepositStep[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as SecurityDepositStep[];
  } catch {
    return [];
  }
}

const REVIEW_DUE_SOON_DAYS = 90;

/** The traffic light for a tenant's NextReviewDate (PLAN D11): red once the
 *  review date has passed (Darwin date), amber within 90 days, green after
 *  that; grey with no date or once vacated. */
export function computeReviewState(
  nextReviewDate: string | undefined,
  status: string,
  today: string = todayInDarwin(),
): "amber" | "green" | "grey" | "red" {
  if (status === "vacated") return "grey";
  const next = sqlDateToIso(nextReviewDate);
  if (!next) return "grey";
  if (next < today) return "red";
  return daysBetweenIso(today, next) <= REVIEW_DUE_SOON_DAYS ? "amber" : "green";
}

/** Whole Darwin days until the lease's last day (0 on the day itself). */
export function calcDaysToExpiry(expiryIso: string | undefined, today: string): number | undefined {
  return expiryIso ? daysBetweenIso(today, expiryIso) : undefined;
}

/** Holdover is derived, never stored by an ordinary edit: a stored "current"
 *  lease reads "holdover" once its expiry has passed, and "current" again as
 *  soon as the expiry is extended. */
export function deriveTenantStatus(
  storedStatus: RegisterTenantApi["status"],
  daysToExpiry: number | undefined,
): RegisterTenantApi["status"] {
  return storedStatus === "current" && daysToExpiry !== undefined && daysToExpiry < 0
    ? "holdover"
    : storedStatus;
}

/** Day-pro-rated rent remaining until expiry. Uses 365-day year. */
export function calcDollarsToExpiry(
  daysToExpiry: number,
  effectiveRentPerAnnum: number,
): number {
  if (daysToExpiry <= 0) return 0;
  return (daysToExpiry / 365) * effectiveRentPerAnnum;
}

function tenantRowToApi(
  row: SqlRow,
  occupancies: TenantOccupancyApi[],
  noteCountByAnchor: Record<string, number>,
  pending?: PendingChanges,
): RegisterTenantApi {
  const totalSizeSqm = occupancies.reduce(
    (sum, o) => sum + (o.sizeSqm || 0),
    0,
  );
  const rentPerAnnum = asNum(row.RentPerAnnum);

  // Parse steps first so we can derive the schedule-aware effective rent.
  // rentPerAnnum is the stored base; effectiveRentPerAnnum is what today's
  // schedule row says (Darwin date), or the stored value with no schedule.
  const steps = parseSteps(row.ScheduledRateSteps as string | null | undefined);
  const today = todayInDarwin();
  const terms = scheduleTermsOf(row);
  const reviewRatchet = terms.reviewRatchet === true;
  const resolved = resolveScheduleAnnual(steps, rentPerAnnum ?? 0, totalSizeSqm, today, terms);
  const effectiveRentPerAnnum = resolved.annual;
  // WP26c: a ratified relief in force today lowers what is charged, never the lease's figure.
  const rentReliefs = parseReliefs(row.RentReliefs as string | null | undefined);
  const inForce =
    rentReliefs.length > 0
      ? chargedOn(
          computeCharges(computeScheduleRows(steps, rentPerAnnum ?? 0, totalSizeSqm, terms), { fallbackAnnual: rentPerAnnum ?? 0, reliefs: rentReliefs }),
          today,
        )
      : null;
  const rentRelievedToday = inForce !== null && inForce.charged.rent !== null && inForce.charged.rent !== inForce.lease.rent;
  const chargedRentPerAnnum = rentRelievedToday && inForce?.charged.rent != null ? inForce.charged.rent : effectiveRentPerAnnum;
  const monthlyRental = Math.round((effectiveRentPerAnnum / 12) * 100) / 100;
  const costPerSqm =
    totalSizeSqm > 0
      ? Math.round((effectiveRentPerAnnum / totalSizeSqm) * 100) / 100
      : 0;

  const expiryIso = toIsoDate(row.Expiry);
  const daysToExpiry = calcDaysToExpiry(expiryIso, today);
  const dollarsToExpiry =
    daysToExpiry === undefined ? undefined : calcDollarsToExpiry(daysToExpiry, effectiveRentPerAnnum);

  const status = deriveTenantStatus(
    (row.Status as RegisterTenantApi["status"]) ?? "current",
    daysToExpiry,
  );
  // Derived for today, so a keyed review whose date has passed has already
  // moved on; a tenancy with nothing to derive from shows its stored date.
  const nextReviewDate =
    deriveNextReviewDate(nextReviewInputFromRow(row, steps, today)) ?? toIsoDate(row.NextReviewDate);

  return {
    abn: asStr(row.Abn),
    accountsEmail: asStr(row.AccountsEmail),
    accountsPhone: asStr(row.AccountsPhone),
    acn: asStr(row.Acn),
    activeReliefIds: inForce?.reliefIds ?? [],
    buildingId: row.BuildingId as number,
    businessTenanciesAct: asStr(row.BusinessTenanciesAct),
    chargedRentPerAnnum,
    comments: asStr(row.Comments),
    commencement: toIsoDate(row.Commencement),
    costPerSqm,
    cpiCapPercent: asNum(row.CpiCapPercent),
    cpiFloorPercent: asNum(row.CpiFloorPercent),
    cpiReferenceQuarterRule: asStr(row.CpiReferenceQuarterRule) as RegisterTenantApi["cpiReferenceQuarterRule"],
    cpiRegion: asStr(row.CpiRegion) as RegisterTenantApi["cpiRegion"],
    createdAt: toIso(row.CreatedAt),
    createdBy: {
      id: (row.CreatedById as string) ?? "",
      name: (row.CreatedByName as string) ?? "",
    },
    daysToExpiry,
    dollarsToExpiry,
    effectiveRentPerAnnum,
    escalationPercent: asNum(row.EscalationPercent),
    escalationSchedule: asStr(row.EscalationSchedule),
    expiry: expiryIso,
    fixedReviewPercent: asNum(row.FixedReviewPercent),
    idNo: asStr(row.IdNo),
    incentives: parseIncentives(row.Incentives as string | null | undefined),
    scheduledRateSteps: steps,
    carparkScheduleGroups: parseGroups(
      row.CarparkScheduleGroups as string | null | undefined,
    ),
    miscFees: parseMiscFees(row.MiscFees as string | null | undefined),
    infoSheetSections: parseInfoSheetSections(row.InfoSheetSections as string | null | undefined),
    leaseAdministration: parseLeaseAdministration(row.LeaseAdministration as string | null | undefined),
    informationSheetAsAt: asStr(row.InformationSheetAsAt),
    informationSheetReference: asStr(row.InformationSheetReference),
    lastReviewDate: toIsoDate(row.LastReviewDate),
    lastReviewIncreasePercent: asNum(row.LastReviewIncreasePercent),
    legalName: row.LegalName as string,
    lot: asStr(row.Lot),
    monthlyRental,
    myobId: asStr(row.MyobId),
    nextReviewDate,
    noteCountByAnchor,
    occupancies,
    optionNoticeMonths: asNum(row.OptionNoticeMonths),
    optionPeriods: asStr(row.OptionPeriods),
    ...(pending ? { pendingChanges: pending } : {}),
    postalAddress: asStr(row.PostalAddress),
    primaryContactEmail: asStr(row.PrimaryContactEmail),
    primaryContactName: asStr(row.PrimaryContactName),
    primaryContactPhone: asStr(row.PrimaryContactPhone),
    holdoverTerms: asStr(row.HoldoverTerms),
    renewalLetterIssueBy: asStr(row.RenewalLetterIssueBy),
    rentPerAnnum,
    rentReliefs,
    rentStartsOn: resolved.startsOn ?? undefined,
    reviewIntervalMonths: asNum(row.ReviewIntervalMonths),
    reviewRatchet,
    reviewWorkflowLiveFrom: terms.workflowLiveFrom,
    reviewState: computeReviewState(nextReviewDate, status, today),
    reviewType: asStr(row.ReviewType) ?? "none",
    archivedAt: row.ArchivedAt ? new Date(row.ArchivedAt as string | Date).toISOString() : null,
    archivedBy: (row.ArchivedBy as string | null) ?? null,
    rowVersion: rowVersionHex(row.RowVersion),
    scheduleVersion: Number(row.ScheduleVersion ?? 0),
    scheduleSignOff: scheduleSignOffFromRow(row),
    securityDepositHeld: asNum(row.SecurityDepositHeld),
    securityDepositMethod: asStr(row.SecurityDepositMethod),
    securityDepositRequired: asStr(row.SecurityDepositRequired),
    securityDepositSteps: parseDepositSteps(row.SecurityDepositSteps as string | null | undefined),
    status,
    streetAddress: asStr(row.StreetAddress),
    tenantId: row.TenantId as number,
    termMonths: asNum(row.TermMonths),
    totalSizeSqm,
    tradingName: asStr(row.TradingName),
    updatedAt: toIso(row.UpdatedAt),
    updatedBy: {
      id: (row.UpdatedById as string) ?? "",
      name: (row.UpdatedByName as string) ?? "",
    },
  };
}

function occupancyRowToApi(row: SqlRow): TenantOccupancyApi {
  return {
    area: row.Area as string,
    buildingId: row.BuildingId as number,
    createdAt: toIso(row.CreatedAt),
    level: row.Level as string,
    notes: asStr(row.Notes),
    occupancyId: row.OccupancyId as string,
    sizeSqm: Number(row.SizeSqm),
    tenantId: row.TenantId as number,
    updatedAt: toIso(row.UpdatedAt),
  };
}

function noteRowToApi(row: SqlRow): TenantNoteApi {
  return {
    anchorKind: row.AnchorKind as TenantNoteApi["anchorKind"],
    body: row.Body as string,
    createdAt: toIso(row.CreatedAt),
    createdBy: {
      id: (row.CreatedById as string) ?? "",
      name: (row.CreatedByName as string) ?? "",
    },
    fieldKey: asStr(row.FieldKey),
    noteId: row.NoteId as string,
    occupancyId: asStr(row.OccupancyId),
    tenantId: row.TenantId as number,
  };
}

function reviewRowToApi(row: SqlRow): RentReviewApi {
  return {
    completedAt: row.CompletedAt ? toIso(row.CompletedAt) : undefined,
    completedBy: row.CompletedById
      ? {
          id: row.CompletedById as string,
          name: (row.CompletedByName as string) ?? "",
        }
      : undefined,
    cpiBaseValue: asNum(row.CpiBaseValue),
    cpiCurrentValue: asNum(row.CpiCurrentValue),
    cpiIndexUsed: asStr(row.CpiIndexUsed),
    increasePercent: asNum(row.IncreasePercent),
    newRentPerAnnum: asNum(row.NewRentPerAnnum),
    notes: asStr(row.Notes),
    oldRentPerAnnum: asNum(row.OldRentPerAnnum),
    reviewId: row.ReviewId as string,
    reviewType: row.ReviewType as RentReviewApi["reviewType"],
    scheduledFor: toIsoDate(row.ScheduledFor) ?? "",
    status: row.Status as RentReviewApi["status"],
    tenantId: row.TenantId as number,
  };
}

function historyRowToApi(row: SqlRow): TenantOccupancyHistoryApi {
  return {
    effectiveFrom: toIsoDate(row.EffectiveFrom) ?? "",
    effectiveTo: toIsoDate(row.EffectiveTo),
    historyId: row.HistoryId as string,
    occupancyId: row.OccupancyId as string,
    rentPerAnnum: asNum(row.RentPerAnnum),
    sizeSqm: Number(row.SizeSqm),
    snapshot: (row.Snapshot as string) ?? "{}",
    tenantId: row.TenantId as number,
  };
}

const TENANT_COLUMNS = `
  TenantId, BuildingId, IdNo, MyobId, LegalName, TradingName, Acn, Abn,
  PostalAddress, StreetAddress, AccountsPhone, AccountsEmail,
  PrimaryContactName, PrimaryContactEmail, PrimaryContactPhone,
  Lot, InformationSheetAsAt, InformationSheetReference,
  Commencement, Expiry, TermMonths, OptionPeriods, OptionNoticeMonths,
  RenewalLetterIssueBy, HoldoverTerms,
  RentPerAnnum,
  ReviewType, ReviewIntervalMonths, NextReviewDate, LastReviewDate,
  LastReviewIncreasePercent, FixedReviewPercent,
  CpiRegion, CpiReferenceQuarterRule, CpiCapPercent, CpiFloorPercent, ReviewRatchet,
  SecurityDepositRequired, SecurityDepositMethod, SecurityDepositHeld, SecurityDepositSteps,
  Status, Comments, EscalationPercent, EscalationSchedule,
  BusinessTenanciesAct,
  Incentives,
  ScheduledRateSteps,
  CarparkScheduleGroups,
  MiscFees,
  RentReliefs,
  InfoSheetSections,
  LeaseAdministration,
  CreatedAt, UpdatedAt, CreatedById, CreatedByName, UpdatedById, UpdatedByName,
  RowVersion, ScheduleVersion,
  ${SIGN_OFF_COLUMNS},
  ArchivedAt, ArchivedBy,
  ${RESOLVED_REVIEW_DATES_SQL}
`;

// The building register: archived tenancies (D4) only when asked for.
const REGISTER_SQL = `SELECT ${TENANT_COLUMNS} FROM dbo.Tenants t WHERE BuildingId = @BuildingId AND t.ArchivedAt IS NULL
 ORDER BY LegalName`;
const REGISTER_WITH_ARCHIVED_SQL = `SELECT ${TENANT_COLUMNS} FROM dbo.Tenants t WHERE BuildingId = @BuildingId
 ORDER BY LegalName`;

const OCCUPANCY_COLUMNS = `
  OccupancyId, TenantId, BuildingId, Level, Area, SizeSqm,
  Notes, CreatedAt, UpdatedAt
`;

/** Group an array by a key function. */
function groupBy<T>(rows: T[], keyFn: (row: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const r of rows) {
    const k = keyFn(r);
    const existing = map.get(k);
    if (existing) existing.push(r);
    else map.set(k, [r]);
  }
  return map;
}

// ── GET /api/getRegisterTenants?buildingId=N ─────────────────────────────────

async function getRegisterTenants(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const roleCheck = await requireRole(request, [AppRole.ACCOUNTS, AppRole.ACCOUNTS_APPROVAL, AppRole.ADMIN, AppRole.DIRECTOR]);
  if (roleCheck) return roleCheck;

  const buildingIdRaw = request.query.get("buildingId");
  if (!buildingIdRaw) {
    return { status: 400, jsonBody: { error: "buildingId required" } };
  }
  const buildingId = Number(buildingIdRaw);
  if (!Number.isFinite(buildingId)) {
    return { status: 400, jsonBody: { error: "buildingId must be a number" } };
  }

  // Archived tenancies (D4) are left out unless asked for; that view isn't cached.
  const includeArchived = request.query.get("includeArchived") === "true";
  const cached = includeArchived ? null : getCachedTenantList(buildingId);
  if (cached) return { status: 200, jsonBody: cached };

  let connection;
  try {
    connection = await createRequestConnection(token);

    const tenantRows = await executeQuery(
      connection,
      includeArchived ? REGISTER_WITH_ARCHIVED_SQL : REGISTER_SQL,
      [{ name: "BuildingId", type: TYPES.Int, value: buildingId }],
    );

    if (tenantRows.length === 0) {
      return { status: 200, jsonBody: { pendingChanges: pendingChangesOf([]), tenants: [] } };
    }

    const tenantIds = tenantRows.map((r) => r.TenantId as number);

    // Pull occupancies for all tenants in one shot.
    const occupancyRows = await executeQuery(
      connection,
      `SELECT ${OCCUPANCY_COLUMNS}
       FROM dbo.TenantOccupancies
       WHERE BuildingId = @BuildingId
       ORDER BY Level, Area`,
      [{ name: "BuildingId", type: TYPES.Int, value: buildingId }],
    );
    const occupanciesByTenant = groupBy(
      occupancyRows.map(occupancyRowToApi),
      (o) => String(o.tenantId),
    );

    // Note counts grouped by anchor in a single pass.
    const noteCountRows = await executeQuery(
      connection,
      `SELECT n.TenantId,
              n.AnchorKind,
              COALESCE(n.OccupancyId, '') AS OccupancyId,
              COALESCE(n.FieldKey, '') AS FieldKey,
              COUNT(*) AS Cnt
       FROM dbo.TenantNotes n
       INNER JOIN dbo.Tenants t ON t.TenantId = n.TenantId
       WHERE t.BuildingId = @BuildingId
       GROUP BY n.TenantId, n.AnchorKind, n.OccupancyId, n.FieldKey`,
      [{ name: "BuildingId", type: TYPES.Int, value: buildingId }],
    );
    const noteCountsByTenant = new Map<number, Record<string, number>>();
    for (const r of noteCountRows) {
      const tid = r.TenantId as number;
      const map = noteCountsByTenant.get(tid) ?? {};
      const key = noteAnchorKey(
        r.AnchorKind as string,
        r.OccupancyId as string,
        r.FieldKey as string,
      );
      map[key] = (map[key] ?? 0) + Number(r.Cnt);
      noteCountsByTenant.set(tid, map);
    }

    // WP26c: the building's changes awaiting a director, on the list and on each tenancy.
    const pending = await loadPendingChanges(connection, { buildingId }, "full");
    const tenants = tenantRows.map((row) => {
      const tid = row.TenantId as number;
      return tenantRowToApi(
        row,
        occupanciesByTenant.get(String(tid)) ?? [],
        noteCountsByTenant.get(tid) ?? {},
        pendingFor(pending, tid),
      );
    });

    const body = { pendingChanges: pendingChangesOf(pending), tenants };
    if (!includeArchived) setCachedTenantList(buildingId, body);
    return { status: 200, jsonBody: body };
  } catch (error: any) {
    context.error("getRegisterTenants failed:", error.message);
    return errorResponse("Failed to fetch register tenants", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

function noteAnchorKey(
  anchorKind: string,
  occupancyId: string,
  fieldKey: string,
): string {
  if (anchorKind === "occupancy") return `occupancy:${occupancyId}`;
  if (anchorKind === "field") return `field:${fieldKey}`;
  return "tenant";
}

// ── GET /api/getRegisterTenant?tenantId=N ────────────────────────────────────

async function getRegisterTenant(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const roleCheck = await requireRole(request, [AppRole.ACCOUNTS, AppRole.ACCOUNTS_APPROVAL, AppRole.ADMIN, AppRole.DIRECTOR]);
  if (roleCheck) return roleCheck;

  const tenantIdRaw = request.query.get("tenantId");
  if (!tenantIdRaw) {
    return { status: 400, jsonBody: { error: "tenantId required" } };
  }
  const tenantId = Number(tenantIdRaw);
  if (!Number.isFinite(tenantId)) {
    return { status: 400, jsonBody: { error: "tenantId must be a number" } };
  }

  const cachedDetail = getCachedTenantDetail(tenantId);
  if (cachedDetail) return { status: 200, jsonBody: cachedDetail };

  let connection;
  try {
    connection = await createRequestConnection(token);
    const tenantRows = await executeQuery(
      connection,
      `SELECT ${TENANT_COLUMNS} FROM dbo.Tenants t WHERE TenantId = @TenantId`,
      [{ name: "TenantId", type: TYPES.Int, value: tenantId }],
    );
    if (tenantRows.length === 0) {
      return { status: 404, jsonBody: { error: "Tenant not found" } };
    }
    const row = tenantRows[0];

    // tedious Connections handle one request at a time — run sequentially.
    const tenantIdParam = [
      { name: "TenantId", type: TYPES.Int, value: tenantId },
    ];
    const occupancyRows = await executeQuery(
      connection,
      `SELECT ${OCCUPANCY_COLUMNS}
       FROM dbo.TenantOccupancies
       WHERE TenantId = @TenantId
       ORDER BY Level, Area`,
      tenantIdParam,
    );
    const noteRows = await executeQuery(
      connection,
      `SELECT NoteId, TenantId, AnchorKind, OccupancyId, FieldKey, Body,
              CreatedAt, CreatedById, CreatedByName
       FROM dbo.TenantNotes
       WHERE TenantId = @TenantId
       ORDER BY CreatedAt DESC`,
      tenantIdParam,
    );
    const reviewRows = await executeQuery(
      connection,
      `SELECT ReviewId, TenantId, ScheduledFor, Status, ReviewType,
              OldRentPerAnnum, NewRentPerAnnum, IncreasePercent,
              CpiIndexUsed, CpiBaseValue, CpiCurrentValue,
              CompletedAt, CompletedById, CompletedByName, Notes
       FROM dbo.RentReviews
       WHERE TenantId = @TenantId
       ORDER BY ScheduledFor DESC`,
      tenantIdParam,
    );
    const historyRows = await executeQuery(
      connection,
      `SELECT HistoryId, OccupancyId, TenantId, EffectiveFrom, EffectiveTo,
              SizeSqm, RentPerAnnum, Snapshot
       FROM dbo.TenantOccupancyHistory
       WHERE TenantId = @TenantId
       ORDER BY EffectiveFrom DESC`,
      tenantIdParam,
    );
    const changeLogRows = await executeQuery(
      connection,
      `SELECT ChangeId, TenantId, BuildingId, StepId, ChangeKind,
              ChangedAt, ChangedById, ChangedByName, StepSnapshot, Diff
       FROM dbo.RentScheduleChangeLog
       WHERE TenantId = @TenantId
       ORDER BY ChangedAt DESC`,
      tenantIdParam,
    );
    const plannerTaskRows = await executeQuery(
      connection,
      `SELECT Id, TriggerType, LeadTimeDays, PlannerTaskId, DueDate,
              Status, CreatedAt, ResolvedAt,
              LastSyncedAt, LastError, AttemptCount
       FROM dbo.PlannerTasks
       WHERE EntityType = 'tenant' AND EntityId = @TenantId
       ORDER BY CreatedAt DESC`,
      tenantIdParam,
    );

    const occupancies = occupancyRows.map(occupancyRowToApi);
    const notes = noteRows.map(noteRowToApi);
    const reviews = reviewRows.map(reviewRowToApi);
    const history = historyRows.map(historyRowToApi);
    const rentScheduleChangeLog = changeLogRows.map(changeLogRowToApi);

    const noteCountByAnchor: Record<string, number> = {};
    for (const n of notes) {
      const key = noteAnchorKey(
        n.anchorKind,
        n.occupancyId ?? "",
        n.fieldKey ?? "",
      );
      noteCountByAnchor[key] = (noteCountByAnchor[key] ?? 0) + 1;
    }

    // WP26c: the tenancy's changes awaiting a director, with who asked and why.
    const pending = await loadPendingChanges(connection, { tenantId }, "full");
    const tenant = tenantRowToApi(row, occupancies, noteCountByAnchor, pendingChangesOf(pending));
    const displayName = (tenant as any).tradingName ?? (tenant as any).legalName;
    const plannerTasks = plannerTaskRows.map((r) => {
      const triggerType = r.TriggerType as string;
      const leadTimeDays = r.LeadTimeDays as number;
      const title = buildPlannerTaskTitle(triggerType, leadTimeDays, displayName);
      return {
        id: r.Id as number,
        triggerType,
        leadTimeDays,
        title,
        dueDate: r.DueDate
          ? (r.DueDate as Date).toISOString().slice(0, 10)
          : null,
        status: r.Status as string,
        createdAt: (r.CreatedAt as Date).toISOString(),
        resolvedAt: r.ResolvedAt ? (r.ResolvedAt as Date).toISOString() : null,
        lastSyncedAt: r.LastSyncedAt
          ? (r.LastSyncedAt as Date).toISOString()
          : null,
        lastError: (r.LastError as string | null) ?? null,
        attemptCount: (r.AttemptCount as number | null) ?? 0,
      };
    });
    const detailBody = {
      tenant: { ...tenant, history, notes, reviews, rentScheduleChangeLog, plannerTasks },
    };
    setCachedTenantDetail(tenantId, row.BuildingId as number, detailBody);
    return { status: 200, jsonBody: detailBody };
  } catch (error: any) {
    context.error("getRegisterTenant failed:", error.message);
    return errorResponse("Failed to fetch register tenant", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── POST /api/upsertRegisterTenant ───────────────────────────────────────────

async function upsertRegisterTenant(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const roleCheck = await requireRole(request, [AppRole.ACCOUNTS, AppRole.ACCOUNTS_APPROVAL, AppRole.ADMIN, AppRole.DIRECTOR]);
  if (roleCheck) return roleCheck;
  const caller = callerFromToken(token);

  let connection;
  let body: Record<string, any> | null = null;
  try {
    body = (await request.json()) as Record<string, any>;
    const tenantId = body.TenantId as number | undefined;

    // Required on create
    if (tenantId === undefined) {
      if (typeof body.LegalName !== "string" || !body.LegalName.trim()) {
        return {
          status: 400,
          jsonBody: { error: "LegalName (string) required" },
        };
      }
      if (typeof body.BuildingId !== "number") {
        return {
          status: 400,
          jsonBody: { error: "BuildingId (number) required" },
        };
      }
    } else if (
      Object.prototype.hasOwnProperty.call(body, "LegalName") &&
      (typeof body.LegalName !== "string" || !body.LegalName.trim())
    ) {
      // LegalName is NOT NULL — refuse to clear it on update.
      return { status: 400, jsonBody: { error: "LegalName cannot be empty" } };
    }

    const invalidTerm = invalidTermValue(body) ?? (tenantId === undefined ? floorAboveCap(body, {}) : null);
    if (invalidTerm) return invalidTerm;

    connection = await createRequestConnection(token);

    const params = buildTenantParams(body, caller);

    let resultId: number;
    if (tenantId === undefined) {
      const inserted = await executeQuery(
        connection,
        `INSERT INTO dbo.Tenants (
            BuildingId, IdNo, MyobId, LegalName, TradingName, Acn, Abn,
            PostalAddress, StreetAddress, AccountsPhone, AccountsEmail,
            PrimaryContactName, PrimaryContactEmail, PrimaryContactPhone,
            Lot, InformationSheetAsAt, InformationSheetReference,
            Commencement, Expiry, TermMonths, OptionPeriods, OptionNoticeMonths,
            RenewalLetterIssueBy, HoldoverTerms,
            RentPerAnnum,
            ReviewType, ReviewIntervalMonths, NextReviewDate, LastReviewDate,
            LastReviewIncreasePercent, FixedReviewPercent,
            CpiRegion, CpiReferenceQuarterRule, CpiCapPercent, CpiFloorPercent, ReviewRatchet,
            SecurityDepositRequired, SecurityDepositMethod, SecurityDepositHeld,
            Status, Comments, EscalationPercent, EscalationSchedule,
            BusinessTenanciesAct,
            LeaseAdministration,
            CreatedById, CreatedByName, UpdatedById, UpdatedByName
         )
         OUTPUT INSERTED.TenantId
         VALUES (
            @BuildingId, @IdNo, @MyobId, @LegalName, @TradingName, @Acn, @Abn,
            @PostalAddress, @StreetAddress, @AccountsPhone, @AccountsEmail,
            @PrimaryContactName, @PrimaryContactEmail, @PrimaryContactPhone,
            @Lot, @InformationSheetAsAt, @InformationSheetReference,
            @Commencement, @Expiry, @TermMonths, @OptionPeriods, @OptionNoticeMonths,
            @RenewalLetterIssueBy, @HoldoverTerms,
            @RentPerAnnum,
            @ReviewType, @ReviewIntervalMonths, @NextReviewDate, @LastReviewDate,
            @LastReviewIncreasePercent, @FixedReviewPercent,
            @CpiRegion, @CpiReferenceQuarterRule, @CpiCapPercent, @CpiFloorPercent, @ReviewRatchet,
            @SecurityDepositRequired, @SecurityDepositMethod, @SecurityDepositHeld,
            @Status, @Comments, @EscalationPercent, @EscalationSchedule,
            @BusinessTenanciesAct,
            @LeaseAdministration,
            @CreatedById, @CreatedByName, @UpdatedById, @UpdatedByName
         )`,
        [
          ...params,
          {
            name: "LeaseAdministration",
            type: TYPES.NVarChar,
            value: JSON.stringify(defaultLeaseAdministration()),
          },
        ],
      );
      resultId = inserted[0].TenantId as number;
    } else {
      if (
        body.RowVersion !== undefined &&
        (typeof body.RowVersion !== "string" || !ROW_VERSION_RE.test(body.RowVersion))
      ) {
        return { status: 400, jsonBody: { error: "RowVersion must be the 16-character hex the tenant was read with" } };
      }
      const actor = await resolveLedgerActor(request, connection);
      if (!actor) return unauthorizedResponse();
      const refused = await updateRegisterTenantRow(connection, body, caller, actor, tenantId);
      if (refused) return refused;
      resultId = tenantId;
    }

    const stored = await executeQuery(
      connection,
      `SELECT ${TENANT_COLUMNS} FROM dbo.Tenants t WHERE TenantId = @Id`,
      [{ name: "Id", type: TYPES.Int, value: resultId }],
    );
    if (stored.length === 0) {
      return {
        status: 404,
        jsonBody: { error: "Tenant disappeared after upsert" },
      };
    }
    invalidateTenantAndBuilding(resultId, stored[0].BuildingId as number);
    const newStatus = body?.Status as string | undefined;
    const expiryChanged = Object.prototype.hasOwnProperty.call(body, "Expiry");
    if (newStatus === "vacated" || expiryChanged) {
      const triggerTypes: Array<"lease_expiry" | "option_notice"> = [
        "lease_expiry",
        "option_notice",
      ];
      resolveActivePlannerTasks("tenant", resultId, triggerTypes).catch(
        (err: unknown) =>
          context.warn("plannerResolve (upsertRegisterTenant):", err instanceof Error ? err.message : String(err)),
      );
    }
    return {
      status: 200,
      jsonBody: { tenant: tenantRowToApi(stored[0], [], {}) },
    };
  } catch (error: any) {
    const refusal = ledgerRefusal(error);
    if (refusal) return refusal;
    const formatted = formatSqlError(error);
    context.error("upsertRegisterTenant failed", {
      error: formatted,
      stack: error?.stack,
      payload: summariseBody(body),
    });
    return errorResponse("Upsert register tenant failed", formatted);
  } finally {
    if (connection) closeConnection(connection);
  }
}

const ROW_VERSION_RE = /^[0-9a-f]{16}$/i;

// Columns a tenant update may set → tedious type. Keys are SQL column names
// (they build the SET clause), so a body key that isn't listed here is ignored.
const TENANT_UPDATE_COLUMNS: Record<string, unknown> = {
  Abn: TYPES.NVarChar,
  AccountsEmail: TYPES.NVarChar,
  AccountsPhone: TYPES.NVarChar,
  Acn: TYPES.NVarChar,
  BuildingId: TYPES.Int,
  BusinessTenanciesAct: TYPES.NVarChar,
  Commencement: TYPES.Date,
  Comments: TYPES.NVarChar,
  HoldoverTerms: TYPES.NVarChar,
  CpiCapPercent: TYPES.Decimal,
  CpiFloorPercent: TYPES.Decimal,
  // M4 (m099): null or "" puts it back to the default (normaliseValue).
  CpiReferenceQuarterRule: TYPES.NVarChar,
  CpiRegion: TYPES.NVarChar,
  EscalationPercent: TYPES.Decimal,
  EscalationSchedule: TYPES.NVarChar,
  Expiry: TYPES.Date,
  FixedReviewPercent: TYPES.Decimal,
  IdNo: TYPES.NVarChar,
  InformationSheetAsAt: TYPES.NVarChar,
  InformationSheetReference: TYPES.NVarChar,
  LastReviewDate: TYPES.Date,
  LastReviewIncreasePercent: TYPES.Decimal,
  LegalName: TYPES.NVarChar,
  Lot: TYPES.NVarChar,
  MyobId: TYPES.NVarChar,
  NextReviewDate: TYPES.Date,
  OptionNoticeMonths: TYPES.Int,
  OptionPeriods: TYPES.NVarChar,
  PostalAddress: TYPES.NVarChar,
  PrimaryContactEmail: TYPES.NVarChar,
  PrimaryContactName: TYPES.NVarChar,
  PrimaryContactPhone: TYPES.NVarChar,
  RenewalLetterIssueBy: TYPES.NVarChar,
  RentPerAnnum: TYPES.Decimal,
  ReviewIntervalMonths: TYPES.Int,
  ReviewRatchet: TYPES.Bit,
  ReviewType: TYPES.NVarChar,
  SecurityDepositHeld: TYPES.Decimal,
  SecurityDepositMethod: TYPES.NVarChar,
  SecurityDepositRequired: TYPES.NVarChar,
  SecurityDepositSteps: TYPES.NVarChar,
  Status: TYPES.NVarChar,
  StreetAddress: TYPES.NVarChar,
  TermMonths: TYPES.Int,
  TradingName: TYPES.NVarChar,
};

// Tenant fields the schedule computes from (PLAN WP23a). A change is ledgered
// as schedule.terms_edit and bumps ScheduleVersion, so a review calculated
// before the change can't be applied after it. RentPerAnnum is the schedule's
// starting rent when no commencement row carries one, so it counts too. The CPI
// reference-quarter rule (M4, WP26c) is set at sign-off with the lease's terms
// and decides a review's rent, so it counts as well.
const SCHEDULE_TERM_FIELDS: Record<string, string> = {
  CpiCapPercent: "cpiCapPercent",
  CpiFloorPercent: "cpiFloorPercent",
  CpiReferenceQuarterRule: "cpiReferenceQuarterRule",
  FixedReviewPercent: "fixedReviewPercent",
  RentPerAnnum: "rentPerAnnum",
  ReviewIntervalMonths: "reviewIntervalMonths",
  ReviewRatchet: "reviewRatchet",
  ReviewType: "reviewType",
};

// Tenant fields the next review date is derived from (WP23b). A write that
// sends any of them re-derives NextReviewDate; a sent NextReviewDate is only
// stored for a tenancy without a schedule (deriveNextReviewDate).
const REVIEW_DATE_FIELDS = ["Commencement", "LastReviewDate", "NextReviewDate", "ReviewIntervalMonths"] as const;

const LOCKED_TENANT_COLUMNS = `
  TenantId, BuildingId, Status, Expiry, RowVersion, UpdatedByName, UpdatedAt,
  CpiCapPercent, CpiFloorPercent, CpiReferenceQuarterRule, FixedReviewPercent, RentPerAnnum,
  ReviewIntervalMonths, ReviewType, ReviewRatchet,
  Commencement, LastReviewDate, NextReviewDate, ScheduledRateSteps,
  ${SIGN_OFF_COLUMNS},
  ${RESOLVED_REVIEW_DATES_SQL}
`;

function comparableTerm(value: unknown): number | string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return value;
  if (typeof value === "string") return value.trim();
  return Number(value);
}

/** 400 for a malformed schedule-term value; null when the body is fine. */
function invalidTermValue(body: Record<string, any>): HttpResponseInit | null {
  if (body.ReviewRatchet !== undefined && typeof body.ReviewRatchet !== "boolean") {
    return { status: 400, jsonBody: { error: "ReviewRatchet must be true or false" } };
  }
  // M4: the lease's CPI reference quarter; null or "" puts it back to the default.
  const rule = body.CpiReferenceQuarterRule;
  if (rule !== undefined && rule !== null && rule !== "" && !(CPI_REFERENCE_RULES as readonly unknown[]).includes(rule)) {
    return { status: 400, jsonBody: { error: `CpiReferenceQuarterRule must be one of ${CPI_REFERENCE_RULES.join(", ")}, or null` } };
  }
  for (const col of ["CpiCapPercent", "CpiFloorPercent"]) {
    const value = body[col];
    if (value === undefined || value === null || value === "") continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
      return { status: 400, jsonBody: { error: `${col} must be a percentage from 0 to 100` } };
    }
  }
  return null;
}

/** 400 when the CPI floor would sit above the cap once this write applies. */
function floorAboveCap(fields: Record<string, unknown>, current: SqlRow): HttpResponseInit | null {
  if (fields.CpiCapPercent === undefined && fields.CpiFloorPercent === undefined) return null;
  const after = (col: string) =>
    comparableTerm(fields[col] !== undefined ? normaliseValue(col, fields[col]) : current[col]);
  const cap = after("CpiCapPercent");
  const floor = after("CpiFloorPercent");
  if (typeof cap !== "number" || typeof floor !== "number" || floor <= cap) return null;
  return {
    status: 400,
    jsonBody: { error: `The CPI floor (${floor}%) can't be above the CPI cap (${cap}%).` },
  };
}

/**
 * NextReviewDate as this write leaves it (PLAN D1): re-derived when the write
 * touches a review date field. Sets or drops fields.NextReviewDate and returns
 * the move (it rides in the write's terms_edit entry, if there is one), or
 * null when it doesn't move.
 */
function deriveNextReviewOnWrite(
  fields: Record<string, unknown>,
  current: SqlRow,
): { after: string; before: string | null } | null {
  if (!REVIEW_DATE_FIELDS.some((col) => fields[col] !== undefined)) return null;
  const pick = (col: string) => (fields[col] !== undefined ? normaliseValue(col, fields[col]) : current[col]);
  const derived = deriveNextReviewDate(
    nextReviewInputFromRow(
      {
        Commencement: pick("Commencement"),
        LastReviewDate: pick("LastReviewDate"),
        NextReviewDate: pick("NextReviewDate"),
        ResolvedReviewDates: current.ResolvedReviewDates,
        ReviewIntervalMonths: pick("ReviewIntervalMonths"),
      },
      parseSteps(current.ScheduledRateSteps as string | null | undefined),
    ),
  );
  // Not derivable (no schedule, a date already set): a sent date stands.
  if (derived === null) return null;
  const before = sqlDateToIso(current.NextReviewDate);
  if (derived === before) {
    delete fields.NextReviewDate;
    return null;
  }
  fields.NextReviewDate = derived;
  return { after: derived, before };
}

/**
 * The update half of upsertRegisterTenant, in one transaction. Checks the
 * RowVersion the client read (409 naming who changed it), never stores a
 * re-sent derived Status, re-derives NextReviewDate, and ledgers
 * schedule-term and next-review changes. Returns a response when the write is
 * refused, null when it committed.
 */
async function updateRegisterTenantRow(
  connection: Connection,
  body: Record<string, any>,
  caller: UserRef,
  actor: ledger.LedgerActor,
  tenantId: number,
): Promise<HttpResponseInit | null> {
  await beginTransaction(connection);
  try {
    const locked = await executeQuery(
      connection,
      `SELECT ${LOCKED_TENANT_COLUMNS} FROM dbo.Tenants t WITH (UPDLOCK, ROWLOCK) WHERE t.TenantId = @TenantId`,
      [{ name: "TenantId", type: TYPES.Int, value: tenantId }],
    );
    if (locked.length === 0) {
      await rollbackQuietly(connection);
      return { status: 404, jsonBody: { error: "Tenant not found" } };
    }
    const current = locked[0];
    const currentVersion = rowVersionHex(current.RowVersion);
    if (typeof body.RowVersion === "string" && body.RowVersion.toLowerCase() !== currentVersion) {
      await rollbackQuietly(connection);
      return conflictResponse(
        { changedAt: isoTimestamp(current.UpdatedAt), changedBy: (current.UpdatedByName as string | null) ?? null },
        { rowVersion: currentVersion },
      );
    }

    const fields: Record<string, unknown> = { ...body };
    const refused = floorAboveCap(fields, current);
    if (refused) {
      await rollbackQuietly(connection);
      return refused;
    }
    if (Array.isArray(fields.SecurityDepositSteps)) {
      fields.SecurityDepositSteps = JSON.stringify(fields.SecurityDepositSteps);
    }
    // A Status equal to what the client was shown (holdover is derived from a
    // stored "current") is a re-send, not an edit — storing it would make
    // holdover stick after the expiry is extended.
    if (fields.Status !== undefined) {
      const shown = deriveTenantStatus(
        (current.Status as RegisterTenantApi["status"]) ?? "current",
        calcDaysToExpiry(toIsoDate(current.Expiry), todayInDarwin()),
      );
      if (fields.Status === shown) delete fields.Status;
    }
    const nextReview = deriveNextReviewOnWrite(fields, current);

    const setParts: string[] = [];
    const updateParams: SqlParam[] = [];
    const termsBefore: Record<string, unknown> = {};
    const termsAfter: Record<string, unknown> = {};
    for (const col of Object.keys(TENANT_UPDATE_COLUMNS)) {
      if (!Object.prototype.hasOwnProperty.call(fields, col) || fields[col] === undefined) continue;
      const value = normaliseValue(col, fields[col]);
      setParts.push(`${col} = @${col}`);
      updateParams.push({
        name: col,
        options: (DECIMAL_OPTS as Record<string, { precision: number; scale: number }>)[col],
        type: TENANT_UPDATE_COLUMNS[col],
        value,
      });
      const termKey = SCHEDULE_TERM_FIELDS[col];
      if (termKey && comparableTerm(current[col]) !== comparableTerm(value)) {
        termsBefore[termKey] = current[col] ?? null;
        termsAfter[termKey] = value ?? null;
      }
    }
    if (setParts.length === 0) {
      await commitTransaction(connection);
      return null;
    }
    const termsChanged = Object.keys(termsAfter).length > 0;
    // A change to what the schedule is computed from clears a sign-off, and the
    // person says why (PLAN WP24). Asked before anything is written.
    const priorSignOff = termsChanged ? scheduleSignOffFromRow(current) : null;
    const clearReason = readSignOffClearReason(body);
    if (priorSignOff && !clearReason) {
      await rollbackQuietly(connection);
      return signOffReasonRequiredResponse(priorSignOff);
    }
    if (termsChanged) setParts.push("ScheduleVersion = ScheduleVersion + 1");
    if (priorSignOff) setParts.push(CLEAR_SIGN_OFF_SQL);
    setParts.push("UpdatedAt = SYSUTCDATETIME()", "UpdatedById = @UpdatedById", "UpdatedByName = @UpdatedByName");
    updateParams.push(
      { name: "UpdatedById", type: TYPES.NVarChar, value: caller.id },
      { name: "UpdatedByName", type: TYPES.NVarChar, value: caller.name },
      { name: "TenantId", type: TYPES.Int, value: tenantId },
    );
    await executeQuery(
      connection,
      `UPDATE dbo.Tenants SET ${setParts.join(", ")} WHERE TenantId = @TenantId`,
      updateParams,
    );
    const scope = {
      actor,
      buildingId: current.BuildingId as number,
      correlationId: ledger.newCorrelationId(),
      subject: { id: tenantId, type: "tenancy" as const },
      tenantId,
    };
    if (termsChanged) {
      const [terms] = nextReview
        ? withNextReviewDate([{ after: termsAfter, before: termsBefore }], nextReview.before, nextReview.after)
        : [{ after: termsAfter, before: termsBefore }];
      await ledger.record(connection, { ...scope, action: "schedule.terms_edit", ...terms });
    }
    if (priorSignOff && clearReason) {
      await recordSignOffCleared(connection, scope, priorSignOff, clearReason, "tenant");
    }
    await commitTransaction(connection);
    return null;
  } catch (err) {
    await rollbackQuietly(connection);
    throw err;
  }
}

function normaliseValue(col: string, value: any): any {
  if (value === null || value === "") return null;
  // Dates: trim a full ISO datetime down to YYYY-MM-DD for DATE columns.
  const dateCols = new Set([
    "Commencement",
    "Expiry",
    "NextReviewDate",
    "LastReviewDate",
  ]);
  if (dateCols.has(col) && typeof value === "string" && value.length > 10) {
    return value.slice(0, 10);
  }
  return value;
}

function buildTenantParams(
  body: Record<string, any>,
  caller: UserRef,
): SqlParam[] {
  const v = (k: string) =>
    body[k] === undefined ? null : normaliseValue(k, body[k]);
  return [
    { name: "BuildingId", type: TYPES.Int, value: body.BuildingId },
    { name: "IdNo", type: TYPES.NVarChar, value: v("IdNo") },
    { name: "MyobId", type: TYPES.NVarChar, value: v("MyobId") },
    { name: "LegalName", type: TYPES.NVarChar, value: body.LegalName },
    { name: "TradingName", type: TYPES.NVarChar, value: v("TradingName") },
    { name: "Acn", type: TYPES.NVarChar, value: v("Acn") },
    { name: "Abn", type: TYPES.NVarChar, value: v("Abn") },
    { name: "PostalAddress", type: TYPES.NVarChar, value: v("PostalAddress") },
    { name: "StreetAddress", type: TYPES.NVarChar, value: v("StreetAddress") },
    { name: "AccountsPhone", type: TYPES.NVarChar, value: v("AccountsPhone") },
    { name: "AccountsEmail", type: TYPES.NVarChar, value: v("AccountsEmail") },
    {
      name: "PrimaryContactName",
      type: TYPES.NVarChar,
      value: v("PrimaryContactName"),
    },
    {
      name: "PrimaryContactEmail",
      type: TYPES.NVarChar,
      value: v("PrimaryContactEmail"),
    },
    {
      name: "PrimaryContactPhone",
      type: TYPES.NVarChar,
      value: v("PrimaryContactPhone"),
    },
    { name: "Lot", type: TYPES.NVarChar, value: v("Lot") },
    {
      name: "InformationSheetAsAt",
      type: TYPES.NVarChar,
      value: v("InformationSheetAsAt"),
    },
    {
      name: "InformationSheetReference",
      type: TYPES.NVarChar,
      value: v("InformationSheetReference"),
    },
    { name: "Commencement", type: TYPES.Date, value: v("Commencement") },
    { name: "Expiry", type: TYPES.Date, value: v("Expiry") },
    { name: "TermMonths", type: TYPES.Int, value: v("TermMonths") },
    { name: "OptionPeriods", type: TYPES.NVarChar, value: v("OptionPeriods") },
    {
      name: "OptionNoticeMonths",
      type: TYPES.Int,
      value: v("OptionNoticeMonths"),
    },
    {
      name: "RenewalLetterIssueBy",
      type: TYPES.NVarChar,
      value: v("RenewalLetterIssueBy"),
    },
    { name: "HoldoverTerms", type: TYPES.NVarChar, value: v("HoldoverTerms") },
    {
      name: "RentPerAnnum",
      type: TYPES.Decimal,
      value: v("RentPerAnnum"),
      options: DECIMAL_OPTS.RentPerAnnum,
    },
    {
      name: "ReviewType",
      type: TYPES.NVarChar,
      value: body.ReviewType ?? "none",
    },
    {
      name: "ReviewIntervalMonths",
      type: TYPES.Int,
      value: v("ReviewIntervalMonths"),
    },
    // A new tenancy has no schedule yet: a sent date stands, else the first
    // anniversary after commencement (deriveNextReviewDate).
    {
      name: "NextReviewDate",
      type: TYPES.Date,
      value:
        deriveNextReviewDate(
          nextReviewInputFromRow(
            {
              Commencement: v("Commencement"),
              LastReviewDate: v("LastReviewDate"),
              NextReviewDate: v("NextReviewDate"),
              ReviewIntervalMonths: v("ReviewIntervalMonths"),
            },
            [],
          ),
        ) ?? v("NextReviewDate"),
    },
    { name: "LastReviewDate", type: TYPES.Date, value: v("LastReviewDate") },
    {
      name: "LastReviewIncreasePercent",
      type: TYPES.Decimal,
      value: v("LastReviewIncreasePercent"),
      options: DECIMAL_OPTS.LastReviewIncreasePercent,
    },
    {
      name: "FixedReviewPercent",
      type: TYPES.Decimal,
      value: v("FixedReviewPercent"),
      options: DECIMAL_OPTS.FixedReviewPercent,
    },
    { name: "CpiRegion", type: TYPES.NVarChar, value: v("CpiRegion") },
    { name: "CpiReferenceQuarterRule", type: TYPES.NVarChar, value: v("CpiReferenceQuarterRule") },
    {
      name: "CpiCapPercent",
      type: TYPES.Decimal,
      value: v("CpiCapPercent"),
      options: DECIMAL_OPTS.CpiCapPercent,
    },
    {
      name: "CpiFloorPercent",
      type: TYPES.Decimal,
      value: v("CpiFloorPercent"),
      options: DECIMAL_OPTS.CpiFloorPercent,
    },
    { name: "ReviewRatchet", type: TYPES.Bit, value: body.ReviewRatchet === true },
    {
      name: "SecurityDepositRequired",
      type: TYPES.NVarChar,
      value: v("SecurityDepositRequired"),
    },
    {
      name: "SecurityDepositMethod",
      type: TYPES.NVarChar,
      value: v("SecurityDepositMethod"),
    },
    {
      name: "SecurityDepositHeld",
      type: TYPES.Decimal,
      value: v("SecurityDepositHeld"),
      options: DECIMAL_OPTS.SecurityDepositHeld,
    },
    { name: "Status", type: TYPES.NVarChar, value: body.Status ?? "current" },
    { name: "Comments", type: TYPES.NVarChar, value: v("Comments") },
    {
      name: "EscalationPercent",
      type: TYPES.Decimal,
      value: v("EscalationPercent"),
      options: DECIMAL_OPTS.EscalationPercent,
    },
    {
      name: "EscalationSchedule",
      type: TYPES.NVarChar,
      value: v("EscalationSchedule"),
    },
    {
      name: "BusinessTenanciesAct",
      type: TYPES.NVarChar,
      value: v("BusinessTenanciesAct"),
    },
    { name: "CreatedById", type: TYPES.NVarChar, value: caller.id },
    { name: "CreatedByName", type: TYPES.NVarChar, value: caller.name },
    { name: "UpdatedById", type: TYPES.NVarChar, value: caller.id },
    { name: "UpdatedByName", type: TYPES.NVarChar, value: caller.name },
  ];
}

function tenantDisplayName(row: SqlRow): string {
  return (row.TradingName as string | null) || (row.LegalName as string | null) || `Tenancy ${row.TenantId}`;
}

/** 409 naming the tenancy that holds a cell (PLAN WP23a, F22d). */
function occupancyHeldResponse(holder: SqlRow, level: string, area: string): HttpResponseInit {
  const name = tenantDisplayName(holder);
  return {
    status: 409,
    jsonBody: {
      error: `${level} · ${area} is held by ${name}. Move it from ${name}, with a reason, to reassign it.`,
      heldBy: {
        name,
        occupancyId: holder.OccupancyId as string,
        tenantId: holder.TenantId as number,
      },
    },
  };
}

const REASON_MAX_CHARS = 2000;

/** undefined = no reassign requested; null = malformed. */
function parseReassign(raw: unknown): { fromTenantId: number; reason: string } | null | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) return null;
  const { FromTenantId, Reason } = raw as Record<string, unknown>;
  if (typeof FromTenantId !== "number" || !Number.isInteger(FromTenantId) || FromTenantId <= 0) return null;
  if (typeof Reason !== "string" || !Reason.trim() || Reason.length > REASON_MAX_CHARS) return null;
  return { fromTenantId: FromTenantId, reason: Reason.trim() };
}

// ── POST /api/upsertOccupancy ────────────────────────────────────────────────
// MERGE-style: insert or update by client-provided OccupancyId. Writes a
// history row inside a transaction so the timeline is always in sync.

async function upsertOccupancy(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const roleCheck = await requireRole(request, [AppRole.ACCOUNTS, AppRole.ACCOUNTS_APPROVAL, AppRole.ADMIN, AppRole.DIRECTOR]);
  if (roleCheck) return roleCheck;

  let connection;
  let body: Record<string, any> | null = null;
  try {
    body = (await request.json()) as Record<string, any>;
    const { OccupancyId, TenantId, BuildingId, Level, Area, SizeSqm, Notes } =
      body;

    if (typeof OccupancyId !== "string" || !OccupancyId) {
      return {
        status: 400,
        jsonBody: { error: "OccupancyId (string UUID) required" },
      };
    }
    if (typeof TenantId !== "number" || typeof BuildingId !== "number") {
      return {
        status: 400,
        jsonBody: { error: "TenantId + BuildingId required" },
      };
    }
    if (typeof Level !== "string" || typeof Area !== "string") {
      return {
        status: 400,
        jsonBody: { error: "Level + Area (strings) required" },
      };
    }
    if (typeof SizeSqm !== "number" || !Number.isFinite(SizeSqm)) {
      return { status: 400, jsonBody: { error: "SizeSqm (number) required" } };
    }
    const reassign = parseReassign(body.Reassign);
    if (reassign === null) {
      return {
        status: 400,
        jsonBody: { error: "Reassign needs FromTenantId and a Reason for moving the area" },
      };
    }

    connection = await createRequestConnection(token);
    const actor = reassign ? await resolveLedgerActor(request, connection) : null;
    if (reassign && !actor) return unauthorizedResponse();

    // Fetch tenant rent fields up-front so the history snapshot is consistent.
    const tenantRows = await executeQuery(
      connection,
      `SELECT RentPerAnnum FROM dbo.Tenants WHERE TenantId = @TenantId`,
      [{ name: "TenantId", type: TYPES.Int, value: TenantId }],
    );
    if (tenantRows.length === 0) {
      return { status: 404, jsonBody: { error: "Tenant not found" } };
    }
    const rentPerAnnum = tenantRows[0].RentPerAnnum as number | null;

    // Effective ID we'll write under. Updated inside the transaction once we
    // know whether a row already exists at this cell; defaults to the
    // client-provided id for the insert path.
    let effectiveOccupancyId = OccupancyId;

    let movedFrom: SqlRow | null = null;
    await beginTransaction(connection);
    try {
      // Look up by either the client OccupancyId OR the cell key
      // (BuildingId + Level + Area). The cell key is what the unique index
      // enforces — re-imports often mint a fresh OccupancyId for the same
      // physical cell, so we need to detect that and update in place rather
      // than fail with a duplicate-key error.
      const existing = await executeQuery(
        connection,
        `SELECT o.OccupancyId, o.TenantId, t.LegalName, t.TradingName
         FROM dbo.TenantOccupancies o WITH (UPDLOCK, ROWLOCK)
         LEFT JOIN dbo.Tenants t ON t.TenantId = o.TenantId
         WHERE o.OccupancyId = @Id
            OR (o.BuildingId = @BuildingId AND o.Level = @Level AND o.Area = @Area)`,
        [
          { name: "Id", type: TYPES.NVarChar, value: OccupancyId },
          { name: "BuildingId", type: TYPES.Int, value: BuildingId },
          { name: "Level", type: TYPES.NVarChar, value: Level },
          { name: "Area", type: TYPES.NVarChar, value: Area },
        ],
      );
      const byId = existing.find((r) => r.OccupancyId === OccupancyId) ?? null;
      const atCell = existing.find((r) => r.OccupancyId !== OccupancyId) ?? null;
      // Moving this area onto a cell another row already holds.
      if (byId && atCell) {
        await rollbackQuietly(connection);
        return occupancyHeldResponse(atCell, Level, Area);
      }
      const target = byId ?? atCell;
      // A cell held by another tenancy only moves on an explicit
      // "Move from {tenant}" with a reason (ledgered as occupancy.reassign).
      if (target && (target.TenantId as number) !== TenantId) {
        if (!reassign || reassign.fromTenantId !== (target.TenantId as number)) {
          await rollbackQuietly(connection);
          return occupancyHeldResponse(target, Level, Area);
        }
        movedFrom = target;
      }
      if (target) {
        effectiveOccupancyId = target.OccupancyId as string;
      }

      if (!target) {
        await executeQuery(
          connection,
          `INSERT INTO dbo.TenantOccupancies (
              OccupancyId, TenantId, BuildingId, Level, Area, SizeSqm, Notes
           )
           VALUES (@Id, @TenantId, @BuildingId, @Level, @Area, @SizeSqm, @Notes)`,
          [
            { name: "Id", type: TYPES.NVarChar, value: effectiveOccupancyId },
            { name: "TenantId", type: TYPES.Int, value: TenantId },
            { name: "BuildingId", type: TYPES.Int, value: BuildingId },
            { name: "Level", type: TYPES.NVarChar, value: Level },
            { name: "Area", type: TYPES.NVarChar, value: Area },
            {
              name: "SizeSqm",
              type: TYPES.Decimal,
              value: SizeSqm,
              options: DECIMAL_OPTS.SizeSqm,
            },
            { name: "Notes", type: TYPES.NVarChar, value: Notes ?? null },
          ],
        );
      } else {
        // Update in place; TenantId changes only on an explicit reassign
        // (checked above).
        await executeQuery(
          connection,
          `UPDATE dbo.TenantOccupancies SET
              TenantId = @TenantId,
              Level = @Level, Area = @Area, SizeSqm = @SizeSqm,
              Notes = @Notes,
              UpdatedAt = SYSUTCDATETIME()
           WHERE OccupancyId = @Id`,
          [
            { name: "Id", type: TYPES.NVarChar, value: effectiveOccupancyId },
            { name: "TenantId", type: TYPES.Int, value: TenantId },
            { name: "Level", type: TYPES.NVarChar, value: Level },
            { name: "Area", type: TYPES.NVarChar, value: Area },
            {
              name: "SizeSqm",
              type: TYPES.Decimal,
              value: SizeSqm,
              options: DECIMAL_OPTS.SizeSqm,
            },
            { name: "Notes", type: TYPES.NVarChar, value: Notes ?? null },
          ],
        );
      }

      // Append history row (cheap per upsert; we can layer a year-end rollup
      // job on top later if the table grows uncomfortably).
      const historyId = randomUuid();
      const snapshot = JSON.stringify({
        OccupancyId: effectiveOccupancyId,
        TenantId,
        BuildingId,
        Level,
        Area,
        SizeSqm,
        Notes,
        RentPerAnnum: rentPerAnnum,
      });
      const today = new Date().toISOString().slice(0, 10);
      await executeQuery(
        connection,
        `INSERT INTO dbo.TenantOccupancyHistory (
            HistoryId, OccupancyId, TenantId, EffectiveFrom,
            SizeSqm, RentPerAnnum, Snapshot
         )
         VALUES (@HistoryId, @OccupancyId, @TenantId, @EffectiveFrom,
                 @SizeSqm, @RentPerAnnum, @Snapshot)`,
        [
          { name: "HistoryId", type: TYPES.NVarChar, value: historyId },
          {
            name: "OccupancyId",
            type: TYPES.NVarChar,
            value: effectiveOccupancyId,
          },
          { name: "TenantId", type: TYPES.Int, value: TenantId },
          { name: "EffectiveFrom", type: TYPES.Date, value: today },
          {
            name: "SizeSqm",
            type: TYPES.Decimal,
            value: SizeSqm,
            options: DECIMAL_OPTS.SizeSqm,
          },
          {
            name: "RentPerAnnum",
            type: TYPES.Decimal,
            value: rentPerAnnum,
            options: DECIMAL_OPTS.RentPerAnnum,
          },
          { name: "Snapshot", type: TYPES.NVarChar, value: snapshot },
        ],
      );

      if (movedFrom && actor && reassign) {
        await ledger.record(connection, {
          action: "occupancy.reassign",
          actor,
          after: { tenantId: TenantId },
          before: {
            tenantId: movedFrom.TenantId as number,
            tenantName: tenantDisplayName(movedFrom),
          },
          buildingId: BuildingId,
          reason: reassign.reason,
          subject: { id: effectiveOccupancyId, type: "occupancy" },
          tenantId: TenantId,
        });
      }

      await commitTransaction(connection);
    } catch (err) {
      await rollbackQuietly(connection);
      throw err;
    }

    const stored = await executeQuery(
      connection,
      `SELECT ${OCCUPANCY_COLUMNS}
       FROM dbo.TenantOccupancies WHERE OccupancyId = @Id`,
      [{ name: "Id", type: TYPES.NVarChar, value: effectiveOccupancyId }],
    );
    invalidateTenantAndBuilding(TenantId, BuildingId);
    if (movedFrom) invalidateTenantAndBuilding(movedFrom.TenantId as number, BuildingId);
    return {
      status: 200,
      jsonBody: { occupancy: occupancyRowToApi(stored[0]) },
    };
  } catch (error: any) {
    const refusal = ledgerRefusal(error);
    if (refusal) return refusal;
    const formatted = formatSqlError(error);
    context.error("upsertOccupancy failed", {
      error: formatted,
      stack: error?.stack,
      payload: summariseBody(body),
    });
    return errorResponse("Upsert occupancy failed", formatted);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── POST /api/deleteOccupancy ────────────────────────────────────────────────

async function deleteOccupancy(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  // A hard delete: admin only until lane D makes it an archive (J4 review).
  const roleCheck = await requireRole(request, ACTION_ROLES.hardDeleteTenancyRows.gate);
  if (roleCheck) return roleCheck;

  let connection;
  try {
    const body = (await request.json()) as { OccupancyId?: string };
    if (typeof body.OccupancyId !== "string") {
      return { status: 400, jsonBody: { error: "OccupancyId required" } };
    }
    connection = await createRequestConnection(token);
    const occRows = await executeQuery(
      connection,
      `SELECT TenantId, BuildingId FROM dbo.TenantOccupancies WHERE OccupancyId = @Id`,
      [{ name: "Id", type: TYPES.NVarChar, value: body.OccupancyId }],
    );
    await executeQuery(
      connection,
      `DELETE FROM dbo.TenantOccupancies WHERE OccupancyId = @Id`,
      [{ name: "Id", type: TYPES.NVarChar, value: body.OccupancyId }],
    );
    if (occRows.length > 0) {
      invalidateTenantAndBuilding(occRows[0].TenantId as number, occRows[0].BuildingId as number);
    }
    return {
      status: 200,
      jsonBody: { deleted: true, occupancyId: body.OccupancyId },
    };
  } catch (error: any) {
    context.error("deleteOccupancy failed:", error.message);
    return errorResponse("Delete occupancy failed", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── POST /api/createTenantNote ───────────────────────────────────────────────

async function createTenantNote(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const roleCheck = await requireRole(request, [AppRole.ACCOUNTS, AppRole.ACCOUNTS_APPROVAL, AppRole.ADMIN, AppRole.DIRECTOR]);
  if (roleCheck) return roleCheck;
  const caller = callerFromToken(token);

  let connection;
  try {
    const body = (await request.json()) as Record<string, any>;
    const { NoteId, TenantId, AnchorKind, OccupancyId, FieldKey, Body } = body;

    if (typeof NoteId !== "string" || !NoteId) {
      return { status: 400, jsonBody: { error: "NoteId required" } };
    }
    if (typeof TenantId !== "number") {
      return { status: 400, jsonBody: { error: "TenantId required" } };
    }
    if (!["tenant", "occupancy", "field"].includes(AnchorKind)) {
      return {
        status: 400,
        jsonBody: { error: "AnchorKind must be tenant|occupancy|field" },
      };
    }
    if (AnchorKind === "occupancy" && typeof OccupancyId !== "string") {
      return {
        status: 400,
        jsonBody: { error: "OccupancyId required for occupancy anchor" },
      };
    }
    if (AnchorKind === "field" && typeof FieldKey !== "string") {
      return {
        status: 400,
        jsonBody: { error: "FieldKey required for field anchor" },
      };
    }
    if (typeof Body !== "string" || !Body.trim()) {
      return { status: 400, jsonBody: { error: "Body (string) required" } };
    }

    connection = await createRequestConnection(token);
    await executeQuery(
      connection,
      `INSERT INTO dbo.TenantNotes
         (NoteId, TenantId, AnchorKind, OccupancyId, FieldKey, Body,
          CreatedById, CreatedByName)
       VALUES (@NoteId, @TenantId, @AnchorKind, @OccupancyId, @FieldKey, @Body,
               @CreatedById, @CreatedByName)`,
      [
        { name: "NoteId", type: TYPES.NVarChar, value: NoteId },
        { name: "TenantId", type: TYPES.Int, value: TenantId },
        { name: "AnchorKind", type: TYPES.NVarChar, value: AnchorKind },
        {
          name: "OccupancyId",
          type: TYPES.NVarChar,
          value: OccupancyId ?? null,
        },
        { name: "FieldKey", type: TYPES.NVarChar, value: FieldKey ?? null },
        { name: "Body", type: TYPES.NVarChar, value: Body },
        { name: "CreatedById", type: TYPES.NVarChar, value: caller.id },
        { name: "CreatedByName", type: TYPES.NVarChar, value: caller.name },
      ],
    );
    const stored = await executeQuery(
      connection,
      `SELECT NoteId, TenantId, AnchorKind, OccupancyId, FieldKey, Body,
              CreatedAt, CreatedById, CreatedByName
       FROM dbo.TenantNotes WHERE NoteId = @Id`,
      [{ name: "Id", type: TYPES.NVarChar, value: NoteId }],
    );
    invalidateTenant(TenantId);
    return { status: 200, jsonBody: { note: noteRowToApi(stored[0]) } };
  } catch (error: any) {
    context.error("createTenantNote failed:", error.message);
    return errorResponse("Create tenant note failed", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── POST /api/deleteTenantNote ───────────────────────────────────────────────

async function deleteTenantNote(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const roleCheck = await requireRole(request, [AppRole.ACCOUNTS, AppRole.ACCOUNTS_APPROVAL, AppRole.ADMIN, AppRole.DIRECTOR]);
  if (roleCheck) return roleCheck;

  let connection;
  try {
    const body = (await request.json()) as { NoteId?: string };
    if (typeof body.NoteId !== "string") {
      return { status: 400, jsonBody: { error: "NoteId required" } };
    }
    connection = await createRequestConnection(token);
    const noteRows = await executeQuery(
      connection,
      `SELECT TenantId FROM dbo.TenantNotes WHERE NoteId = @Id`,
      [{ name: "Id", type: TYPES.NVarChar, value: body.NoteId }],
    );
    await executeQuery(
      connection,
      `DELETE FROM dbo.TenantNotes WHERE NoteId = @Id`,
      [{ name: "Id", type: TYPES.NVarChar, value: body.NoteId }],
    );
    if (noteRows.length > 0) invalidateTenant(noteRows[0].TenantId as number);
    return { status: 200, jsonBody: { deleted: true, noteId: body.NoteId } };
  } catch (error: any) {
    context.error("deleteTenantNote failed:", error.message);
    return errorResponse("Delete tenant note failed", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── POST /api/deleteRegisterTenant ───────────────────────────────────────────
// Body { TenantId }. Hard-deletes an empty draft only (D4, DL-04); anything a
// tenancy holds or has had recorded against it answers 422 "… Archive it
// instead." (jobs keep their 400 "Reassign first"). The rule, the lock and the
// ledger row live in deleteTenancyDraft, shared with deleteTenant.

async function deleteRegisterTenant(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const roleCheck = await requireRole(request, TENANCY_DELETE_ROLES);
  if (roleCheck) return roleCheck;

  const body = (await request.json().catch(() => null)) as { TenantId?: unknown } | null;
  const tenantId = body?.TenantId;
  if (typeof tenantId !== "number") {
    return { status: 400, jsonBody: { error: "TenantId (number) required" } };
  }
  return deleteTenancyDraft(request, context, token, tenantId, "deleteRegisterTenant");
}

// ── GET /api/getReviewsDue[?buildingId=N] ────────────────────────────────────
// Returns amber+red tenants for the dashboard widget and the activity feed,
// plus any lease that expires or reaches its option deadline within 90 days.
// Every role reads it, so each row carries only what those show — never ABN,
// contacts, rent or deposits; the full record stays behind the register's
// accounts-only gate (SEC-05). The option fields are lease terms the due list
// needs to tell an option deadline from a plain expiry.

function reviewDueProjection(tenant: ReturnType<typeof tenantRowToApi>) {
  return {
    buildingId: tenant.buildingId,
    daysToExpiry: tenant.daysToExpiry,
    expiry: tenant.expiry,
    legalName: tenant.legalName,
    nextReviewDate: tenant.nextReviewDate,
    optionNoticeMonths: tenant.optionNoticeMonths,
    optionPeriods: tenant.optionPeriods,
    reviewState: tenant.reviewState,
    reviewType: tenant.reviewType,
    // Whether the schedule is signed off, so the feed can hold back alerts on
    // unverified figures (PLAN D7). The signer's note stays out.
    scheduleSignOff: tenant.scheduleSignOff ? { ...tenant.scheduleSignOff, note: null } : null,
    tenantId: tenant.tenantId,
  };
}

async function getReviewsDue(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const roleCheck = await requireRole(request, [AppRole.ACCOUNTS, AppRole.ACCOUNTS_APPROVAL, AppRole.ADMIN, AppRole.DIRECTOR, AppRole.FACILITIES, AppRole.FACILITIES_APPROVAL, AppRole.USER]);
  if (roleCheck) return roleCheck;

  const buildingIdParam = request.query.get("buildingId");

  let connection;
  try {
    connection = await createRequestConnection(token);
    const where = buildingIdParam ? "WHERE BuildingId = @BuildingId" : "";
    const params = buildingIdParam
      ? [
          {
            name: "BuildingId",
            type: TYPES.Int,
            value: Number(buildingIdParam),
          },
        ]
      : [];
    /* eslint-disable local/no-sql-interpolation -- interpolations are TENANT_COLUMNS (const), `where` (allowlisted parameterized fragment) and a literal AND/WHERE keyword; no user value reaches the SQL text */
    // Also expiries and option deadlines from yesterday to 91 days ahead: a
    // wider net than the Darwin-day filter below, which is exact.
    const rows = await executeQuery(
      connection,
      `SELECT ${TENANT_COLUMNS} FROM dbo.Tenants t
       ${where} ${where ? "AND" : "WHERE"} t.ArchivedAt IS NULL AND (
         (NextReviewDate IS NOT NULL
           AND NextReviewDate <= DATEADD(day, 90, CAST(SYSUTCDATETIME() AS DATE)))
         OR (Expiry IS NOT NULL
           AND Expiry BETWEEN DATEADD(day, -1, CAST(SYSUTCDATETIME() AS DATE))
                          AND DATEADD(day, 91, CAST(SYSUTCDATETIME() AS DATE)))
         OR (Expiry IS NOT NULL AND OptionNoticeMonths IS NOT NULL
           AND DATEADD(month, -OptionNoticeMonths, Expiry)
               BETWEEN DATEADD(day, -1, CAST(SYSUTCDATETIME() AS DATE))
                   AND DATEADD(day, 91, CAST(SYSUTCDATETIME() AS DATE)))
       )
        AND Status <> 'vacated'
       ORDER BY NextReviewDate`,
      params,
    );
    /* eslint-enable local/no-sql-interpolation */
    // The SQL reads the stored date; a keyed review whose date has since passed
    // has moved on, so keep only what is still due or overdue today, plus any
    // lease that expires or reaches its option deadline within 90 days.
    const today = todayInDarwin();
    const tenants = rows
      .map((row) => tenantRowToApi(row, [], {}))
      .filter(
        (tenant) =>
          tenant.reviewState === "amber" ||
          tenant.reviewState === "red" ||
          hasLeaseEventWithin(tenant, today),
      )
      .map(reviewDueProjection);
    return { status: 200, jsonBody: { tenants } };
  } catch (error: any) {
    context.error("getReviewsDue failed:", error.message);
    return errorResponse("Failed to fetch reviews due", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── GET /api/getPortfolioOccupancy ───────────────────────────────────────────
// One row per building with total SQM, active SQM and occupancy %. Active =
// tenants in status 'current' or 'holdover' (mirrors TenancySummary on the
// register page). Buildings with no tenant rows are omitted; the client falls
// back to 0 / no value for those.

async function getPortfolioOccupancy(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const roleCheck = await requireRole(request, [AppRole.ACCOUNTS, AppRole.ACCOUNTS_APPROVAL, AppRole.ADMIN, AppRole.DIRECTOR, AppRole.FACILITIES, AppRole.FACILITIES_APPROVAL]);
  if (roleCheck) return roleCheck;

  let connection;
  try {
    connection = await createRequestConnection(token);
    const rows = await executeQuery(
      connection,
      `SELECT t.BuildingId,
              SUM(CASE WHEN t.Status IN ('current','holdover')
                       THEN occ.TenantSqm ELSE 0 END) AS ActiveSqm,
              SUM(occ.TenantSqm) AS TotalSqm,
              SUM(CASE WHEN t.Status IN ('current','holdover')
                       THEN t.RentPerAnnum ELSE 0 END) AS AnnualRent,
              SUM(CASE WHEN t.Status IN ('current','holdover')
                       THEN 1 ELSE 0 END) AS ActiveTenantCount,
              SUM(CASE WHEN t.Status IN ('current','holdover')
                            AND t.ScheduleSignedOffAt IS NULL
                       THEN 1 ELSE 0 END) AS UnsignedTenantCount,
              SUM(CASE WHEN t.Status IN ('current','holdover')
                            AND t.Expiry IS NOT NULL
                       THEN occ.TenantSqm
                            * DATEDIFF(day, CAST(GETDATE() AS DATE), t.Expiry)
                       ELSE 0 END) AS WaleNumeratorSqmDays,
              SUM(CASE WHEN t.Status IN ('current','holdover')
                            AND t.Expiry IS NOT NULL
                       THEN occ.TenantSqm ELSE 0 END) AS WaleDenominatorSqm
       FROM dbo.Tenants t
       INNER JOIN (
         SELECT TenantId, SUM(SizeSqm) AS TenantSqm
         FROM dbo.TenantOccupancies
         GROUP BY TenantId
       ) occ ON occ.TenantId = t.TenantId
       WHERE t.ArchivedAt IS NULL
       GROUP BY t.BuildingId`,
      [],
    );

    // WP26c: changes awaiting a director across the portfolio, dates and names
    // only: facilities read these figures too.
    const pending = await loadPendingChanges(connection, { all: true }, "dates_only");
    const buildings = rows.map((r) => {
      const totalSqm = Number(r.TotalSqm) || 0;
      const activeSqm = Number(r.ActiveSqm) || 0;
      const annualRent = Number(r.AnnualRent) || 0;
      const activeTenantCount = Number(r.ActiveTenantCount) || 0;
      const waleNumerator = Number(r.WaleNumeratorSqmDays) || 0;
      const waleDenominator = Number(r.WaleDenominatorSqm) || 0;
      const waleYears =
        waleDenominator > 0 ? waleNumerator / waleDenominator / 365.25 : 0;
      return {
        activeSqm,
        activeTenantCount,
        annualRent,
        buildingId: r.BuildingId as number,
        occupancyPercent: totalSqm > 0 ? (activeSqm / totalSqm) * 100 : 0,
        // The building's changes awaiting a director (WP26c): "Includes {n} changes awaiting a director".
        pendingChangeCount: pending.filter((item) => item.buildingId === Number(r.BuildingId)).length,
        totalSqm,
        // Active tenancies whose schedule nobody has signed off yet (PLAN D7).
        unsignedTenantCount: Number(r.UnsignedTenantCount) || 0,
        waleExpirySqm: waleDenominator,
        waleYears,
      };
    });

    return { status: 200, jsonBody: { buildings, pendingChanges: pendingChangesOf(pending) } };
  } catch (error: any) {
    context.error("getPortfolioOccupancy failed:", error.message);
    return errorResponse("Failed to fetch portfolio occupancy", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── POST /api/upsertTenantIncentive ──────────────────────────────────────────
// Adds a new incentive or replaces an existing one (by id) on the tenant's
// Incentives JSON column. Role-gated (Admin, facilities), rate-limited per
// caller OID, and validated before any SQL runs.

const INCENTIVE_RATE_LIMIT = { limit: 30, windowMs: 60_000 };

async function reloadFullTenant(
  connection: Connection,
  tenantId: number,
): Promise<RegisterTenantApi | null> {
  // Mirror getRegisterTenant's joined load so callers get the full
  // tenant payload back from a mutation. We do the cheaper subset (skip
  // notes/reviews/history) because the frontend re-uses the cached
  // detail-query response for those and only patches the tenant row.
  const tenantRows = await executeQuery(
    connection,
    `SELECT ${TENANT_COLUMNS} FROM dbo.Tenants t WHERE TenantId = @TenantId`,
    [{ name: "TenantId", type: TYPES.Int, value: tenantId }],
  );
  if (tenantRows.length === 0) return null;
  const occupancyRows = await executeQuery(
    connection,
    `SELECT ${OCCUPANCY_COLUMNS} FROM dbo.TenantOccupancies WHERE TenantId = @TenantId
     ORDER BY Level, Area`,
    [{ name: "TenantId", type: TYPES.Int, value: tenantId }],
  );
  const occupancies = occupancyRows.map(occupancyRowToApi);
  return tenantRowToApi(tenantRows[0], occupancies, {});
}

async function upsertTenantIncentive(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const roleCheck = await requireRole(request, [AppRole.ACCOUNTS, AppRole.ACCOUNTS_APPROVAL, AppRole.ADMIN, AppRole.DIRECTOR]);
  if (roleCheck) return roleCheck;

  const caller = callerFromToken(token);
  const rl = checkRateLimit(`incentive:${caller.id}`, INCENTIVE_RATE_LIMIT);
  if (!rl.allowed) {
    return {
      status: 429,
      headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) },
      jsonBody: { error: "Rate limit exceeded" },
    };
  }

  let connection;
  let body: Record<string, any> | null = null;
  try {
    body = (await request.json()) as Record<string, any>;
    const parsed = validateUpsertEnvelope(body);
    if (!parsed.ok) {
      return { status: 400, jsonBody: { error: parsed.error } };
    }
    const expectedVersion = parseExpectedVersion(body.ScheduleVersion);
    if (expectedVersion === null) return { status: 400, jsonBody: { error: "ScheduleVersion must be a non-negative integer" } };
    const { TenantId, BuildingId, incentive } = parsed;

    connection = await createRequestConnection(token);
    const actor = await resolveLedgerActor(request, connection);
    if (!actor) return unauthorizedResponse();
    const outcome = await runScheduleWrite(
      connection,
      { actor, buildingId: BuildingId, expectedVersion, signOffClearReason: readSignOffClearReason(body), tenantId: TenantId, updatedById: caller.id },
      (locked) => {
        const existing = parseIncentives(locked.Incentives as string | null | undefined);
        const before = existing.find((i) => i.id === incentive.id) ?? null;
        const next = upsertIncentive(existing, incentive);
        return {
          column: "Incentives",
          kind: "write",
          ledgerEntries: [
            { action: "schedule.manual_edit", after: incentive, before, subject: { id: incentive.id, type: "incentive" } },
          ],
          result: null,
          value: next,
        };
      },
    );
    if (outcome.kind !== "ok") return scheduleWriteResponse(outcome, () => ({}));

    const tenant = await reloadFullTenant(connection, TenantId);
    if (!tenant) {
      return {
        status: 404,
        jsonBody: { error: "Tenant disappeared after upsert" },
      };
    }
    invalidateTenantAndBuilding(TenantId, BuildingId);
    return { status: 200, jsonBody: { tenant } };
  } catch (error: any) {
    const refusal = ledgerRefusal(error);
    if (refusal) return refusal;
    const formatted = formatSqlError(error);
    context.error("upsertTenantIncentive failed", {
      error: formatted,
      payload: summariseBody(body),
      stack: error?.stack,
    });
    return errorResponse("Upsert tenant incentive failed", formatted);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── POST /api/deleteTenantIncentive ──────────────────────────────────────────

async function deleteTenantIncentive(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const roleCheck = await requireRole(request, [AppRole.ACCOUNTS, AppRole.ACCOUNTS_APPROVAL, AppRole.ADMIN, AppRole.DIRECTOR]);
  if (roleCheck) return roleCheck;

  const caller = callerFromToken(token);
  const rl = checkRateLimit(`incentive:${caller.id}`, INCENTIVE_RATE_LIMIT);
  if (!rl.allowed) {
    return {
      status: 429,
      headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) },
      jsonBody: { error: "Rate limit exceeded" },
    };
  }

  let connection;
  let body: Record<string, any> | null = null;
  try {
    body = (await request.json()) as Record<string, any>;
    const parsed = validateDeleteEnvelope(body);
    if (!parsed.ok) {
      return { status: 400, jsonBody: { error: parsed.error } };
    }
    const expectedVersion = parseExpectedVersion(body.ScheduleVersion);
    if (expectedVersion === null) return { status: 400, jsonBody: { error: "ScheduleVersion must be a non-negative integer" } };
    const { TenantId, BuildingId, incentiveId } = parsed;

    connection = await createRequestConnection(token);
    const actor = await resolveLedgerActor(request, connection);
    if (!actor) return unauthorizedResponse();
    const outcome = await runScheduleWrite(
      connection,
      { actor, buildingId: BuildingId, expectedVersion, signOffClearReason: readSignOffClearReason(body), tenantId: TenantId, updatedById: caller.id },
      (locked) => {
        const existing = parseIncentives(locked.Incentives as string | null | undefined);
        const before = existing.find((i) => i.id === incentiveId);
        const next = deleteIncentive(existing, incentiveId);
        if (next === NOT_FOUND || !before) return { error: "Incentive not found", kind: "reject", status: 404 };
        return {
          column: "Incentives",
          kind: "write",
          ledgerEntries: [
            { action: "schedule.manual_edit", after: null, before, subject: { id: incentiveId, type: "incentive" } },
          ],
          result: null,
          value: next,
        };
      },
    );
    if (outcome.kind !== "ok") return scheduleWriteResponse(outcome, () => ({}));

    const tenant = await reloadFullTenant(connection, TenantId);
    if (!tenant) {
      return {
        status: 404,
        jsonBody: { error: "Tenant disappeared after delete" },
      };
    }
    invalidateTenantAndBuilding(TenantId, BuildingId);
    return { status: 200, jsonBody: { tenant } };
  } catch (error: any) {
    const refusal = ledgerRefusal(error);
    if (refusal) return refusal;
    const formatted = formatSqlError(error);
    context.error("deleteTenantIncentive failed", {
      error: formatted,
      payload: summariseBody(body),
      stack: error?.stack,
    });
    return errorResponse("Delete tenant incentive failed", formatted);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── Rent schedule change log (writer: rentScheduleChangeLog.ts) ──────────────

function changeLogRowToApi(row: SqlRow) {
  return {
    changeId: row.ChangeId as string,
    tenantId: row.TenantId as number,
    buildingId: row.BuildingId as number,
    stepId: row.StepId as string,
    changeKind: row.ChangeKind as "added" | "updated" | "deleted",
    changedAt: toIso(row.ChangedAt),
    changedBy: {
      id: (row.ChangedById ?? "") as string,
      name: (row.ChangedByName ?? "") as string,
    },
    stepSnapshot: JSON.parse(row.StepSnapshot as string) as ScheduledRateStep,
    diff: row.Diff ? (JSON.parse(row.Diff as string) as StepDiff) : null,
  };
}

// ── POST /api/upsertScheduledRateStep ────────────────────────────────────────

const STEP_RATE_LIMIT = { limit: 30, windowMs: 60_000 };

/** The row keeps the exemption it had, exactly (key order aside). */
function ratchetExemptionKept(before: ScheduledRateStep["ratchetExempt"], after: ScheduledRateStep["ratchetExempt"]): boolean {
  return !!before && !!after && before.at === after.at && before.byName === after.byName && before.reason === after.reason;
}

async function upsertScheduledRateStep(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const roleCheck = await requireRole(request, [AppRole.ACCOUNTS, AppRole.ACCOUNTS_APPROVAL, AppRole.ADMIN, AppRole.DIRECTOR]);
  if (roleCheck) return roleCheck;

  const caller = callerFromToken(token);
  const rl = checkRateLimit(`step:${caller.id}`, STEP_RATE_LIMIT);
  if (!rl.allowed) {
    return {
      status: 429,
      headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) },
      jsonBody: { error: "Rate limit exceeded" },
    };
  }

  let connection;
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const parsed = validateUpsertStepEnvelope(body);
    if (!parsed.ok) return { status: 400, jsonBody: { error: parsed.error } };
    const expectedVersion = parseExpectedVersion(body.ScheduleVersion);
    if (expectedVersion === null) return { status: 400, jsonBody: { error: "ScheduleVersion must be a non-negative integer" } };
    const { TenantId, BuildingId, step } = parsed;

    connection = await createRequestConnection(token);
    const actor = await resolveLedgerActor(request, connection);
    if (!actor) return unauthorizedResponse();
    let changeId = "";
    const outcome = await runScheduleWrite(
      connection,
      { actor, buildingId: BuildingId, expectedVersion, signOffClearReason: readSignOffClearReason(body), tenantId: TenantId, updatedById: caller.id },
      (locked) => {
        const existing = parseSteps(locked.ScheduledRateSteps as string | null);
        const oldStep = existing.find((s) => s.id === step.id) ?? null;
        // A ratchet exemption is a director's override (C9, D23), written only by
        // a rent review approved with the lease's ratchet overridden. An edit may
        // keep one as it is or take it off (the ratchet then holds the row again),
        // never add or change one.
        if (step.ratchetExempt && !ratchetExemptionKept(oldStep?.ratchetExempt, step.ratchetExempt)) {
          return {
            error: "A ratchet exemption is a director's override: it is written when a director approves a rent review with the lease's ratchet overridden, not by editing the row",
            kind: "reject",
            status: 403,
          };
        }
        // Adding a row closes the open-ended row before it (effectiveTo is exclusive).
        const { closed, steps: withClosed } = closeOpenPredecessor(existing, step);
        const next = normaliseLegacyEnds(upsertStep(withClosed, step));
        const saved = next.find((s) => s.id === step.id) ?? step;
        const ledgerEntries: LedgerDraft[] = [
          { action: "schedule.manual_edit", after: saved, before: oldStep, subject: { id: step.id, type: "rate_step" } },
        ];
        if (closed) {
          ledgerEntries.push({
            action: "schedule.manual_edit",
            after: closed.after,
            before: closed.before,
            subject: { id: closed.after.id, type: "rate_step" },
          });
        }
        return {
          afterUpdate: async (conn) => {
            changeId = await insertRentScheduleChangeLog(conn, {
              buildingId: BuildingId,
              changeKind: oldStep ? "updated" : "added",
              changedById: caller.id,
              changedByName: caller.name,
              diff: oldStep ? diffSteps(oldStep, saved) : null,
              stepId: step.id,
              stepSnapshot: saved,
              tenantId: TenantId,
            });
            if (closed) {
              await insertRentScheduleChangeLog(conn, {
                buildingId: BuildingId,
                changeKind: "updated",
                changedById: caller.id,
                changedByName: caller.name,
                diff: diffSteps(closed.before, closed.after),
                stepId: closed.after.id,
                stepSnapshot: closed.after,
                tenantId: TenantId,
              });
            }
          },
          column: "ScheduledRateSteps",
          kind: "write",
          ledgerEntries,
          result: next,
          value: next,
        };
      },
    );
    if (outcome.kind === "ok") invalidateTenantAndBuilding(TenantId, BuildingId);
    return scheduleWriteResponse(outcome, (steps) => ({ changeId, steps }));
  } catch (error: any) {
    const refusal = ledgerRefusal(error);
    if (refusal) return refusal;
    context.error("upsertScheduledRateStep failed:", error.message);
    return errorResponse("Failed to upsert scheduled rate step", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── POST /api/deleteScheduledRateStep ────────────────────────────────────────

async function deleteScheduledRateStep(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const roleCheck = await requireRole(request, [AppRole.ACCOUNTS, AppRole.ACCOUNTS_APPROVAL, AppRole.ADMIN, AppRole.DIRECTOR]);
  if (roleCheck) return roleCheck;

  const caller = callerFromToken(token);
  const rl = checkRateLimit(`step:${caller.id}`, STEP_RATE_LIMIT);
  if (!rl.allowed) {
    return {
      status: 429,
      headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) },
      jsonBody: { error: "Rate limit exceeded" },
    };
  }

  let connection;
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const parsed = validateDeleteStepEnvelope(body);
    if (!parsed.ok) return { status: 400, jsonBody: { error: parsed.error } };
    const expectedVersion = parseExpectedVersion(body.ScheduleVersion);
    if (expectedVersion === null) return { status: 400, jsonBody: { error: "ScheduleVersion must be a non-negative integer" } };
    const { TenantId, BuildingId, stepId } = parsed;

    connection = await createRequestConnection(token);
    const actor = await resolveLedgerActor(request, connection);
    if (!actor) return unauthorizedResponse();
    let changeId = "";
    const outcome = await runScheduleWrite(
      connection,
      { actor, buildingId: BuildingId, expectedVersion, signOffClearReason: readSignOffClearReason(body), tenantId: TenantId, updatedById: caller.id },
      (locked) => {
        const existing = parseSteps(locked.ScheduledRateSteps as string | null);
        const deletedStep = existing.find((s) => s.id === stepId);
        const next = deleteStep(existing, stepId);
        if (next === STEP_NOT_FOUND || !deletedStep) return { error: "Step not found", kind: "reject", status: 404 };
        return {
          afterUpdate: async (conn) => {
            changeId = await insertRentScheduleChangeLog(conn, {
              buildingId: BuildingId,
              changeKind: "deleted",
              changedById: caller.id,
              changedByName: caller.name,
              diff: null,
              stepId,
              stepSnapshot: deletedStep,
              tenantId: TenantId,
            });
          },
          column: "ScheduledRateSteps",
          kind: "write",
          ledgerEntries: [
            { action: "schedule.manual_edit", after: null, before: deletedStep, subject: { id: stepId, type: "rate_step" } },
          ],
          result: next,
          value: next,
        };
      },
    );
    if (outcome.kind === "ok") invalidateTenantAndBuilding(TenantId, BuildingId);
    return scheduleWriteResponse(outcome, (steps) => ({ changeId, steps }));
  } catch (error: any) {
    const refusal = ledgerRefusal(error);
    if (refusal) return refusal;
    context.error("deleteScheduledRateStep failed:", error.message);
    return errorResponse("Failed to delete scheduled rate step", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── UUID helper (fallback when crypto.randomUUID isn't available) ────────────

function randomUuid(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// ── Carparks (m053) ──────────────────────────────────────────────────────────
// Building-level bays allocated to a register tenant OR to one of the
// non-tenant sentinel kinds (vacant / notAvailable / randazzo). Rent is
// canonicalised as RentPerAnnum; the UI derives monthly/weekly.

type CarparkAllocationKind = "tenant" | "vacant" | "notAvailable" | "randazzo";

interface CarparkApi {
  allocationKind: CarparkAllocationKind;
  buildingId: number;
  carparkId: string;
  comments?: string;
  createdAt: string;
  identifier: string;
  rentPerAnnum?: number;
  tenantId?: number;
  type: string;
  updatedAt: string;
}

const CARPARK_COLUMNS = `
  CarparkId, BuildingId, Type, Identifier,
  AllocationKind, TenantId, RentPerAnnum, Comments,
  CreatedAt, UpdatedAt
`;

const ALLOCATION_KINDS: ReadonlySet<CarparkAllocationKind> = new Set([
  "tenant",
  "vacant",
  "notAvailable",
  "randazzo",
]);

function carparkRowToApi(row: SqlRow): CarparkApi {
  return {
    allocationKind: row.AllocationKind as CarparkAllocationKind,
    buildingId: row.BuildingId as number,
    carparkId: row.CarparkId as string,
    comments: asStr(row.Comments),
    createdAt: toIso(row.CreatedAt),
    identifier: row.Identifier as string,
    rentPerAnnum: asNum(row.RentPerAnnum),
    tenantId: asNum(row.TenantId),
    type: row.Type as string,
    updatedAt: toIso(row.UpdatedAt),
  };
}

interface CarparkUpsertRow {
  CarparkId: string;
  BuildingId: number;
  Type: string;
  Identifier: string;
  AllocationKind: CarparkAllocationKind;
  TenantId: number | null;
  RentPerAnnum: number | null;
  Comments: string | null;
}

// Pull a single carpark payload out of an arbitrary body. Used by both
// upsertCarpark (one row) and upsertCarparksBulk (many rows) — keeps
// validation consistent across the two routes.
function parseCarparkPayload(
  raw: Record<string, any>,
): { error: string } | { value: CarparkUpsertRow } {
  const {
    CarparkId,
    BuildingId,
    Type,
    Identifier,
    AllocationKind,
    TenantId,
    RentPerAnnum,
    Comments,
  } = raw;

  if (typeof CarparkId !== "string" || !CarparkId) {
    return { error: "CarparkId (string UUID) required" };
  }
  if (typeof BuildingId !== "number") return { error: "BuildingId required" };
  if (typeof Type !== "string" || !Type) return { error: "Type required" };
  if (typeof Identifier !== "string" || !Identifier.trim()) {
    return { error: "Identifier required" };
  }
  if (
    typeof AllocationKind !== "string" ||
    !ALLOCATION_KINDS.has(AllocationKind as CarparkAllocationKind)
  ) {
    return {
      error:
        "AllocationKind must be one of tenant/vacant/notAvailable/randazzo",
    };
  }
  const kind = AllocationKind as CarparkAllocationKind;
  if (kind === "tenant" && typeof TenantId !== "number") {
    return { error: "TenantId required when AllocationKind = tenant" };
  }
  if (kind !== "tenant" && TenantId != null) {
    return { error: "TenantId must be null when AllocationKind != tenant" };
  }
  if (
    RentPerAnnum != null &&
    (typeof RentPerAnnum !== "number" || !Number.isFinite(RentPerAnnum))
  ) {
    return { error: "RentPerAnnum must be a finite number or null" };
  }

  return {
    value: {
      CarparkId,
      BuildingId,
      Type,
      Identifier: Identifier.trim(),
      AllocationKind: kind,
      TenantId: kind === "tenant" ? (TenantId as number) : null,
      RentPerAnnum: RentPerAnnum != null ? (RentPerAnnum as number) : null,
      Comments:
        typeof Comments === "string" && Comments.length > 0 ? Comments : null,
    },
  };
}

async function upsertCarparkRow(
  connection: Connection,
  v: CarparkUpsertRow,
): Promise<CarparkApi> {
  // Look up by either the client CarparkId OR the unique (BuildingId,
  // Identifier) — mirrors the upsertOccupancy pattern so re-imports with a
  // fresh client UUID find the existing bay rather than collide on the index.
  const existing = await executeQuery(
    connection,
    `SELECT TOP 1 CarparkId
     FROM dbo.Carparks
     WHERE CarparkId = @Id
        OR (BuildingId = @BuildingId AND Identifier = @Identifier)
     ORDER BY CASE WHEN CarparkId = @Id THEN 0 ELSE 1 END`,
    [
      { name: "Id", type: TYPES.NVarChar, value: v.CarparkId },
      { name: "BuildingId", type: TYPES.Int, value: v.BuildingId },
      { name: "Identifier", type: TYPES.NVarChar, value: v.Identifier },
    ],
  );
  const effectiveId =
    existing.length > 0 ? (existing[0].CarparkId as string) : v.CarparkId;

  if (existing.length === 0) {
    await executeQuery(
      connection,
      `INSERT INTO dbo.Carparks (
          CarparkId, BuildingId, Type, Identifier,
          AllocationKind, TenantId, RentPerAnnum, Comments
       )
       VALUES (@Id, @BuildingId, @Type, @Identifier,
               @AllocationKind, @TenantId, @RentPerAnnum, @Comments)`,
      [
        { name: "Id", type: TYPES.NVarChar, value: effectiveId },
        { name: "BuildingId", type: TYPES.Int, value: v.BuildingId },
        { name: "Type", type: TYPES.NVarChar, value: v.Type },
        { name: "Identifier", type: TYPES.NVarChar, value: v.Identifier },
        {
          name: "AllocationKind",
          type: TYPES.NVarChar,
          value: v.AllocationKind,
        },
        { name: "TenantId", type: TYPES.Int, value: v.TenantId },
        {
          name: "RentPerAnnum",
          type: TYPES.Decimal,
          value: v.RentPerAnnum,
          options: DECIMAL_OPTS.RentPerAnnum,
        },
        { name: "Comments", type: TYPES.NVarChar, value: v.Comments },
      ],
    );
  } else {
    await executeQuery(
      connection,
      `UPDATE dbo.Carparks SET
          Type = @Type,
          Identifier = @Identifier,
          AllocationKind = @AllocationKind,
          TenantId = @TenantId,
          RentPerAnnum = @RentPerAnnum,
          Comments = @Comments,
          UpdatedAt = SYSUTCDATETIME()
       WHERE CarparkId = @Id`,
      [
        { name: "Id", type: TYPES.NVarChar, value: effectiveId },
        { name: "Type", type: TYPES.NVarChar, value: v.Type },
        { name: "Identifier", type: TYPES.NVarChar, value: v.Identifier },
        {
          name: "AllocationKind",
          type: TYPES.NVarChar,
          value: v.AllocationKind,
        },
        { name: "TenantId", type: TYPES.Int, value: v.TenantId },
        {
          name: "RentPerAnnum",
          type: TYPES.Decimal,
          value: v.RentPerAnnum,
          options: DECIMAL_OPTS.RentPerAnnum,
        },
        { name: "Comments", type: TYPES.NVarChar, value: v.Comments },
      ],
    );
  }

  const stored = await executeQuery(
    connection,
    `SELECT ${CARPARK_COLUMNS} FROM dbo.Carparks WHERE CarparkId = @Id`,
    [{ name: "Id", type: TYPES.NVarChar, value: effectiveId }],
  );
  return carparkRowToApi(stored[0]);
}

// ── GET /api/getCarparks?buildingId=N ────────────────────────────────────────

async function getCarparks(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const roleCheck = await requireRole(request, [AppRole.ACCOUNTS, AppRole.ACCOUNTS_APPROVAL, AppRole.ADMIN, AppRole.DIRECTOR]);
  if (roleCheck) return roleCheck;

  let connection;
  try {
    const buildingIdRaw = request.query.get("buildingId");
    const buildingId = buildingIdRaw ? Number(buildingIdRaw) : NaN;
    if (!Number.isFinite(buildingId)) {
      return { status: 400, jsonBody: { error: "buildingId required" } };
    }

    connection = await createRequestConnection(token);
    const rows = await executeQuery(
      connection,
      `SELECT ${CARPARK_COLUMNS}
       FROM dbo.Carparks
       WHERE BuildingId = @BuildingId
       ORDER BY Identifier`,
      [{ name: "BuildingId", type: TYPES.Int, value: buildingId }],
    );
    return {
      status: 200,
      jsonBody: { carparks: rows.map(carparkRowToApi) },
    };
  } catch (error: any) {
    context.error("getCarparks failed:", error.message);
    return errorResponse("Fetch carparks failed", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── POST /api/upsertCarpark ──────────────────────────────────────────────────

async function upsertCarpark(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const roleCheck = await requireRole(request, [AppRole.ACCOUNTS, AppRole.ACCOUNTS_APPROVAL, AppRole.ADMIN, AppRole.DIRECTOR]);
  if (roleCheck) return roleCheck;

  let connection;
  let body: Record<string, any> | null = null;
  try {
    body = (await request.json()) as Record<string, any>;
    const parsed = parseCarparkPayload(body);
    if ("error" in parsed) {
      return { status: 400, jsonBody: { error: parsed.error } };
    }

    connection = await createRequestConnection(token);
    const carpark = await upsertCarparkRow(connection, parsed.value);
    return { status: 200, jsonBody: { carpark } };
  } catch (error: any) {
    const formatted = formatSqlError(error);
    context.error("upsertCarpark failed", {
      error: formatted,
      payload: summariseBody(body),
      stack: error?.stack,
    });
    return errorResponse("Upsert carpark failed", formatted);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── POST /api/upsertCarparksBulk ─────────────────────────────────────────────
// Bulk-add path for "add 12 bays in one go". Each row is upserted under a
// single connection — partial failures return per-row results so the UI can
// surface a "added 10 of 12 — 2 failed" message rather than rolling the
// whole batch back.

async function upsertCarparksBulk(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const roleCheck = await requireRole(request, [AppRole.ACCOUNTS, AppRole.ACCOUNTS_APPROVAL, AppRole.ADMIN, AppRole.DIRECTOR]);
  if (roleCheck) return roleCheck;

  let connection;
  let body: any = null;
  try {
    body = await request.json();
    const rows: any[] = Array.isArray(body?.Carparks) ? body.Carparks : [];
    if (rows.length === 0) {
      return {
        status: 400,
        jsonBody: { error: "Carparks (non-empty array) required" },
      };
    }

    connection = await createRequestConnection(token);

    const results: Array<
      | { ok: true; carpark: CarparkApi }
      | { ok: false; error: string; identifier?: string }
    > = [];
    for (const row of rows) {
      const parsed = parseCarparkPayload(row);
      if ("error" in parsed) {
        results.push({
          ok: false,
          error: parsed.error,
          identifier: row?.Identifier,
        });
        continue;
      }
      try {
        const carpark = await upsertCarparkRow(connection, parsed.value);
        results.push({ ok: true, carpark });
      } catch (err: any) {
        results.push({
          ok: false,
          error: formatSqlError(err),
          identifier: parsed.value.Identifier,
        });
      }
    }

    const okCount = results.filter((r) => r.ok).length;
    return {
      status: 200,
      jsonBody: {
        results,
        successCount: okCount,
        failureCount: results.length - okCount,
      },
    };
  } catch (error: any) {
    const formatted = formatSqlError(error);
    context.error("upsertCarparksBulk failed", {
      error: formatted,
      stack: error?.stack,
    });
    return errorResponse("Bulk upsert carparks failed", formatted);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── POST /api/deleteCarpark ──────────────────────────────────────────────────

async function deleteCarpark(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  // A hard delete: admin only until lane D makes it an archive (J4 review).
  const roleCheck = await requireRole(request, ACTION_ROLES.hardDeleteTenancyRows.gate);
  if (roleCheck) return roleCheck;

  let connection;
  try {
    const body = (await request.json()) as { CarparkId?: string };
    if (typeof body.CarparkId !== "string" || !body.CarparkId) {
      return { status: 400, jsonBody: { error: "CarparkId required" } };
    }
    connection = await createRequestConnection(token);
    await executeQuery(
      connection,
      `DELETE FROM dbo.Carparks WHERE CarparkId = @Id`,
      [{ name: "Id", type: TYPES.NVarChar, value: body.CarparkId }],
    );
    return {
      status: 200,
      jsonBody: { deleted: true, carparkId: body.CarparkId },
    };
  } catch (error: any) {
    context.error("deleteCarpark failed:", error.message);
    return errorResponse("Delete carpark failed", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── POST /api/upsertCarparkScheduleGroup ─────────────────────────────────────

const GROUP_RATE_LIMIT = { limit: 30, windowMs: 60_000 };

async function upsertCarparkScheduleGroup(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const roleCheck = await requireRole(request, [AppRole.ACCOUNTS, AppRole.ACCOUNTS_APPROVAL, AppRole.ADMIN, AppRole.DIRECTOR]);
  if (roleCheck) return roleCheck;

  const caller = callerFromToken(token);
  const rl = checkRateLimit(`group:${caller.id}`, GROUP_RATE_LIMIT);
  if (!rl.allowed) {
    return {
      status: 429,
      headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) },
      jsonBody: { error: "Rate limit exceeded" },
    };
  }

  let connection;
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const parsed = validateUpsertGroupEnvelope(body);
    if (!parsed.ok) return { status: 400, jsonBody: { error: parsed.error } };
    const expectedVersion = parseExpectedVersion(body.ScheduleVersion);
    if (expectedVersion === null) return { status: 400, jsonBody: { error: "ScheduleVersion must be a non-negative integer" } };
    const { TenantId, BuildingId, group } = parsed;

    connection = await createRequestConnection(token);
    const actor = await resolveLedgerActor(request, connection);
    if (!actor) return unauthorizedResponse();
    const outcome = await runScheduleWrite(
      connection,
      { actor, buildingId: BuildingId, expectedVersion, signOffClearReason: readSignOffClearReason(body), tenantId: TenantId, updatedById: caller.id },
      (locked) => {
        const existing = parseGroups(locked.CarparkScheduleGroups as string | null);
        const before = existing.find((g) => g.id === group.id) ?? null;
        const next = upsertGroup(existing, group);
        return {
          column: "CarparkScheduleGroups",
          kind: "write",
          ledgerEntries: [
            { action: "schedule.manual_edit", after: group, before, subject: { id: group.id, type: "carpark_group" } },
          ],
          result: next,
          value: next,
        };
      },
    );
    if (outcome.kind === "ok") invalidateTenantAndBuilding(TenantId, BuildingId);
    return scheduleWriteResponse(outcome, (groups) => ({ groups }));
  } catch (error: any) {
    const refusal = ledgerRefusal(error);
    if (refusal) return refusal;
    context.error("upsertCarparkScheduleGroup failed:", error.message);
    return errorResponse(
      "Failed to upsert carpark schedule group",
      error.message,
    );
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── POST /api/deleteCarparkScheduleGroup ─────────────────────────────────────

async function deleteCarparkScheduleGroup(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const roleCheck = await requireRole(request, [AppRole.ACCOUNTS, AppRole.ACCOUNTS_APPROVAL, AppRole.ADMIN, AppRole.DIRECTOR]);
  if (roleCheck) return roleCheck;

  const caller = callerFromToken(token);
  const rl = checkRateLimit(`group:${caller.id}`, GROUP_RATE_LIMIT);
  if (!rl.allowed) {
    return {
      status: 429,
      headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) },
      jsonBody: { error: "Rate limit exceeded" },
    };
  }

  let connection;
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const parsed = validateDeleteGroupEnvelope(body);
    if (!parsed.ok) return { status: 400, jsonBody: { error: parsed.error } };
    const expectedVersion = parseExpectedVersion(body.ScheduleVersion);
    if (expectedVersion === null) return { status: 400, jsonBody: { error: "ScheduleVersion must be a non-negative integer" } };
    const { TenantId, BuildingId, groupId } = parsed;

    connection = await createRequestConnection(token);
    const actor = await resolveLedgerActor(request, connection);
    if (!actor) return unauthorizedResponse();
    const outcome = await runScheduleWrite(
      connection,
      { actor, buildingId: BuildingId, expectedVersion, signOffClearReason: readSignOffClearReason(body), tenantId: TenantId, updatedById: caller.id },
      (locked) => {
        const existing = parseGroups(locked.CarparkScheduleGroups as string | null);
        const before = existing.find((g) => g.id === groupId);
        const next = deleteGroup(existing, groupId);
        if (next === STEP_NOT_FOUND || !before) return { error: "Group not found", kind: "reject", status: 404 };
        return {
          column: "CarparkScheduleGroups",
          kind: "write",
          ledgerEntries: [
            { action: "schedule.manual_edit", after: null, before, subject: { id: groupId, type: "carpark_group" } },
          ],
          result: next,
          value: next,
        };
      },
    );
    if (outcome.kind === "ok") invalidateTenantAndBuilding(TenantId, BuildingId);
    return scheduleWriteResponse(outcome, (groups) => ({ groups }));
  } catch (error: any) {
    const refusal = ledgerRefusal(error);
    if (refusal) return refusal;
    context.error("deleteCarparkScheduleGroup failed:", error.message);
    return errorResponse(
      "Failed to delete carpark schedule group",
      error.message,
    );
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── POST /api/upsertInfoSheetSection ─────────────────────────────────────────

const INFO_SHEET_RATE_LIMIT = { limit: 60, windowMs: 60_000 };

async function upsertInfoSheetSectionHandler(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const roleCheck = await requireRole(request, [AppRole.ACCOUNTS, AppRole.ACCOUNTS_APPROVAL, AppRole.ADMIN, AppRole.DIRECTOR]);
  if (roleCheck) return roleCheck;

  const caller = callerFromToken(token);
  const rl = checkRateLimit(`infosheet:${caller.id}`, INFO_SHEET_RATE_LIMIT);
  if (!rl.allowed) {
    return {
      status: 429,
      headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) },
      jsonBody: { error: "Rate limit exceeded" },
    };
  }

  let connection;
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const TenantId = Number(body.TenantId);
    const BuildingId = Number(body.BuildingId);
    const section = body.Section as InfoSheetSectionApi | undefined;
    if (!Number.isFinite(TenantId) || !Number.isFinite(BuildingId) || !section?.id || !section.title) {
      return { status: 400, jsonBody: { error: "TenantId, BuildingId, and Section (id, title) required" } };
    }

    connection = await createRequestConnection(token);
    const rows = await executeQuery(
      connection,
      `SELECT InfoSheetSections FROM dbo.Tenants WHERE TenantId = @TenantId AND BuildingId = @BuildingId`,
      [
        { name: "TenantId", type: TYPES.Int, value: TenantId },
        { name: "BuildingId", type: TYPES.Int, value: BuildingId },
      ],
    );
    if (rows.length === 0) return { status: 404, jsonBody: { error: "Tenant not found" } };

    const existing = parseInfoSheetSections(rows[0].InfoSheetSections as string | null);
    const next = upsertInfoSheetSection(existing, section);

    await executeQuery(
      connection,
      `UPDATE dbo.Tenants SET
         InfoSheetSections = @InfoSheetSections,
         UpdatedAt = SYSUTCDATETIME(),
         UpdatedById = @UpdatedById,
         UpdatedByName = @UpdatedByName
       WHERE TenantId = @TenantId AND BuildingId = @BuildingId`,
      [
        { name: "InfoSheetSections", type: TYPES.NVarChar, value: JSON.stringify(next) },
        { name: "UpdatedById", type: TYPES.NVarChar, value: caller.id },
        { name: "UpdatedByName", type: TYPES.NVarChar, value: caller.name },
        { name: "TenantId", type: TYPES.Int, value: TenantId },
        { name: "BuildingId", type: TYPES.Int, value: BuildingId },
      ],
    );

    invalidateTenantAndBuilding(TenantId, BuildingId);
    return { status: 200, jsonBody: { sections: next } };
  } catch (error: any) {
    context.error("upsertInfoSheetSection failed:", error.message);
    return errorResponse("Failed to upsert info sheet section", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── POST /api/deleteInfoSheetSection ─────────────────────────────────────────

async function deleteInfoSheetSectionHandler(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const roleCheck = await requireRole(request, [AppRole.ACCOUNTS, AppRole.ACCOUNTS_APPROVAL, AppRole.ADMIN, AppRole.DIRECTOR]);
  if (roleCheck) return roleCheck;

  const caller = callerFromToken(token);
  const rl = checkRateLimit(`infosheet:${caller.id}`, INFO_SHEET_RATE_LIMIT);
  if (!rl.allowed) {
    return {
      status: 429,
      headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) },
      jsonBody: { error: "Rate limit exceeded" },
    };
  }

  let connection;
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const TenantId = Number(body.TenantId);
    const BuildingId = Number(body.BuildingId);
    const sectionId = body.SectionId as string | undefined;
    if (!Number.isFinite(TenantId) || !Number.isFinite(BuildingId) || !sectionId) {
      return { status: 400, jsonBody: { error: "TenantId, BuildingId, and SectionId required" } };
    }

    connection = await createRequestConnection(token);
    const rows = await executeQuery(
      connection,
      `SELECT InfoSheetSections FROM dbo.Tenants WHERE TenantId = @TenantId AND BuildingId = @BuildingId`,
      [
        { name: "TenantId", type: TYPES.Int, value: TenantId },
        { name: "BuildingId", type: TYPES.Int, value: BuildingId },
      ],
    );
    if (rows.length === 0) return { status: 404, jsonBody: { error: "Tenant not found" } };

    const existing = parseInfoSheetSections(rows[0].InfoSheetSections as string | null);
    const next = deleteInfoSheetSection(existing, sectionId);

    await executeQuery(
      connection,
      `UPDATE dbo.Tenants SET
         InfoSheetSections = @InfoSheetSections,
         UpdatedAt = SYSUTCDATETIME(),
         UpdatedById = @UpdatedById,
         UpdatedByName = @UpdatedByName
       WHERE TenantId = @TenantId AND BuildingId = @BuildingId`,
      [
        { name: "InfoSheetSections", type: TYPES.NVarChar, value: JSON.stringify(next) },
        { name: "UpdatedById", type: TYPES.NVarChar, value: caller.id },
        { name: "UpdatedByName", type: TYPES.NVarChar, value: caller.name },
        { name: "TenantId", type: TYPES.Int, value: TenantId },
        { name: "BuildingId", type: TYPES.Int, value: BuildingId },
      ],
    );

    invalidateTenantAndBuilding(TenantId, BuildingId);
    return { status: 200, jsonBody: { deleted: true, sectionId } };
  } catch (error: any) {
    context.error("deleteInfoSheetSection failed:", error.message);
    return errorResponse("Failed to delete info sheet section", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── POST /api/upsertInfoSheetRow ──────────────────────────────────────────────

async function upsertInfoSheetRowHandler(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const roleCheck = await requireRole(request, [AppRole.ACCOUNTS, AppRole.ACCOUNTS_APPROVAL, AppRole.ADMIN, AppRole.DIRECTOR]);
  if (roleCheck) return roleCheck;

  const caller = callerFromToken(token);
  const rl = checkRateLimit(`infosheet:${caller.id}`, INFO_SHEET_RATE_LIMIT);
  if (!rl.allowed) {
    return {
      status: 429,
      headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) },
      jsonBody: { error: "Rate limit exceeded" },
    };
  }

  let connection;
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const TenantId = Number(body.TenantId);
    const BuildingId = Number(body.BuildingId);
    const sectionId = body.SectionId as string | undefined;
    const row = body.Row as InfoSheetRowApi | undefined;
    if (!Number.isFinite(TenantId) || !Number.isFinite(BuildingId) || !sectionId || !row?.id) {
      return { status: 400, jsonBody: { error: "TenantId, BuildingId, SectionId, and Row (id) required" } };
    }

    connection = await createRequestConnection(token);
    const rows = await executeQuery(
      connection,
      `SELECT InfoSheetSections FROM dbo.Tenants WHERE TenantId = @TenantId AND BuildingId = @BuildingId`,
      [
        { name: "TenantId", type: TYPES.Int, value: TenantId },
        { name: "BuildingId", type: TYPES.Int, value: BuildingId },
      ],
    );
    if (rows.length === 0) return { status: 404, jsonBody: { error: "Tenant not found" } };

    const existing = parseInfoSheetSections(rows[0].InfoSheetSections as string | null);
    const next = upsertInfoSheetRow(existing, sectionId, row);

    await executeQuery(
      connection,
      `UPDATE dbo.Tenants SET
         InfoSheetSections = @InfoSheetSections,
         UpdatedAt = SYSUTCDATETIME(),
         UpdatedById = @UpdatedById,
         UpdatedByName = @UpdatedByName
       WHERE TenantId = @TenantId AND BuildingId = @BuildingId`,
      [
        { name: "InfoSheetSections", type: TYPES.NVarChar, value: JSON.stringify(next) },
        { name: "UpdatedById", type: TYPES.NVarChar, value: caller.id },
        { name: "UpdatedByName", type: TYPES.NVarChar, value: caller.name },
        { name: "TenantId", type: TYPES.Int, value: TenantId },
        { name: "BuildingId", type: TYPES.Int, value: BuildingId },
      ],
    );

    invalidateTenantAndBuilding(TenantId, BuildingId);
    return { status: 200, jsonBody: { sections: next } };
  } catch (error: any) {
    context.error("upsertInfoSheetRow failed:", error.message);
    return errorResponse("Failed to upsert info sheet row", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── POST /api/deleteInfoSheetRow ──────────────────────────────────────────────

async function deleteInfoSheetRowHandler(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const roleCheck = await requireRole(request, [AppRole.ACCOUNTS, AppRole.ACCOUNTS_APPROVAL, AppRole.ADMIN, AppRole.DIRECTOR]);
  if (roleCheck) return roleCheck;

  const caller = callerFromToken(token);
  const rl = checkRateLimit(`infosheet:${caller.id}`, INFO_SHEET_RATE_LIMIT);
  if (!rl.allowed) {
    return {
      status: 429,
      headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) },
      jsonBody: { error: "Rate limit exceeded" },
    };
  }

  let connection;
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const TenantId = Number(body.TenantId);
    const BuildingId = Number(body.BuildingId);
    const sectionId = body.SectionId as string | undefined;
    const rowId = body.RowId as string | undefined;
    if (!Number.isFinite(TenantId) || !Number.isFinite(BuildingId) || !sectionId || !rowId) {
      return { status: 400, jsonBody: { error: "TenantId, BuildingId, SectionId, and RowId required" } };
    }

    connection = await createRequestConnection(token);
    const rows = await executeQuery(
      connection,
      `SELECT InfoSheetSections FROM dbo.Tenants WHERE TenantId = @TenantId AND BuildingId = @BuildingId`,
      [
        { name: "TenantId", type: TYPES.Int, value: TenantId },
        { name: "BuildingId", type: TYPES.Int, value: BuildingId },
      ],
    );
    if (rows.length === 0) return { status: 404, jsonBody: { error: "Tenant not found" } };

    const existing = parseInfoSheetSections(rows[0].InfoSheetSections as string | null);
    const next = deleteInfoSheetRow(existing, sectionId, rowId);

    await executeQuery(
      connection,
      `UPDATE dbo.Tenants SET
         InfoSheetSections = @InfoSheetSections,
         UpdatedAt = SYSUTCDATETIME(),
         UpdatedById = @UpdatedById,
         UpdatedByName = @UpdatedByName
       WHERE TenantId = @TenantId AND BuildingId = @BuildingId`,
      [
        { name: "InfoSheetSections", type: TYPES.NVarChar, value: JSON.stringify(next) },
        { name: "UpdatedById", type: TYPES.NVarChar, value: caller.id },
        { name: "UpdatedByName", type: TYPES.NVarChar, value: caller.name },
        { name: "TenantId", type: TYPES.Int, value: TenantId },
        { name: "BuildingId", type: TYPES.Int, value: BuildingId },
      ],
    );

    invalidateTenantAndBuilding(TenantId, BuildingId);
    return { status: 200, jsonBody: { deleted: true, sectionId, rowId } };
  } catch (error: any) {
    context.error("deleteInfoSheetRow failed:", error.message);
    return errorResponse("Failed to delete info sheet row", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── POST /api/upsertLeaseAdministration ───────────────────────────────────────
// Replaces the whole LeaseAdministration blob (m078). The frontend owns the
// per-field edit + history note, so this handler just validates and persists.

async function upsertLeaseAdministrationHandler(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const roleCheck = await requireRole(request, [AppRole.ACCOUNTS, AppRole.ACCOUNTS_APPROVAL, AppRole.ADMIN, AppRole.DIRECTOR]);
  if (roleCheck) return roleCheck;

  const caller = callerFromToken(token);
  const rl = checkRateLimit(`leaseadmin:${caller.id}`, INFO_SHEET_RATE_LIMIT);
  if (!rl.allowed) {
    return {
      status: 429,
      headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) },
      jsonBody: { error: "Rate limit exceeded" },
    };
  }

  let connection;
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const TenantId = Number(body.TenantId);
    const BuildingId = Number(body.BuildingId);
    const raw = body.LeaseAdministration;
    if (!Number.isFinite(TenantId) || !Number.isFinite(BuildingId) || !raw || typeof raw !== "object") {
      return { status: 400, jsonBody: { error: "TenantId, BuildingId, and LeaseAdministration (object) required" } };
    }

    const next: LeaseAdministration = normaliseLeaseAdministration(raw);

    connection = await createRequestConnection(token);
    const rows = await executeQuery(
      connection,
      `SELECT TenantId FROM dbo.Tenants WHERE TenantId = @TenantId AND BuildingId = @BuildingId`,
      [
        { name: "TenantId", type: TYPES.Int, value: TenantId },
        { name: "BuildingId", type: TYPES.Int, value: BuildingId },
      ],
    );
    if (rows.length === 0) return { status: 404, jsonBody: { error: "Tenant not found" } };

    await executeQuery(
      connection,
      `UPDATE dbo.Tenants SET
         LeaseAdministration = @LeaseAdministration,
         UpdatedAt = SYSUTCDATETIME(),
         UpdatedById = @UpdatedById,
         UpdatedByName = @UpdatedByName
       WHERE TenantId = @TenantId AND BuildingId = @BuildingId`,
      [
        { name: "LeaseAdministration", type: TYPES.NVarChar, value: JSON.stringify(next) },
        { name: "UpdatedById", type: TYPES.NVarChar, value: caller.id },
        { name: "UpdatedByName", type: TYPES.NVarChar, value: caller.name },
        { name: "TenantId", type: TYPES.Int, value: TenantId },
        { name: "BuildingId", type: TYPES.Int, value: BuildingId },
      ],
    );

    invalidateTenantAndBuilding(TenantId, BuildingId);
    return { status: 200, jsonBody: { leaseAdministration: next } };
  } catch (error: any) {
    context.error("upsertLeaseAdministration failed:", error.message);
    return errorResponse("Failed to upsert lease administration", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── POST /api/upsertMiscFee ───────────────────────────────────────────────────

const MISC_FEE_RATE_LIMIT = { limit: 30, windowMs: 60_000 };

async function upsertMiscFeeHandler(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const roleCheck = await requireRole(request, [AppRole.ACCOUNTS, AppRole.ACCOUNTS_APPROVAL, AppRole.ADMIN, AppRole.DIRECTOR]);
  if (roleCheck) return roleCheck;

  const caller = callerFromToken(token);
  const rl = checkRateLimit(`miscfee:${caller.id}`, MISC_FEE_RATE_LIMIT);
  if (!rl.allowed) {
    return {
      status: 429,
      headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) },
      jsonBody: { error: "Rate limit exceeded" },
    };
  }

  let connection;
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const parsed = validateUpsertFeeEnvelope(body);
    if (!parsed.ok) return { status: 400, jsonBody: { error: parsed.error } };
    const expectedVersion = parseExpectedVersion(body.ScheduleVersion);
    if (expectedVersion === null) return { status: 400, jsonBody: { error: "ScheduleVersion must be a non-negative integer" } };
    const { TenantId, BuildingId, fee } = parsed;

    connection = await createRequestConnection(token);
    const actor = await resolveLedgerActor(request, connection);
    if (!actor) return unauthorizedResponse();
    const outcome = await runScheduleWrite(
      connection,
      { actor, buildingId: BuildingId, expectedVersion, signOffClearReason: readSignOffClearReason(body), tenantId: TenantId, updatedById: caller.id },
      (locked) => {
        const existing = parseMiscFees(locked.MiscFees as string | null);
        const before = existing.find((f) => f.id === fee.id) ?? null;
        const next = upsertMiscFee(existing, fee);
        return {
          column: "MiscFees",
          kind: "write",
          ledgerEntries: [
            { action: "schedule.manual_edit", after: fee, before, subject: { id: fee.id, type: "misc_fee" } },
          ],
          result: next,
          value: next,
        };
      },
    );
    if (outcome.kind === "ok") invalidateTenantAndBuilding(TenantId, BuildingId);
    return scheduleWriteResponse(outcome, (fees) => ({ fees }));
  } catch (error: any) {
    const refusal = ledgerRefusal(error);
    if (refusal) return refusal;
    context.error("upsertMiscFee failed:", error.message);
    return errorResponse("Failed to upsert misc fee", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── POST /api/deleteMiscFee ───────────────────────────────────────────────────

async function deleteMiscFeeHandler(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const roleCheck = await requireRole(request, [AppRole.ACCOUNTS, AppRole.ACCOUNTS_APPROVAL, AppRole.ADMIN, AppRole.DIRECTOR]);
  if (roleCheck) return roleCheck;

  const caller = callerFromToken(token);
  const rl = checkRateLimit(`miscfee:${caller.id}`, MISC_FEE_RATE_LIMIT);
  if (!rl.allowed) {
    return {
      status: 429,
      headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) },
      jsonBody: { error: "Rate limit exceeded" },
    };
  }

  let connection;
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const parsed = validateDeleteFeeEnvelope(body);
    if (!parsed.ok) return { status: 400, jsonBody: { error: parsed.error } };
    const expectedVersion = parseExpectedVersion(body.ScheduleVersion);
    if (expectedVersion === null) return { status: 400, jsonBody: { error: "ScheduleVersion must be a non-negative integer" } };
    const { TenantId, BuildingId, feeId } = parsed;

    connection = await createRequestConnection(token);
    const actor = await resolveLedgerActor(request, connection);
    if (!actor) return unauthorizedResponse();
    const outcome = await runScheduleWrite(
      connection,
      { actor, buildingId: BuildingId, expectedVersion, signOffClearReason: readSignOffClearReason(body), tenantId: TenantId, updatedById: caller.id },
      (locked) => {
        const existing = parseMiscFees(locked.MiscFees as string | null);
        const before = existing.find((f) => f.id === feeId);
        const next = deleteMiscFee(existing, feeId);
        if (next === STEP_NOT_FOUND || !before) return { error: "Fee not found", kind: "reject", status: 404 };
        return {
          column: "MiscFees",
          kind: "write",
          ledgerEntries: [
            { action: "schedule.manual_edit", after: null, before, subject: { id: feeId, type: "misc_fee" } },
          ],
          result: next,
          value: next,
        };
      },
    );
    if (outcome.kind === "ok") invalidateTenantAndBuilding(TenantId, BuildingId);
    return scheduleWriteResponse(outcome, (fees) => ({ fees }));
  } catch (error: any) {
    const refusal = ledgerRefusal(error);
    if (refusal) return refusal;
    context.error("deleteMiscFee failed:", error.message);
    return errorResponse("Failed to delete misc fee", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── Route registration ───────────────────────────────────────────────────────

app.http("getRegisterTenants", {
  methods: ["GET"],
  authLevel: "anonymous",
  handler: getRegisterTenants,
});
app.http("getRegisterTenant", {
  methods: ["GET"],
  authLevel: "anonymous",
  handler: getRegisterTenant,
});
app.http("upsertRegisterTenant", {
  methods: ["POST"],
  authLevel: "anonymous",
  handler: upsertRegisterTenant,
});
app.http("upsertOccupancy", {
  methods: ["POST"],
  authLevel: "anonymous",
  handler: upsertOccupancy,
});
app.http("deleteOccupancy", {
  methods: ["POST"],
  authLevel: "anonymous",
  handler: deleteOccupancy,
});
app.http("createTenantNote", {
  methods: ["POST"],
  authLevel: "anonymous",
  handler: createTenantNote,
});
app.http("deleteTenantNote", {
  methods: ["POST"],
  authLevel: "anonymous",
  handler: deleteTenantNote,
});
app.http("deleteRegisterTenant", {
  methods: ["POST"],
  authLevel: "anonymous",
  handler: deleteRegisterTenant,
});
app.http("getReviewsDue", {
  methods: ["GET"],
  authLevel: "anonymous",
  handler: getReviewsDue,
});
app.http("getPortfolioOccupancy", {
  methods: ["GET"],
  authLevel: "anonymous",
  handler: getPortfolioOccupancy,
});
app.http("upsertTenantIncentive", {
  methods: ["POST"],
  authLevel: "anonymous",
  handler: upsertTenantIncentive,
});
app.http("deleteTenantIncentive", {
  methods: ["POST"],
  authLevel: "anonymous",
  handler: deleteTenantIncentive,
});
app.http("getCarparks", {
  methods: ["GET"],
  authLevel: "anonymous",
  handler: getCarparks,
});
app.http("upsertCarpark", {
  methods: ["POST"],
  authLevel: "anonymous",
  handler: upsertCarpark,
});
app.http("upsertCarparksBulk", {
  methods: ["POST"],
  authLevel: "anonymous",
  handler: upsertCarparksBulk,
});
app.http("deleteCarpark", {
  methods: ["POST"],
  authLevel: "anonymous",
  handler: deleteCarpark,
});
app.http("upsertScheduledRateStep", {
  methods: ["POST"],
  authLevel: "anonymous",
  handler: upsertScheduledRateStep,
});
app.http("deleteScheduledRateStep", {
  methods: ["POST"],
  authLevel: "anonymous",
  handler: deleteScheduledRateStep,
});
app.http("upsertCarparkScheduleGroup", {
  methods: ["POST"],
  authLevel: "anonymous",
  handler: upsertCarparkScheduleGroup,
});
app.http("deleteCarparkScheduleGroup", {
  methods: ["POST"],
  authLevel: "anonymous",
  handler: deleteCarparkScheduleGroup,
});
app.http("upsertMiscFee", {
  methods: ["POST"],
  authLevel: "anonymous",
  handler: upsertMiscFeeHandler,
});
app.http("deleteMiscFee", {
  methods: ["POST"],
  authLevel: "anonymous",
  handler: deleteMiscFeeHandler,
});
app.http("upsertInfoSheetSection", {
  methods: ["POST"],
  authLevel: "anonymous",
  handler: upsertInfoSheetSectionHandler,
});
app.http("deleteInfoSheetSection", {
  methods: ["POST"],
  authLevel: "anonymous",
  handler: deleteInfoSheetSectionHandler,
});
app.http("upsertInfoSheetRow", {
  methods: ["POST"],
  authLevel: "anonymous",
  handler: upsertInfoSheetRowHandler,
});
app.http("deleteInfoSheetRow", {
  methods: ["POST"],
  authLevel: "anonymous",
  handler: deleteInfoSheetRowHandler,
});
app.http("upsertLeaseAdministration", {
  methods: ["POST"],
  authLevel: "anonymous",
  handler: upsertLeaseAdministrationHandler,
});
