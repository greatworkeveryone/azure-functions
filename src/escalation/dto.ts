// An escalation as the API sends it: ISO dates, labels, what the viewer can do
// with it, and the version to send back with any change (rowVersion, base64).

import { getAdapter } from "./adapters/registry";
import { availableActions, isOversight, type ActionAvailability } from "./permissions";
import { roleLabel } from "./roles";
import { REASON_LABELS, type DirectoryUser, type EscalationRow, type ManualReason, type Viewer } from "./types";

export interface EscalationDto {
  actions: ActionAvailability;
  acknowledgedAt: string | null;
  acknowledgedByName: string | null;
  acknowledgedByUserId: number | null;
  buildingId: number | null;
  context: Record<string, unknown> | null;
  createdAt: string;
  /** In-app path that opens the subject (relative), or null for an unknown subject type. */
  deepLink: string | null;
  dueAt: string | null;
  escalationId: number;
  isOverdue: boolean;
  kind: string;
  /** Directors and admin only: why the last email failed. */
  lastNotificationError: string | null;
  level: number;
  noIndependentTarget: boolean;
  note: string | null;
  notificationAttempts: number;
  notificationState: string;
  parentEscalationId: number | null;
  policyKey: string;
  raisedByKind: string;
  raisedByName: string;
  raisedByUserId: number | null;
  reason: string | null;
  reasonLabel: string | null;
  resolutionCode: string | null;
  resolutionNote: string | null;
  resolvedAt: string | null;
  resolvedByName: string | null;
  resolvedByUserId: number | null;
  rowVersion: string;
  status: string;
  subjectId: string;
  subjectType: string;
  summary: string;
  targetRole: string | null;
  targetRoleLabel: string;
  targetUserId: number | null;
  targetUserName: string | null;
  updatedAt: string;
  urgent: boolean;
}

const iso = (date: Date | null): string | null => (date ? date.toISOString() : null);

export function toDto(row: EscalationRow, viewer: Viewer, now: Date, directory: readonly DirectoryUser[] = []): EscalationDto {
  const adapter = getAdapter(row.subjectType);
  const target = row.targetUserId === null ? null : directory.find((user) => user.userId === row.targetUserId);
  return {
    acknowledgedAt: iso(row.acknowledgedAt),
    acknowledgedByName: row.acknowledgedByName,
    acknowledgedByUserId: row.acknowledgedByUserId,
    actions: availableActions(viewer, row),
    buildingId: row.buildingId,
    context: row.context,
    createdAt: row.createdAt.toISOString(),
    deepLink: adapter ? adapter.deepLink(row.subjectId) : null,
    dueAt: iso(row.dueAt),
    escalationId: row.escalationId,
    isOverdue: row.status === "open" && row.dueAt !== null && row.dueAt.getTime() <= now.getTime(),
    kind: row.kind,
    lastNotificationError: isOversight(viewer) ? row.lastNotificationError : null,
    level: row.level,
    noIndependentTarget: row.noIndependentTarget,
    note: row.note,
    notificationAttempts: row.notificationAttempts,
    notificationState: row.notificationState,
    parentEscalationId: row.parentEscalationId,
    policyKey: row.policyKey,
    raisedByKind: row.raisedByKind,
    raisedByName: row.raisedByName,
    raisedByUserId: row.raisedByUserId,
    reason: row.reason,
    reasonLabel: row.reason ? (REASON_LABELS[row.reason as ManualReason] ?? row.reason) : null,
    resolutionCode: row.resolutionCode,
    resolutionNote: row.resolutionNote,
    resolvedAt: iso(row.resolvedAt),
    resolvedByName: row.resolvedByName,
    resolvedByUserId: row.resolvedByUserId,
    rowVersion: row.rowVersion,
    status: row.status,
    subjectId: row.subjectId,
    subjectType: row.subjectType,
    summary: row.summary,
    targetRole: row.targetRole,
    targetRoleLabel: roleLabel(row.targetRole),
    targetUserId: row.targetUserId,
    targetUserName: target?.name ?? row.acknowledgedByName,
    updatedAt: row.updatedAt.toISOString(),
    urgent: row.urgent,
  };
}
