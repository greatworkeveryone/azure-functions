// Tenancy Register — v2 of the tenants module. The legacy /getTenants +
// /upsertTenant in `tenants.ts` stays alive for the keys/jobs flows; the
// endpoints here back the rich spreadsheet + info-sheet UI that replaces
// the old read-only tenancy schedule.
//
// Wire convention mirrors inspections: responses are camelCase JSON ready
// for the frontend (no transform layer in the client lib), payloads are
// PascalCase to match the parameterised-SQL pattern.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { TYPES } from "tedious";
import {
  beginTransaction,
  closeConnection,
  commitTransaction,
  createConnection,
  executeQuery,
  rollbackTransaction,
  SqlRow,
} from "../db";
import {
  errorResponse,
  extractToken,
  oidFromToken,
  unauthorizedResponse,
} from "../auth";

// ── Caller identity (same shape as inspections.ts) ───────────────────────────

interface UserRef { id: string; name: string }

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = payload.padEnd(payload.length + ((4 - (payload.length % 4)) % 4), "=");
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function callerFromToken(token: string): UserRef {
  const claims = decodeJwtPayload(token);
  const id = oidFromToken(token) ?? (claims?.preferred_username as string) ?? "unknown";
  const name =
    (claims?.name as string) ?? (claims?.preferred_username as string) ?? "Unknown user";
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
function summariseBody(body: Record<string, any> | null | undefined): Record<string, any> {
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
  renewalLetterIssueBy?: string;
  rentBasis: "custom" | "fixedAnnual" | "perSqm";
  rentPerAnnum?: number;
  rentPerSqm?: number;
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
  rentPerSqm?: number;
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
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString().slice(0, 10);
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
  const reviewDate = nextReviewDate instanceof Date ? nextReviewDate : new Date(nextReviewDate);
  if (Number.isNaN(reviewDate.getTime())) return "grey";
  const now = Date.now();
  const reviewMs = reviewDate.getTime();
  const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;
  if (reviewMs < now) return "amber";
  if (reviewMs - now <= ninetyDaysMs) return "amber";
  return "green";
}

/** Months between two dates, partial month rounded down. */
function monthsBetween(from: Date, to: Date): number {
  let months = (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth());
  if (to.getDate() < from.getDate()) months -= 1;
  return Math.max(0, months);
}

function tenantRowToApi(
  row: SqlRow,
  occupancies: TenantOccupancyApi[],
  noteCountByAnchor: Record<string, number>,
): RegisterTenantApi {
  const totalSizeSqm = occupancies.reduce((sum, o) => sum + (o.sizeSqm || 0), 0);
  const rentBasis = (row.RentBasis as RegisterTenantApi["rentBasis"]) ?? "fixedAnnual";
  const rentPerAnnum = asNum(row.RentPerAnnum);
  const rentPerSqm = asNum(row.RentPerSqm);

  let effectiveRentPerAnnum = 0;
  if (rentBasis === "perSqm" && rentPerSqm !== undefined) {
    effectiveRentPerAnnum = rentPerSqm * totalSizeSqm;
  } else if (rentPerAnnum !== undefined) {
    effectiveRentPerAnnum = rentPerAnnum;
  }
  const monthlyRental = effectiveRentPerAnnum / 12;
  const costPerSqm = totalSizeSqm > 0 ? effectiveRentPerAnnum / totalSizeSqm : 0;

  const expiryIso = toIsoDate(row.Expiry);
  let daysToExpiry: number | undefined;
  let dollarsToExpiry: number | undefined;
  if (expiryIso) {
    const expiryDate = new Date(expiryIso + "T00:00:00Z");
    const now = new Date();
    daysToExpiry = Math.ceil(
      (expiryDate.getTime() - now.getTime()) / (24 * 60 * 60 * 1000),
    );
    if (daysToExpiry > 0) {
      dollarsToExpiry = monthsBetween(now, expiryDate) * monthlyRental;
    } else {
      dollarsToExpiry = 0;
    }
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
    renewalLetterIssueBy: asStr(row.RenewalLetterIssueBy),
    rentBasis,
    rentPerAnnum,
    rentPerSqm,
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
    rentPerSqm: asNum(row.RentPerSqm),
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
  RenewalLetterIssueBy,
  RentBasis, RentPerAnnum, RentPerSqm,
  ReviewType, ReviewIntervalMonths, NextReviewDate, LastReviewDate,
  LastReviewIncreasePercent, FixedReviewPercent,
  CpiRegion, CpiCapPercent, CpiFloorPercent,
  SecurityDepositRequired, SecurityDepositMethod, SecurityDepositHeld,
  Status, Comments, EscalationPercent, EscalationSchedule,
  BusinessTenanciesAct,
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
    const tenantIdParam = [{ name: "TenantId", type: TYPES.Int, value: tenantId }];
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
              SizeSqm, RentPerAnnum, RentPerSqm, Snapshot
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
      const key = noteAnchorKey(n.anchorKind, n.occupancyId ?? "", n.fieldKey ?? "");
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
        return { status: 400, jsonBody: { error: "LegalName (string) required" } };
      }
      if (typeof body.BuildingId !== "number") {
        return { status: 400, jsonBody: { error: "BuildingId (number) required" } };
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
            RenewalLetterIssueBy,
            RentBasis, RentPerAnnum, RentPerSqm,
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
            @RenewalLetterIssueBy,
            @RentBasis, @RentPerAnnum, @RentPerSqm,
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
      const updateParams: { name: string; type: any; value: any }[] = [];
      // Whitelist of column → tedious type. Keys are SQL column names (used to
      // build SET clauses), so an attacker controlling the request body can't
      // inject a column name they didn't add to this list — the loop ignores
      // unknown keys.
      const allowlist: Record<string, any> = {
        Abn: TYPES.NVarChar, AccountsEmail: TYPES.NVarChar,
        AccountsPhone: TYPES.NVarChar, Acn: TYPES.NVarChar,
        BuildingId: TYPES.Int,
        BusinessTenanciesAct: TYPES.NVarChar,
        Commencement: TYPES.Date, Comments: TYPES.NVarChar,
        CpiCapPercent: TYPES.Decimal, CpiFloorPercent: TYPES.Decimal,
        CpiRegion: TYPES.NVarChar, EscalationPercent: TYPES.Decimal,
        EscalationSchedule: TYPES.NVarChar, Expiry: TYPES.Date,
        FixedReviewPercent: TYPES.Decimal, IdNo: TYPES.NVarChar,
        InformationSheetAsAt: TYPES.NVarChar,
        InformationSheetReference: TYPES.NVarChar,
        LastReviewDate: TYPES.Date, LastReviewIncreasePercent: TYPES.Decimal,
        LegalName: TYPES.NVarChar, Lot: TYPES.NVarChar, MyobId: TYPES.NVarChar,
        NextReviewDate: TYPES.Date, OptionNoticeMonths: TYPES.Int,
        OptionPeriods: TYPES.NVarChar, PostalAddress: TYPES.NVarChar,
        PrimaryContactEmail: TYPES.NVarChar, PrimaryContactName: TYPES.NVarChar,
        PrimaryContactPhone: TYPES.NVarChar, RenewalLetterIssueBy: TYPES.NVarChar,
        RentBasis: TYPES.NVarChar, RentPerAnnum: TYPES.Decimal,
        RentPerSqm: TYPES.Decimal, ReviewIntervalMonths: TYPES.Int,
        ReviewType: TYPES.NVarChar, SecurityDepositHeld: TYPES.Decimal,
        SecurityDepositMethod: TYPES.NVarChar,
        SecurityDepositRequired: TYPES.NVarChar, Status: TYPES.NVarChar,
        StreetAddress: TYPES.NVarChar,
        TermMonths: TYPES.Int, TradingName: TYPES.NVarChar,
      };
      for (const col of Object.keys(allowlist)) {
        if (!Object.prototype.hasOwnProperty.call(body, col)) continue;
        const value = (body as any)[col];
        if (value === undefined) continue;
        setParts.push(`${col} = @${col}`);
        updateParams.push({ name: col, type: allowlist[col], value: normaliseValue(col, value) });
      }
      // Always bump audit fields on update.
      setParts.push("UpdatedAt = SYSUTCDATETIME()");
      setParts.push("UpdatedById = @UpdatedById");
      setParts.push("UpdatedByName = @UpdatedByName");
      updateParams.push({ name: "UpdatedById", type: TYPES.NVarChar, value: caller.id });
      updateParams.push({ name: "UpdatedByName", type: TYPES.NVarChar, value: caller.name });
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
      return { status: 404, jsonBody: { error: "Tenant disappeared after upsert" } };
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
    "Commencement", "Expiry", "NextReviewDate", "LastReviewDate",
  ]);
  if (dateCols.has(col) && typeof value === "string" && value.length > 10) {
    return value.slice(0, 10);
  }
  return value;
}

function buildTenantParams(
  body: Record<string, any>,
  caller: UserRef,
): { name: string; type: any; value: any }[] {
  const v = (k: string) => (body[k] === undefined ? null : normaliseValue(k, body[k]));
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
    { name: "PrimaryContactName", type: TYPES.NVarChar, value: v("PrimaryContactName") },
    { name: "PrimaryContactEmail", type: TYPES.NVarChar, value: v("PrimaryContactEmail") },
    { name: "PrimaryContactPhone", type: TYPES.NVarChar, value: v("PrimaryContactPhone") },
    { name: "Lot", type: TYPES.NVarChar, value: v("Lot") },
    { name: "InformationSheetAsAt", type: TYPES.NVarChar, value: v("InformationSheetAsAt") },
    { name: "InformationSheetReference", type: TYPES.NVarChar, value: v("InformationSheetReference") },
    { name: "Commencement", type: TYPES.Date, value: v("Commencement") },
    { name: "Expiry", type: TYPES.Date, value: v("Expiry") },
    { name: "TermMonths", type: TYPES.Int, value: v("TermMonths") },
    { name: "OptionPeriods", type: TYPES.NVarChar, value: v("OptionPeriods") },
    { name: "OptionNoticeMonths", type: TYPES.Int, value: v("OptionNoticeMonths") },
    { name: "RenewalLetterIssueBy", type: TYPES.NVarChar, value: v("RenewalLetterIssueBy") },
    { name: "RentBasis", type: TYPES.NVarChar, value: body.RentBasis ?? "fixedAnnual" },
    { name: "RentPerAnnum", type: TYPES.Decimal, value: v("RentPerAnnum") },
    { name: "RentPerSqm", type: TYPES.Decimal, value: v("RentPerSqm") },
    { name: "ReviewType", type: TYPES.NVarChar, value: body.ReviewType ?? "none" },
    { name: "ReviewIntervalMonths", type: TYPES.Int, value: v("ReviewIntervalMonths") },
    { name: "NextReviewDate", type: TYPES.Date, value: v("NextReviewDate") },
    { name: "LastReviewDate", type: TYPES.Date, value: v("LastReviewDate") },
    { name: "LastReviewIncreasePercent", type: TYPES.Decimal, value: v("LastReviewIncreasePercent") },
    { name: "FixedReviewPercent", type: TYPES.Decimal, value: v("FixedReviewPercent") },
    { name: "CpiRegion", type: TYPES.NVarChar, value: v("CpiRegion") },
    { name: "CpiCapPercent", type: TYPES.Decimal, value: v("CpiCapPercent") },
    { name: "CpiFloorPercent", type: TYPES.Decimal, value: v("CpiFloorPercent") },
    { name: "SecurityDepositRequired", type: TYPES.NVarChar, value: v("SecurityDepositRequired") },
    { name: "SecurityDepositMethod", type: TYPES.NVarChar, value: v("SecurityDepositMethod") },
    { name: "SecurityDepositHeld", type: TYPES.Decimal, value: v("SecurityDepositHeld") },
    { name: "Status", type: TYPES.NVarChar, value: body.Status ?? "current" },
    { name: "Comments", type: TYPES.NVarChar, value: v("Comments") },
    { name: "EscalationPercent", type: TYPES.Decimal, value: v("EscalationPercent") },
    { name: "EscalationSchedule", type: TYPES.NVarChar, value: v("EscalationSchedule") },
    { name: "BusinessTenanciesAct", type: TYPES.NVarChar, value: v("BusinessTenanciesAct") },
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
    const {
      OccupancyId, TenantId, BuildingId, Level, Area, SizeSqm, Notes,
    } = body;

    if (typeof OccupancyId !== "string" || !OccupancyId) {
      return { status: 400, jsonBody: { error: "OccupancyId (string UUID) required" } };
    }
    if (typeof TenantId !== "number" || typeof BuildingId !== "number") {
      return { status: 400, jsonBody: { error: "TenantId + BuildingId required" } };
    }
    if (typeof Level !== "string" || typeof Area !== "string") {
      return { status: 400, jsonBody: { error: "Level + Area (strings) required" } };
    }
    if (typeof SizeSqm !== "number" || !Number.isFinite(SizeSqm)) {
      return { status: 400, jsonBody: { error: "SizeSqm (number) required" } };
    }

    connection = await createConnection(token);

    // Fetch tenant rent fields up-front so the history snapshot is consistent.
    const tenantRows = await executeQuery(
      connection,
      `SELECT RentPerAnnum, RentPerSqm FROM dbo.Tenants WHERE TenantId = @TenantId`,
      [{ name: "TenantId", type: TYPES.Int, value: TenantId }],
    );
    if (tenantRows.length === 0) {
      return { status: 404, jsonBody: { error: "Tenant not found" } };
    }
    const rentPerAnnum = tenantRows[0].RentPerAnnum as number | null;
    const rentPerSqm = tenantRows[0].RentPerSqm as number | null;

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
            { name: "SizeSqm", type: TYPES.Decimal, value: SizeSqm },
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
            { name: "SizeSqm", type: TYPES.Decimal, value: SizeSqm },
            { name: "Notes", type: TYPES.NVarChar, value: Notes ?? null },
          ],
        );
      }

      // Append history row (cheap per upsert; we can layer a year-end rollup
      // job on top later if the table grows uncomfortably).
      const historyId = randomUuid();
      const snapshot = JSON.stringify({
        OccupancyId: effectiveOccupancyId, TenantId, BuildingId, Level, Area, SizeSqm,
        Notes, RentPerAnnum: rentPerAnnum,
        RentPerSqm: rentPerSqm,
      });
      const today = new Date().toISOString().slice(0, 10);
      await executeQuery(
        connection,
        `INSERT INTO dbo.TenantOccupancyHistory (
            HistoryId, OccupancyId, TenantId, EffectiveFrom,
            SizeSqm, RentPerAnnum, RentPerSqm, Snapshot
         )
         VALUES (@HistoryId, @OccupancyId, @TenantId, @EffectiveFrom,
                 @SizeSqm, @RentPerAnnum, @RentPerSqm, @Snapshot)`,
        [
          { name: "HistoryId", type: TYPES.NVarChar, value: historyId },
          { name: "OccupancyId", type: TYPES.NVarChar, value: effectiveOccupancyId },
          { name: "TenantId", type: TYPES.Int, value: TenantId },
          { name: "EffectiveFrom", type: TYPES.Date, value: today },
          { name: "SizeSqm", type: TYPES.Decimal, value: SizeSqm },
          { name: "RentPerAnnum", type: TYPES.Decimal, value: rentPerAnnum },
          { name: "RentPerSqm", type: TYPES.Decimal, value: rentPerSqm },
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
    return { status: 200, jsonBody: { occupancy: occupancyRowToApi(stored[0]) } };
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
    return { status: 200, jsonBody: { deleted: true, occupancyId: body.OccupancyId } };
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
      return { status: 400, jsonBody: { error: "AnchorKind must be tenant|occupancy|field" } };
    }
    if (AnchorKind === "occupancy" && typeof OccupancyId !== "string") {
      return { status: 400, jsonBody: { error: "OccupancyId required for occupancy anchor" } };
    }
    if (AnchorKind === "field" && typeof FieldKey !== "string") {
      return { status: 400, jsonBody: { error: "FieldKey required for field anchor" } };
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
        { name: "OccupancyId", type: TYPES.NVarChar, value: OccupancyId ?? null },
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
      ReviewId, NewRentPerAnnum, IncreasePercent, Source,
      CpiBaseValue, CpiCurrentValue, CpiIndexUsed,
    } = body;
    if (typeof ReviewId !== "string" || !ReviewId) {
      return { status: 400, jsonBody: { error: "ReviewId required" } };
    }
    if (typeof NewRentPerAnnum !== "number" || !Number.isFinite(NewRentPerAnnum)) {
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
          { name: "OldRent", type: TYPES.Decimal, value: oldRent },
          { name: "NewRent", type: TYPES.Decimal, value: NewRentPerAnnum },
          { name: "IncreasePercent", type: TYPES.Decimal, value: computedIncrease },
          { name: "CpiIndexUsed", type: TYPES.NVarChar, value: CpiIndexUsed ?? null },
          { name: "CpiBaseValue", type: TYPES.Decimal, value: CpiBaseValue ?? null },
          { name: "CpiCurrentValue", type: TYPES.Decimal, value: CpiCurrentValue ?? null },
          { name: "CompletedById", type: TYPES.NVarChar, value: caller.id },
          { name: "CompletedByName", type: TYPES.NVarChar, value: caller.name },
          { name: "Notes", type: TYPES.NVarChar, value: Source ? `Applied via ${Source}` : null },
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
          { name: "NewRent", type: TYPES.Decimal, value: NewRentPerAnnum },
          { name: "Today", type: TYPES.Date, value: todayIso },
          { name: "IncreasePercent", type: TYPES.Decimal, value: computedIncrease },
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
      ? [{ name: "BuildingId", type: TYPES.Int, value: Number(buildingIdParam) }]
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

// ── UUID helper (fallback when crypto.randomUUID isn't available) ────────────

function randomUuid(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// ── Route registration ───────────────────────────────────────────────────────

app.http("getRegisterTenants",   { methods: ["GET"],  authLevel: "anonymous", handler: getRegisterTenants });
app.http("getRegisterTenant",    { methods: ["GET"],  authLevel: "anonymous", handler: getRegisterTenant });
app.http("upsertRegisterTenant", { methods: ["POST"], authLevel: "anonymous", handler: upsertRegisterTenant });
app.http("upsertOccupancy",      { methods: ["POST"], authLevel: "anonymous", handler: upsertOccupancy });
app.http("deleteOccupancy",      { methods: ["POST"], authLevel: "anonymous", handler: deleteOccupancy });
app.http("createTenantNote",     { methods: ["POST"], authLevel: "anonymous", handler: createTenantNote });
app.http("deleteTenantNote",     { methods: ["POST"], authLevel: "anonymous", handler: deleteTenantNote });
app.http("deleteRegisterTenant", { methods: ["POST"], authLevel: "anonymous", handler: deleteRegisterTenant });
app.http("applyRentReview",      { methods: ["POST"], authLevel: "anonymous", handler: applyRentReview });
app.http("getReviewsDue",        { methods: ["GET"],  authLevel: "anonymous", handler: getReviewsDue });
