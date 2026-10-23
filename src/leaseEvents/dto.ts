// A dbo.LeaseEvents row as the endpoints answer it (camelCase; dates as
// "YYYY-MM-DD"; instants as ISO strings; the rowversion as 16 hex digits).

import type { SqlRow } from "../db";
import type { LeaseEventState, LeaseEventType } from "../leaseEventMachine";
import type { OptionMethodKind } from "../leaseOptions";
import { sqlDateToIso } from "../nextReviewDate";
import { isoTimestamp, rowVersionHex } from "../tenancyScheduleWrite";

export interface OptionTerms {
  /** Increase % of a fixed review during the term. */
  fixedPercent: number | null;
  intervalMonths: number;
  /** The new expiry the term ends on. */
  newExpiry: string;
  ongoingMethod: OptionMethodKind;
  /** The first day of the term. */
  optionStart: string;
  startMethod: OptionMethodKind;
  termMonths: number;
}

export interface LeaseEventDto {
  buildingId: number | null;
  createdAt: string | null;
  deadlineOn: string | null;
  decided: { at: string | null; byName: string | null; byUserId: number | null } | null;
  lateNotice: boolean;
  leaseEventId: string;
  leaseExpiry: string | null;
  noticeDate: string | null;
  noticeDocument: string | null;
  outcome: string | null;
  outcomeDetails: Record<string, unknown> | null;
  outcomeReason: string | null;
  recorded: { at: string | null; byName: string | null; byUserId: number | null } | null;
  rowVersion: string;
  state: LeaseEventState;
  tenantId: number;
  tenantName: string;
  terms: OptionTerms | null;
  type: LeaseEventType;
  updatedAt: string | null;
  windowOpensOn: string | null;
}

function json<T>(value: unknown): T | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  try {
    const parsed = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as T) : null;
  } catch {
    return null;
  }
}

const idOrNull = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));
const text = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value.trim() : null);

export function toLeaseEventDto(row: SqlRow): LeaseEventDto {
  const tenantId = Number(row.TenantId);
  const recordedAt = isoTimestamp(row.RecordedAt);
  const decidedAt = isoTimestamp(row.DecidedAt);
  return {
    buildingId: idOrNull(row.BuildingId),
    createdAt: isoTimestamp(row.CreatedAt),
    deadlineOn: sqlDateToIso(row.DeadlineOn),
    decided: decidedAt || row.DecidedByName ? { at: decidedAt, byName: text(row.DecidedByName), byUserId: idOrNull(row.DecidedById) } : null,
    lateNotice: row.LateNotice === true || row.LateNotice === 1,
    leaseEventId: String(row.LeaseEventId),
    leaseExpiry: sqlDateToIso(row.LeaseExpiry),
    noticeDate: sqlDateToIso(row.NoticeDate),
    noticeDocument: text(row.NoticeDocument),
    outcome: text(row.Outcome),
    outcomeDetails: json<Record<string, unknown>>(row.OutcomeDetails),
    outcomeReason: text(row.OutcomeReason),
    recorded: recordedAt || row.RecordedByName ? { at: recordedAt, byName: text(row.RecordedByName), byUserId: idOrNull(row.RecordedById) } : null,
    rowVersion: rowVersionHex(row.Version),
    state: row.State as LeaseEventState,
    tenantId,
    tenantName: text(row.TradingName) ?? text(row.LegalName) ?? `Tenancy ${tenantId}`,
    terms: json<OptionTerms>(row.Terms),
    type: row.Type as LeaseEventType,
    updatedAt: isoTimestamp(row.UpdatedAt),
    windowOpensOn: sqlDateToIso(row.WindowOpensOn),
  };
}
