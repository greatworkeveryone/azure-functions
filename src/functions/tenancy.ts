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
  createConnection,
  executeQuery,
  rollbackTransaction,
  SqlParam,
  SqlRow,
} from "../db";
import {
  errorResponse,
  extractToken,
  oidFromToken,
  requireRole,
  unauthorizedResponse,
} from "../auth";
import { checkRateLimit } from "../rateLimit";
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
  deleteGroup,
  deleteMiscFee,
  deleteStep,
  MiscFee,
  NOT_FOUND as STEP_NOT_FOUND,
  parseGroups,
  parseMiscFees,
  parseSteps,
  ScheduledRateStep,
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

// Decimal column precision/scale — tedious defaults Decimal to scale 0 and
// silently truncates fractional values, so every Decimal param must pass
// the column's precision/scale explicitly. Keys match SQL column names.
const DECIMAL_OPTS = {
  // DECIMAL(12,2) — money columns
  RentPerAnnum: { precision: 12, scale: 2 },
  SecurityDepositHeld: { precision: 12, scale: 2 },
  OldRentPerAnnum: { precision: 12, scale: 2 },
  NewRentPerAnnum: { precision: 12, scale: 2 },
  // DECIMAL(5,2) — percent columns
  CpiCapPercent: { precision: 5, scale: 2 },
  CpiFloorPercent: { precision: 5, scale: 2 },
  EscalationPercent: { precision: 5, scale: 2 },
  FixedReviewPercent: { precision: 5, scale: 2 },
  LastReviewIncreasePercent: { precision: 5, scale: 2 },
  IncreasePercent: { precision: 5, scale: 2 },
  // DECIMAL(10,3) — CPI index values
  CpiBaseValue: { precision: 10, scale: 3 },
  CpiCurrentValue: { precision: 10, scale: 3 },
  // DECIMAL(10,2) — size
  SizeSqm: { precision: 10, scale: 2 },
} as const;

// ── Caller identity (same shape as inspections.ts) ───────────────────────────

interface UserRef {
  id: string;
  name: string;
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
  cpiRegion?: "AUS" | "DARWIN";
  createdAt: string;
  createdBy: UserRef;
  daysToExpiry?: number;
  dollarsToExpiry?: number;
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
  reviewIntervalMonths?: number;
  reviewState: "amber" | "green" | "grey" | "red";
  // Free-form per m038: e.g. "CPI Darwin (June)", "Fixed 3%", "Market".
  reviewType: string;
  securityDepositHeld?: number;
  // Free-form per m038: e.g. "Bank Transfer", "Cash", "Bank Guarantee".
  securityDepositMethod?: string;
  // Free-form per m038: e.g. "Amount equal to 3 months rent plus GST".
  securityDepositRequired?: string;
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

/** Compute the traffic-light state from a tenant's NextReviewDate.
 *  Overdue reviews collapse into "amber" along with reviews due within 90
 *  days — the property team treats both the same way (chase action), so
 *  splitting "red" off as a separate alert just adds noise. We keep "red"
 *  in the union for future use (e.g. very-overdue) but never return it. */
function computeReviewState(
  nextReviewDate: Date | string | null | undefined,
  status: string,
): "amber" | "green" | "grey" | "red" {
  if (status === "vacated") return "grey";
  if (!nextReviewDate) return "grey";
  const reviewDate =
    nextReviewDate instanceof Date ? nextReviewDate : new Date(nextReviewDate);
  if (Number.isNaN(reviewDate.getTime())) return "grey";
  const now = Date.now();
  const reviewMs = reviewDate.getTime();
  const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;
  if (reviewMs < now) return "amber";
  if (reviewMs - now <= ninetyDaysMs) return "amber";
  return "green";
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
): RegisterTenantApi {
  const totalSizeSqm = occupancies.reduce(
    (sum, o) => sum + (o.sizeSqm || 0),
    0,
  );
  const rentPerAnnum = asNum(row.RentPerAnnum);

  // rentPerAnnum is the source of truth. costPerSqm and monthlyRental are
  // derived from it for display only.
  const effectiveRentPerAnnum = rentPerAnnum ?? 0;
  const monthlyRental = effectiveRentPerAnnum / 12;
  const costPerSqm =
    totalSizeSqm > 0 ? effectiveRentPerAnnum / totalSizeSqm : 0;

  const expiryIso = toIsoDate(row.Expiry);
  let daysToExpiry: number | undefined;
  let dollarsToExpiry: number | undefined;
  if (expiryIso) {
    const expiryDate = new Date(expiryIso + "T00:00:00Z");
    const now = new Date();
    daysToExpiry = Math.ceil(
      (expiryDate.getTime() - now.getTime()) / (24 * 60 * 60 * 1000),
    );
    dollarsToExpiry = calcDollarsToExpiry(daysToExpiry, effectiveRentPerAnnum);
  }

  const status = (row.Status as RegisterTenantApi["status"]) ?? "current";

  return {
    abn: asStr(row.Abn),
    accountsEmail: asStr(row.AccountsEmail),
    accountsPhone: asStr(row.AccountsPhone),
    acn: asStr(row.Acn),
    buildingId: row.BuildingId as number,
    businessTenanciesAct: asStr(row.BusinessTenanciesAct),
    comments: asStr(row.Comments),
    commencement: toIsoDate(row.Commencement),
    costPerSqm,
    cpiCapPercent: asNum(row.CpiCapPercent),
    cpiFloorPercent: asNum(row.CpiFloorPercent),
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
    scheduledRateSteps: parseSteps(
      row.ScheduledRateSteps as string | null | undefined,
    ),
    carparkScheduleGroups: parseGroups(
      row.CarparkScheduleGroups as string | null | undefined,
    ),
    miscFees: parseMiscFees(row.MiscFees as string | null | undefined),
    informationSheetAsAt: asStr(row.InformationSheetAsAt),
    informationSheetReference: asStr(row.InformationSheetReference),
    lastReviewDate: toIsoDate(row.LastReviewDate),
    lastReviewIncreasePercent: asNum(row.LastReviewIncreasePercent),
    legalName: row.LegalName as string,
    lot: asStr(row.Lot),
    monthlyRental,
    myobId: asStr(row.MyobId),
    nextReviewDate: toIsoDate(row.NextReviewDate),
    noteCountByAnchor,
    occupancies,
    optionNoticeMonths: asNum(row.OptionNoticeMonths),
    optionPeriods: asStr(row.OptionPeriods),
    postalAddress: asStr(row.PostalAddress),
    primaryContactEmail: asStr(row.PrimaryContactEmail),
    primaryContactName: asStr(row.PrimaryContactName),
    primaryContactPhone: asStr(row.PrimaryContactPhone),
    holdoverTerms: asStr(row.HoldoverTerms),
    renewalLetterIssueBy: asStr(row.RenewalLetterIssueBy),
    rentPerAnnum,
    reviewIntervalMonths: asNum(row.ReviewIntervalMonths),
    reviewState: computeReviewState(row.NextReviewDate, status),
    reviewType: asStr(row.ReviewType) ?? "none",
    securityDepositHeld: asNum(row.SecurityDepositHeld),
    securityDepositMethod: asStr(row.SecurityDepositMethod),
    securityDepositRequired: asStr(row.SecurityDepositRequired),
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
  CpiRegion, CpiCapPercent, CpiFloorPercent,
  SecurityDepositRequired, SecurityDepositMethod, SecurityDepositHeld,
  Status, Comments, EscalationPercent, EscalationSchedule,
  BusinessTenanciesAct,
  Incentives,
  ScheduledRateSteps,
  CarparkScheduleGroups,
  MiscFees,
  CreatedAt, UpdatedAt, CreatedById, CreatedByName, UpdatedById, UpdatedByName
`;

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

  const buildingIdRaw = request.query.get("buildingId");
  if (!buildingIdRaw) {
    return { status: 400, jsonBody: { error: "buildingId required" } };
  }
  const buildingId = Number(buildingIdRaw);
  if (!Number.isFinite(buildingId)) {
    return { status: 400, jsonBody: { error: "buildingId must be a number" } };
  }

  let connection;
  try {
    connection = await createConnection(token);

    const tenantRows = await executeQuery(
      connection,
      `SELECT ${TENANT_COLUMNS} FROM dbo.Tenants WHERE BuildingId = @BuildingId
       ORDER BY LegalName`,
      [{ name: "BuildingId", type: TYPES.Int, value: buildingId }],
    );

    if (tenantRows.length === 0) {
      return { status: 200, jsonBody: { tenants: [] } };
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

    const tenants = tenantRows.map((row) => {
      const tid = row.TenantId as number;
      return tenantRowToApi(
        row,
        occupanciesByTenant.get(String(tid)) ?? [],
        noteCountsByTenant.get(tid) ?? {},
      );
    });

    return { status: 200, jsonBody: { tenants } };
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

  const tenantIdRaw = request.query.get("tenantId");
  if (!tenantIdRaw) {
    return { status: 400, jsonBody: { error: "tenantId required" } };
  }
  const tenantId = Number(tenantIdRaw);
  if (!Number.isFinite(tenantId)) {
    return { status: 400, jsonBody: { error: "tenantId must be a number" } };
  }

  let connection;
  try {
    connection = await createConnection(token);
    const tenantRows = await executeQuery(
      connection,
      `SELECT ${TENANT_COLUMNS} FROM dbo.Tenants WHERE TenantId = @TenantId`,
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

    const occupancies = occupancyRows.map(occupancyRowToApi);
    const notes = noteRows.map(noteRowToApi);
    const reviews = reviewRows.map(reviewRowToApi);
    const history = historyRows.map(historyRowToApi);

    const noteCountByAnchor: Record<string, number> = {};
    for (const n of notes) {
      const key = noteAnchorKey(
        n.anchorKind,
        n.occupancyId ?? "",
        n.fieldKey ?? "",
      );
      noteCountByAnchor[key] = (noteCountByAnchor[key] ?? 0) + 1;
    }

    const tenant = tenantRowToApi(row, occupancies, noteCountByAnchor);
    return {
      status: 200,
      jsonBody: { tenant: { ...tenant, history, notes, reviews } },
    };
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

    connection = await createConnection(token);

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
            CpiRegion, CpiCapPercent, CpiFloorPercent,
            SecurityDepositRequired, SecurityDepositMethod, SecurityDepositHeld,
            Status, Comments, EscalationPercent, EscalationSchedule,
            BusinessTenanciesAct,
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
            @CpiRegion, @CpiCapPercent, @CpiFloorPercent,
            @SecurityDepositRequired, @SecurityDepositMethod, @SecurityDepositHeld,
            @Status, @Comments, @EscalationPercent, @EscalationSchedule,
            @BusinessTenanciesAct,
            @CreatedById, @CreatedByName, @UpdatedById, @UpdatedByName
         )`,
        params,
      );
      resultId = inserted[0].TenantId as number;
    } else {
      // Update — touch only the columns the caller actually sent. Audit fields
      // always update. Use the full param set; UPDATE references only the
      // params we name in the SET clause, so passing extras is harmless.
      const setParts: string[] = [];
      const updateParams: SqlParam[] = [];
      // Whitelist of column → tedious type. Keys are SQL column names (used to
      // build SET clauses), so an attacker controlling the request body can't
      // inject a column name they didn't add to this list — the loop ignores
      // unknown keys.
      const allowlist: Record<string, any> = {
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
        ReviewType: TYPES.NVarChar,
        SecurityDepositHeld: TYPES.Decimal,
        SecurityDepositMethod: TYPES.NVarChar,
        SecurityDepositRequired: TYPES.NVarChar,
        Status: TYPES.NVarChar,
        StreetAddress: TYPES.NVarChar,
        TermMonths: TYPES.Int,
        TradingName: TYPES.NVarChar,
      };
      for (const col of Object.keys(allowlist)) {
        if (!Object.prototype.hasOwnProperty.call(body, col)) continue;
        const value = (body as any)[col];
        if (value === undefined) continue;
        setParts.push(`${col} = @${col}`);
        updateParams.push({
          name: col,
          type: allowlist[col],
          value: normaliseValue(col, value),
          options: (
            DECIMAL_OPTS as Record<string, { precision: number; scale: number }>
          )[col],
        });
      }
      // Always bump audit fields on update.
      setParts.push("UpdatedAt = SYSUTCDATETIME()");
      setParts.push("UpdatedById = @UpdatedById");
      setParts.push("UpdatedByName = @UpdatedByName");
      updateParams.push({
        name: "UpdatedById",
        type: TYPES.NVarChar,
        value: caller.id,
      });
      updateParams.push({
        name: "UpdatedByName",
        type: TYPES.NVarChar,
        value: caller.name,
      });
      updateParams.push({ name: "TenantId", type: TYPES.Int, value: tenantId });

      await executeQuery(
        connection,
        `UPDATE dbo.Tenants SET ${setParts.join(", ")} WHERE TenantId = @TenantId`,
        updateParams,
      );
      resultId = tenantId;
    }

    const stored = await executeQuery(
      connection,
      `SELECT ${TENANT_COLUMNS} FROM dbo.Tenants WHERE TenantId = @Id`,
      [{ name: "Id", type: TYPES.Int, value: resultId }],
    );
    if (stored.length === 0) {
      return {
        status: 404,
        jsonBody: { error: "Tenant disappeared after upsert" },
      };
    }
    return {
      status: 200,
      jsonBody: { tenant: tenantRowToApi(stored[0], [], {}) },
    };
  } catch (error: any) {
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
    { name: "NextReviewDate", type: TYPES.Date, value: v("NextReviewDate") },
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

// ── POST /api/upsertOccupancy ────────────────────────────────────────────────
// MERGE-style: insert or update by client-provided OccupancyId. Writes a
// history row inside a transaction so the timeline is always in sync.

async function upsertOccupancy(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

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

    connection = await createConnection(token);

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

    await beginTransaction(connection);
    try {
      // Look up by either the client OccupancyId OR the cell key
      // (BuildingId + Level + Area). The cell key is what the unique index
      // enforces — re-imports often mint a fresh OccupancyId for the same
      // physical cell, so we need to detect that and update in place rather
      // than fail with a duplicate-key error.
      const existing = await executeQuery(
        connection,
        `SELECT TOP 1 OccupancyId, TenantId
         FROM dbo.TenantOccupancies
         WHERE OccupancyId = @Id
            OR (BuildingId = @BuildingId AND Level = @Level AND Area = @Area)
         ORDER BY CASE WHEN OccupancyId = @Id THEN 0 ELSE 1 END`,
        [
          { name: "Id", type: TYPES.NVarChar, value: OccupancyId },
          { name: "BuildingId", type: TYPES.Int, value: BuildingId },
          { name: "Level", type: TYPES.NVarChar, value: Level },
          { name: "Area", type: TYPES.NVarChar, value: Area },
        ],
      );
      if (existing.length > 0) {
        effectiveOccupancyId = existing[0].OccupancyId as string;
      }

      if (existing.length === 0) {
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
        // Reassign-or-update. TenantId is included so a re-import can move a
        // cell from one (orphan) tenant to another.
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

      await commitTransaction(connection);
    } catch (err) {
      await rollbackTransaction(connection);
      throw err;
    }

    const stored = await executeQuery(
      connection,
      `SELECT ${OCCUPANCY_COLUMNS}
       FROM dbo.TenantOccupancies WHERE OccupancyId = @Id`,
      [{ name: "Id", type: TYPES.NVarChar, value: effectiveOccupancyId }],
    );
    return {
      status: 200,
      jsonBody: { occupancy: occupancyRowToApi(stored[0]) },
    };
  } catch (error: any) {
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

  let connection;
  try {
    const body = (await request.json()) as { OccupancyId?: string };
    if (typeof body.OccupancyId !== "string") {
      return { status: 400, jsonBody: { error: "OccupancyId required" } };
    }
    connection = await createConnection(token);
    await executeQuery(
      connection,
      `DELETE FROM dbo.TenantOccupancies WHERE OccupancyId = @Id`,
      [{ name: "Id", type: TYPES.NVarChar, value: body.OccupancyId }],
    );
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

    connection = await createConnection(token);
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

  let connection;
  try {
    const body = (await request.json()) as { NoteId?: string };
    if (typeof body.NoteId !== "string") {
      return { status: 400, jsonBody: { error: "NoteId required" } };
    }
    connection = await createConnection(token);
    await executeQuery(
      connection,
      `DELETE FROM dbo.TenantNotes WHERE NoteId = @Id`,
      [{ name: "Id", type: TYPES.NVarChar, value: body.NoteId }],
    );
    return { status: 200, jsonBody: { deleted: true, noteId: body.NoteId } };
  } catch (error: any) {
    context.error("deleteTenantNote failed:", error.message);
    return errorResponse("Delete tenant note failed", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── POST /api/deleteRegisterTenant ───────────────────────────────────────────
// Hard-deletes a tenant. ON DELETE CASCADE handles occupancies, notes, history
// and reviews. Refuses if Jobs.TenantID still references this tenant — the
// caller has to reassign jobs first (mirrors the legacy /deleteTenant behaviour).

async function deleteRegisterTenant(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  let connection;
  let body: Record<string, any> | null = null;
  try {
    body = (await request.json()) as Record<string, any>;
    const tenantId = body?.TenantId;
    if (typeof tenantId !== "number") {
      return { status: 400, jsonBody: { error: "TenantId (number) required" } };
    }

    connection = await createConnection(token);

    const refCount = await executeQuery(
      connection,
      "SELECT COUNT(*) AS N FROM dbo.Jobs WHERE TenantID = @Id",
      [{ name: "Id", type: TYPES.Int, value: tenantId }],
    );
    if ((refCount[0]?.N as number) > 0) {
      return {
        status: 400,
        jsonBody: {
          error:
            "Cannot delete — tenant is assigned to at least one job. Reassign first.",
        },
      };
    }

    await executeQuery(
      connection,
      "DELETE FROM dbo.Tenants WHERE TenantId = @Id",
      [{ name: "Id", type: TYPES.Int, value: tenantId }],
    );
    return { status: 200, jsonBody: { deleted: true, tenantId } };
  } catch (error: any) {
    const formatted = formatSqlError(error);
    context.error("deleteRegisterTenant failed", {
      error: formatted,
      payload: summariseBody(body),
      stack: error?.stack,
    });
    return errorResponse("Delete register tenant failed", formatted);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── POST /api/applyRentReview ────────────────────────────────────────────────
// Atomically: completes the RentReviews row, updates Tenants.RentPerAnnum,
// LastReviewDate, LastReviewIncreasePercent, advances NextReviewDate by
// ReviewIntervalMonths.

async function applyRentReview(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const caller = callerFromToken(token);

  let connection;
  try {
    const body = (await request.json()) as Record<string, any>;
    const {
      ReviewId,
      NewRentPerAnnum,
      IncreasePercent,
      Source,
      CpiBaseValue,
      CpiCurrentValue,
      CpiIndexUsed,
    } = body;
    if (typeof ReviewId !== "string" || !ReviewId) {
      return { status: 400, jsonBody: { error: "ReviewId required" } };
    }
    if (
      typeof NewRentPerAnnum !== "number" ||
      !Number.isFinite(NewRentPerAnnum)
    ) {
      return { status: 400, jsonBody: { error: "NewRentPerAnnum required" } };
    }

    connection = await createConnection(token);
    const reviewRows = await executeQuery(
      connection,
      `SELECT r.ReviewId, r.TenantId, t.RentPerAnnum, t.ReviewIntervalMonths
       FROM dbo.RentReviews r
       INNER JOIN dbo.Tenants t ON t.TenantId = r.TenantId
       WHERE r.ReviewId = @Id`,
      [{ name: "Id", type: TYPES.NVarChar, value: ReviewId }],
    );
    if (reviewRows.length === 0) {
      return { status: 404, jsonBody: { error: "Review not found" } };
    }
    const r = reviewRows[0];
    const tenantId = r.TenantId as number;
    const oldRent = (r.RentPerAnnum as number | null) ?? 0;
    const computedIncrease =
      typeof IncreasePercent === "number"
        ? IncreasePercent
        : oldRent > 0
          ? Math.round(((NewRentPerAnnum - oldRent) / oldRent) * 10000) / 100
          : 0;
    const intervalMonths = (r.ReviewIntervalMonths as number | null) ?? 12;
    const today = new Date();
    const nextReview = new Date(today);
    nextReview.setMonth(nextReview.getMonth() + intervalMonths);
    const nextReviewIso = nextReview.toISOString().slice(0, 10);
    const todayIso = today.toISOString().slice(0, 10);

    await beginTransaction(connection);
    try {
      await executeQuery(
        connection,
        `UPDATE dbo.RentReviews SET
           Status = 'completed',
           OldRentPerAnnum = @OldRent,
           NewRentPerAnnum = @NewRent,
           IncreasePercent = @IncreasePercent,
           CpiIndexUsed = @CpiIndexUsed,
           CpiBaseValue = @CpiBaseValue,
           CpiCurrentValue = @CpiCurrentValue,
           CompletedAt = SYSUTCDATETIME(),
           CompletedById = @CompletedById,
           CompletedByName = @CompletedByName,
           Notes = @Notes
         WHERE ReviewId = @Id`,
        [
          { name: "Id", type: TYPES.NVarChar, value: ReviewId },
          {
            name: "OldRent",
            type: TYPES.Decimal,
            value: oldRent,
            options: DECIMAL_OPTS.OldRentPerAnnum,
          },
          {
            name: "NewRent",
            type: TYPES.Decimal,
            value: NewRentPerAnnum,
            options: DECIMAL_OPTS.NewRentPerAnnum,
          },
          {
            name: "IncreasePercent",
            type: TYPES.Decimal,
            value: computedIncrease,
            options: DECIMAL_OPTS.IncreasePercent,
          },
          {
            name: "CpiIndexUsed",
            type: TYPES.NVarChar,
            value: CpiIndexUsed ?? null,
          },
          {
            name: "CpiBaseValue",
            type: TYPES.Decimal,
            value: CpiBaseValue ?? null,
            options: DECIMAL_OPTS.CpiBaseValue,
          },
          {
            name: "CpiCurrentValue",
            type: TYPES.Decimal,
            value: CpiCurrentValue ?? null,
            options: DECIMAL_OPTS.CpiCurrentValue,
          },
          { name: "CompletedById", type: TYPES.NVarChar, value: caller.id },
          { name: "CompletedByName", type: TYPES.NVarChar, value: caller.name },
          {
            name: "Notes",
            type: TYPES.NVarChar,
            value: Source ? `Applied via ${Source}` : null,
          },
        ],
      );

      await executeQuery(
        connection,
        `UPDATE dbo.Tenants SET
           RentPerAnnum = @NewRent,
           LastReviewDate = @Today,
           LastReviewIncreasePercent = @IncreasePercent,
           NextReviewDate = @NextReview,
           UpdatedAt = SYSUTCDATETIME(),
           UpdatedById = @UpdatedById,
           UpdatedByName = @UpdatedByName
         WHERE TenantId = @TenantId`,
        [
          { name: "TenantId", type: TYPES.Int, value: tenantId },
          {
            name: "NewRent",
            type: TYPES.Decimal,
            value: NewRentPerAnnum,
            options: DECIMAL_OPTS.NewRentPerAnnum,
          },
          { name: "Today", type: TYPES.Date, value: todayIso },
          {
            name: "IncreasePercent",
            type: TYPES.Decimal,
            value: computedIncrease,
            options: DECIMAL_OPTS.IncreasePercent,
          },
          { name: "NextReview", type: TYPES.Date, value: nextReviewIso },
          { name: "UpdatedById", type: TYPES.NVarChar, value: caller.id },
          { name: "UpdatedByName", type: TYPES.NVarChar, value: caller.name },
        ],
      );
      await commitTransaction(connection);
    } catch (err) {
      await rollbackTransaction(connection);
      throw err;
    }

    return {
      status: 200,
      jsonBody: {
        applied: true,
        increasePercent: computedIncrease,
        nextReviewDate: nextReviewIso,
        reviewId: ReviewId,
        tenantId,
      },
    };
  } catch (error: any) {
    context.error("applyRentReview failed:", error.message);
    return errorResponse("Apply rent review failed", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── GET /api/getReviewsDue[?buildingId=N] ────────────────────────────────────
// Returns amber+red tenants for the dashboard widget. Same shape as
// getRegisterTenants but filtered to ones needing attention.

async function getReviewsDue(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const buildingIdParam = request.query.get("buildingId");

  let connection;
  try {
    connection = await createConnection(token);
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
    const rows = await executeQuery(
      connection,
      `SELECT ${TENANT_COLUMNS} FROM dbo.Tenants
       ${where} ${where ? "AND" : "WHERE"} NextReviewDate IS NOT NULL
        AND NextReviewDate <= DATEADD(day, 90, CAST(SYSUTCDATETIME() AS DATE))
        AND Status <> 'vacated'
       ORDER BY NextReviewDate`,
      params,
    );
    const tenants = rows.map((row) => tenantRowToApi(row, [], {}));
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

  let connection;
  try {
    connection = await createConnection(token);
    const rows = await executeQuery(
      connection,
      `SELECT t.BuildingId,
              SUM(CASE WHEN t.Status IN ('current','holdover')
                       THEN o.SizeSqm ELSE 0 END) AS ActiveSqm,
              SUM(o.SizeSqm) AS TotalSqm
       FROM dbo.TenantOccupancies o
       INNER JOIN dbo.Tenants t ON t.TenantId = o.TenantId
       GROUP BY t.BuildingId`,
      [],
    );

    const buildings = rows.map((r) => {
      const totalSqm = Number(r.TotalSqm) || 0;
      const activeSqm = Number(r.ActiveSqm) || 0;
      return {
        activeSqm,
        buildingId: r.BuildingId as number,
        occupancyPercent: totalSqm > 0 ? (activeSqm / totalSqm) * 100 : 0,
        totalSqm,
      };
    });

    return { status: 200, jsonBody: { buildings } };
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

async function loadTenantIncentives(
  connection: Connection,
  tenantId: number,
  buildingId: number,
): Promise<{ found: false } | { found: true; incentives: TenancyIncentive[] }> {
  // BuildingId is part of the lookup so a caller can't drift a tenant onto
  // the wrong building by mistake — the path key the frontend uses always
  // pairs both, and a mismatch is a bug worth surfacing as 404 rather than
  // silently writing to the unintended row.
  const rows = await executeQuery(
    connection,
    `SELECT Incentives FROM dbo.Tenants
     WHERE TenantId = @TenantId AND BuildingId = @BuildingId`,
    [
      { name: "TenantId", type: TYPES.Int, value: tenantId },
      { name: "BuildingId", type: TYPES.Int, value: buildingId },
    ],
  );
  if (rows.length === 0) return { found: false };
  return {
    found: true,
    incentives: parseIncentives(
      rows[0].Incentives as string | null | undefined,
    ),
  };
}

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
    `SELECT ${TENANT_COLUMNS} FROM dbo.Tenants WHERE TenantId = @TenantId`,
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
  const roleCheck = requireRole(request, ["Admin", "facilities"]);
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
    const { TenantId, BuildingId, incentive } = parsed;

    connection = await createConnection(token);

    const loaded = await loadTenantIncentives(connection, TenantId, BuildingId);
    if (!loaded.found) {
      return {
        status: 404,
        jsonBody: { error: "Tenant not found for the given BuildingId" },
      };
    }
    const next = upsertIncentive(loaded.incentives, incentive);
    const nextJson = JSON.stringify(next);

    await executeQuery(
      connection,
      `UPDATE dbo.Tenants SET
         Incentives = @Incentives,
         UpdatedAt = SYSUTCDATETIME(),
         UpdatedById = @UpdatedById,
         UpdatedByName = @UpdatedByName
       WHERE TenantId = @TenantId AND BuildingId = @BuildingId`,
      [
        { name: "Incentives", type: TYPES.NVarChar, value: nextJson },
        { name: "UpdatedById", type: TYPES.NVarChar, value: caller.id },
        { name: "UpdatedByName", type: TYPES.NVarChar, value: caller.name },
        { name: "TenantId", type: TYPES.Int, value: TenantId },
        { name: "BuildingId", type: TYPES.Int, value: BuildingId },
      ],
    );

    context.log("upsertTenantIncentive", {
      action: "upsertTenantIncentive",
      actor: caller,
      incentiveId: incentive.id,
      noteSummary: incentive.note
        ? incentive.note.length > 80
          ? `${incentive.note.slice(0, 77)}…`
          : incentive.note
        : undefined,
      tenantId: TenantId,
    });

    const tenant = await reloadFullTenant(connection, TenantId);
    if (!tenant) {
      return {
        status: 404,
        jsonBody: { error: "Tenant disappeared after upsert" },
      };
    }
    return { status: 200, jsonBody: { tenant } };
  } catch (error: any) {
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
  const roleCheck = requireRole(request, ["Admin", "facilities"]);
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
    const { TenantId, BuildingId, incentiveId } = parsed;

    connection = await createConnection(token);

    const loaded = await loadTenantIncentives(connection, TenantId, BuildingId);
    if (!loaded.found) {
      return {
        status: 404,
        jsonBody: { error: "Tenant not found for the given BuildingId" },
      };
    }
    const next = deleteIncentive(loaded.incentives, incentiveId);
    if (next === NOT_FOUND) {
      return { status: 404, jsonBody: { error: "Incentive not found" } };
    }
    const nextJson = JSON.stringify(next);

    await executeQuery(
      connection,
      `UPDATE dbo.Tenants SET
         Incentives = @Incentives,
         UpdatedAt = SYSUTCDATETIME(),
         UpdatedById = @UpdatedById,
         UpdatedByName = @UpdatedByName
       WHERE TenantId = @TenantId AND BuildingId = @BuildingId`,
      [
        { name: "Incentives", type: TYPES.NVarChar, value: nextJson },
        { name: "UpdatedById", type: TYPES.NVarChar, value: caller.id },
        { name: "UpdatedByName", type: TYPES.NVarChar, value: caller.name },
        { name: "TenantId", type: TYPES.Int, value: TenantId },
        { name: "BuildingId", type: TYPES.Int, value: BuildingId },
      ],
    );

    context.log("deleteTenantIncentive", {
      action: "deleteTenantIncentive",
      actor: caller,
      incentiveId,
      tenantId: TenantId,
    });

    const tenant = await reloadFullTenant(connection, TenantId);
    if (!tenant) {
      return {
        status: 404,
        jsonBody: { error: "Tenant disappeared after delete" },
      };
    }
    return { status: 200, jsonBody: { tenant } };
  } catch (error: any) {
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

// ── POST /api/upsertScheduledRateStep ────────────────────────────────────────

const STEP_RATE_LIMIT = { limit: 30, windowMs: 60_000 };

async function upsertScheduledRateStep(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const roleCheck = requireRole(request, ["Admin", "facilities"]);
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
    const { TenantId, BuildingId, step } = parsed;

    connection = await createConnection(token);
    const rows = await executeQuery(
      connection,
      `SELECT ScheduledRateSteps FROM dbo.Tenants
       WHERE TenantId = @TenantId AND BuildingId = @BuildingId`,
      [
        { name: "TenantId", type: TYPES.Int, value: TenantId },
        { name: "BuildingId", type: TYPES.Int, value: BuildingId },
      ],
    );
    if (rows.length === 0) {
      return {
        status: 404,
        jsonBody: { error: "Tenant not found for the given BuildingId" },
      };
    }
    const existing = parseSteps(rows[0].ScheduledRateSteps as string | null);
    const next = upsertStep(existing, step);

    await executeQuery(
      connection,
      `UPDATE dbo.Tenants SET
         ScheduledRateSteps = @ScheduledRateSteps,
         UpdatedAt = SYSUTCDATETIME(),
         UpdatedById = @UpdatedById,
         UpdatedByName = @UpdatedByName
       WHERE TenantId = @TenantId AND BuildingId = @BuildingId`,
      [
        {
          name: "ScheduledRateSteps",
          type: TYPES.NVarChar,
          value: JSON.stringify(next),
        },
        { name: "UpdatedById", type: TYPES.NVarChar, value: caller.id },
        { name: "UpdatedByName", type: TYPES.NVarChar, value: caller.name },
        { name: "TenantId", type: TYPES.Int, value: TenantId },
        { name: "BuildingId", type: TYPES.Int, value: BuildingId },
      ],
    );

    return { status: 200, jsonBody: { steps: next } };
  } catch (error: any) {
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
  const roleCheck = requireRole(request, ["Admin", "facilities"]);
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
    const { TenantId, BuildingId, stepId } = parsed;

    connection = await createConnection(token);
    const rows = await executeQuery(
      connection,
      `SELECT ScheduledRateSteps FROM dbo.Tenants
       WHERE TenantId = @TenantId AND BuildingId = @BuildingId`,
      [
        { name: "TenantId", type: TYPES.Int, value: TenantId },
        { name: "BuildingId", type: TYPES.Int, value: BuildingId },
      ],
    );
    if (rows.length === 0) {
      return { status: 404, jsonBody: { error: "Tenant not found" } };
    }
    const existing = parseSteps(rows[0].ScheduledRateSteps as string | null);
    const next = deleteStep(existing, stepId);
    if (next === STEP_NOT_FOUND) {
      return { status: 404, jsonBody: { error: "Step not found" } };
    }

    await executeQuery(
      connection,
      `UPDATE dbo.Tenants SET
         ScheduledRateSteps = @ScheduledRateSteps,
         UpdatedAt = SYSUTCDATETIME(),
         UpdatedById = @UpdatedById,
         UpdatedByName = @UpdatedByName
       WHERE TenantId = @TenantId AND BuildingId = @BuildingId`,
      [
        {
          name: "ScheduledRateSteps",
          type: TYPES.NVarChar,
          value: JSON.stringify(next),
        },
        { name: "UpdatedById", type: TYPES.NVarChar, value: caller.id },
        { name: "UpdatedByName", type: TYPES.NVarChar, value: caller.name },
        { name: "TenantId", type: TYPES.Int, value: TenantId },
        { name: "BuildingId", type: TYPES.Int, value: BuildingId },
      ],
    );

    return { status: 200, jsonBody: { steps: next } };
  } catch (error: any) {
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

  let connection;
  try {
    const buildingIdRaw = request.query.get("buildingId");
    const buildingId = buildingIdRaw ? Number(buildingIdRaw) : NaN;
    if (!Number.isFinite(buildingId)) {
      return { status: 400, jsonBody: { error: "buildingId required" } };
    }

    connection = await createConnection(token);
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

  let connection;
  let body: Record<string, any> | null = null;
  try {
    body = (await request.json()) as Record<string, any>;
    const parsed = parseCarparkPayload(body);
    if ("error" in parsed) {
      return { status: 400, jsonBody: { error: parsed.error } };
    }

    connection = await createConnection(token);
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

    connection = await createConnection(token);

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

  let connection;
  try {
    const body = (await request.json()) as { CarparkId?: string };
    if (typeof body.CarparkId !== "string" || !body.CarparkId) {
      return { status: 400, jsonBody: { error: "CarparkId required" } };
    }
    connection = await createConnection(token);
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
  const roleCheck = requireRole(request, ["Admin", "facilities"]);
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
    const { TenantId, BuildingId, group } = parsed;

    connection = await createConnection(token);
    const rows = await executeQuery(
      connection,
      `SELECT CarparkScheduleGroups FROM dbo.Tenants
       WHERE TenantId = @TenantId AND BuildingId = @BuildingId`,
      [
        { name: "TenantId", type: TYPES.Int, value: TenantId },
        { name: "BuildingId", type: TYPES.Int, value: BuildingId },
      ],
    );
    if (rows.length === 0)
      return { status: 404, jsonBody: { error: "Tenant not found" } };

    const existing = parseGroups(
      rows[0].CarparkScheduleGroups as string | null,
    );
    const next = upsertGroup(existing, group);

    await executeQuery(
      connection,
      `UPDATE dbo.Tenants SET
         CarparkScheduleGroups = @CarparkScheduleGroups,
         UpdatedAt = SYSUTCDATETIME(),
         UpdatedById = @UpdatedById,
         UpdatedByName = @UpdatedByName
       WHERE TenantId = @TenantId AND BuildingId = @BuildingId`,
      [
        {
          name: "CarparkScheduleGroups",
          type: TYPES.NVarChar,
          value: JSON.stringify(next),
        },
        { name: "UpdatedById", type: TYPES.NVarChar, value: caller.id },
        { name: "UpdatedByName", type: TYPES.NVarChar, value: caller.name },
        { name: "TenantId", type: TYPES.Int, value: TenantId },
        { name: "BuildingId", type: TYPES.Int, value: BuildingId },
      ],
    );

    return { status: 200, jsonBody: { groups: next } };
  } catch (error: any) {
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
  const roleCheck = requireRole(request, ["Admin", "facilities"]);
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
    const { TenantId, BuildingId, groupId } = parsed;

    connection = await createConnection(token);
    const rows = await executeQuery(
      connection,
      `SELECT CarparkScheduleGroups FROM dbo.Tenants
       WHERE TenantId = @TenantId AND BuildingId = @BuildingId`,
      [
        { name: "TenantId", type: TYPES.Int, value: TenantId },
        { name: "BuildingId", type: TYPES.Int, value: BuildingId },
      ],
    );
    if (rows.length === 0)
      return { status: 404, jsonBody: { error: "Tenant not found" } };

    const existing = parseGroups(
      rows[0].CarparkScheduleGroups as string | null,
    );
    const next = deleteGroup(existing, groupId);
    if (next === STEP_NOT_FOUND)
      return { status: 404, jsonBody: { error: "Group not found" } };

    await executeQuery(
      connection,
      `UPDATE dbo.Tenants SET
         CarparkScheduleGroups = @CarparkScheduleGroups,
         UpdatedAt = SYSUTCDATETIME(),
         UpdatedById = @UpdatedById,
         UpdatedByName = @UpdatedByName
       WHERE TenantId = @TenantId AND BuildingId = @BuildingId`,
      [
        {
          name: "CarparkScheduleGroups",
          type: TYPES.NVarChar,
          value: JSON.stringify(next),
        },
        { name: "UpdatedById", type: TYPES.NVarChar, value: caller.id },
        { name: "UpdatedByName", type: TYPES.NVarChar, value: caller.name },
        { name: "TenantId", type: TYPES.Int, value: TenantId },
        { name: "BuildingId", type: TYPES.Int, value: BuildingId },
      ],
    );

    return { status: 200, jsonBody: { groups: next } };
  } catch (error: any) {
    context.error("deleteCarparkScheduleGroup failed:", error.message);
    return errorResponse(
      "Failed to delete carpark schedule group",
      error.message,
    );
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
  const roleCheck = requireRole(request, ["Admin", "facilities"]);
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
    const { TenantId, BuildingId, fee } = parsed;

    connection = await createConnection(token);
    const rows = await executeQuery(
      connection,
      `SELECT MiscFees FROM dbo.Tenants
       WHERE TenantId = @TenantId AND BuildingId = @BuildingId`,
      [
        { name: "TenantId", type: TYPES.Int, value: TenantId },
        { name: "BuildingId", type: TYPES.Int, value: BuildingId },
      ],
    );
    if (rows.length === 0)
      return { status: 404, jsonBody: { error: "Tenant not found" } };

    const existing = parseMiscFees(rows[0].MiscFees as string | null);
    const next = upsertMiscFee(existing, fee);

    await executeQuery(
      connection,
      `UPDATE dbo.Tenants SET
         MiscFees = @MiscFees,
         UpdatedAt = SYSUTCDATETIME(),
         UpdatedById = @UpdatedById,
         UpdatedByName = @UpdatedByName
       WHERE TenantId = @TenantId AND BuildingId = @BuildingId`,
      [
        { name: "MiscFees", type: TYPES.NVarChar, value: JSON.stringify(next) },
        { name: "UpdatedById", type: TYPES.NVarChar, value: caller.id },
        { name: "UpdatedByName", type: TYPES.NVarChar, value: caller.name },
        { name: "TenantId", type: TYPES.Int, value: TenantId },
        { name: "BuildingId", type: TYPES.Int, value: BuildingId },
      ],
    );

    return { status: 200, jsonBody: { fees: next } };
  } catch (error: any) {
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
  const roleCheck = requireRole(request, ["Admin", "facilities"]);
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
    const { TenantId, BuildingId, feeId } = parsed;

    connection = await createConnection(token);
    const rows = await executeQuery(
      connection,
      `SELECT MiscFees FROM dbo.Tenants
       WHERE TenantId = @TenantId AND BuildingId = @BuildingId`,
      [
        { name: "TenantId", type: TYPES.Int, value: TenantId },
        { name: "BuildingId", type: TYPES.Int, value: BuildingId },
      ],
    );
    if (rows.length === 0)
      return { status: 404, jsonBody: { error: "Tenant not found" } };

    const existing = parseMiscFees(rows[0].MiscFees as string | null);
    const next = deleteMiscFee(existing, feeId);
    if (next === STEP_NOT_FOUND)
      return { status: 404, jsonBody: { error: "Fee not found" } };

    await executeQuery(
      connection,
      `UPDATE dbo.Tenants SET
         MiscFees = @MiscFees,
         UpdatedAt = SYSUTCDATETIME(),
         UpdatedById = @UpdatedById,
         UpdatedByName = @UpdatedByName
       WHERE TenantId = @TenantId AND BuildingId = @BuildingId`,
      [
        { name: "MiscFees", type: TYPES.NVarChar, value: JSON.stringify(next) },
        { name: "UpdatedById", type: TYPES.NVarChar, value: caller.id },
        { name: "UpdatedByName", type: TYPES.NVarChar, value: caller.name },
        { name: "TenantId", type: TYPES.Int, value: TenantId },
        { name: "BuildingId", type: TYPES.Int, value: BuildingId },
      ],
    );

    return { status: 200, jsonBody: { fees: next } };
  } catch (error: any) {
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
app.http("applyRentReview", {
  methods: ["POST"],
  authLevel: "anonymous",
  handler: applyRentReview,
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
