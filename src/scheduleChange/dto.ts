// The wire shape of a schedule change request (camelCase JSON, like the rent
// review endpoints). The frontend mirrors ScheduleChangeDto.

import type { SqlRow } from "../db";
import { validateReliefShape } from "../scheduleCharges";
import { isoTimestamp, rowVersionHex } from "../tenancyScheduleWrite";
import { type ReliefPayload, reliefSummary, SCHEDULE_CHANGE_KINDS, SCHEDULE_CHANGE_STATES, type ScheduleChangeKind, type ScheduleChangeState } from "./types";

export interface ScheduleChangeDto {
  buildingId: number | null;
  /** Who ratified, rejected or withdrew it, when, and their note; null while pending. */
  decided: { at: string | null; byName: string | null; note: string | null; userId: number | null } | null;
  kind: ScheduleChangeKind;
  /** The proposed change: a relief's { from, to, kind, value, scope }. */
  payload: Record<string, unknown>;
  /** Why it was asked for. */
  reason: string;
  /** Kind relief: the payload as a relief; null when it can't be read. */
  relief: ReliefPayload | null;
  requested: { at: string | null; byName: string; userId: number | null };
  requestId: string;
  /** Hex of ScheduleChangeRequests.Version: every decision sends it back, a mismatch is a 409. */
  rowVersion: string;
  state: ScheduleChangeState;
  /** One line with the figures (the readers of this DTO may see the rent). */
  summary: string;
  tenantId: number;
  /** Trading name, else legal name. */
  tenantName: string;
}

const text = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value.trim() : null);
const whole = (value: unknown): number | null => {
  const n = value === null || value === undefined ? Number.NaN : Number(value);
  return Number.isInteger(n) ? n : null;
};

export function parsePayload(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** A relief request's payload as a relief, or null when it doesn't read as one. */
export function reliefOfRow(row: SqlRow): ReliefPayload | null {
  if (row.Kind !== "relief") return null;
  const shape = validateReliefShape(parsePayload(row.Payload));
  return shape.ok ? shape.relief : null;
}

export function changeTenantName(row: SqlRow): string {
  return text(row.TradingName) ?? text(row.LegalName) ?? `Tenancy ${row.TenantId}`;
}

/** A request row as store.ts selects it. */
export function toChangeDto(row: SqlRow): ScheduleChangeDto {
  const kind = String(row.Kind) as ScheduleChangeKind;
  const state = String(row.State) as ScheduleChangeState;
  if (!SCHEDULE_CHANGE_KINDS.includes(kind)) throw new Error(`Schedule change ${row.RequestId} has an unknown kind "${row.Kind}"`);
  if (!SCHEDULE_CHANGE_STATES.includes(state)) throw new Error(`Schedule change ${row.RequestId} has an unknown state "${row.State}"`);
  const relief = reliefOfRow(row);
  return {
    buildingId: whole(row.BuildingId),
    decided:
      state === "pending"
        ? null
        : { at: isoTimestamp(row.DecidedAt), byName: text(row.DecidedByName), note: text(row.DecisionNote), userId: whole(row.DecidedById) },
    kind,
    payload: parsePayload(row.Payload),
    reason: String(row.Reason ?? ""),
    relief,
    requested: { at: isoTimestamp(row.RequestedAt), byName: text(row.RequestedByName) ?? "someone", userId: whole(row.RequestedById) },
    requestId: String(row.RequestId),
    rowVersion: rowVersionHex(row.Version),
    state,
    summary: relief ? reliefSummary(relief) : kind.replace(/_/g, " "),
    tenantId: Number(row.TenantId),
    tenantName: changeTenantName(row),
  };
}
