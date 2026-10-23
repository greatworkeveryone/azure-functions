// Shared shapes for the escalation engine (WP20, PLAN §3.7, D4). Pure types and
// constants only, so every other module in this folder can import it freely.

export type EscalationKind = "attention" | "authority";

/** open -> acknowledged -> resolved; open or acknowledged -> superseded (a new
 *  row at the next level); open -> withdrawn. */
export type EscalationStatus = "open" | "acknowledged" | "resolved" | "superseded" | "withdrawn";

/** The statuses an escalation can still be acted on in. */
export const LIVE_STATUSES: readonly EscalationStatus[] = ["open", "acknowledged"];

/** none: nobody to tell; pending: committed, not yet sent; sent: delivered;
 *  failed: the last send failed (a retry is due unless the attempts ran out). */
export type NotificationState = "none" | "pending" | "sent" | "failed";

export type PolicyClock = "business" | "wall";

/** yes: move up a level when the SLA passes unacknowledged; reminder / nudge:
 *  repeat the same level; no: leave it to people. */
export type AutoReescalate = "yes" | "reminder" | "nudge" | "no";

export type RaisedByKind = "user" | "system";

export type LadderToken = "raiser_manager" | "authority_route";

/** One level of a policy's ladder, as stored in dbo.EscalationPolicies.Ladder. */
export interface LadderEntry {
  /** Everyone active in this AppUsers role. */
  role?: string;
  /** Resolved when the escalation is raised (PLAN §3.7 rule 2; WP21's route). */
  token?: LadderToken;
  /** A person named when the escalation is raised (RaiseInput.userTargets). */
  userTarget?: boolean;
  /** Hours on the policy's clock before this level is overdue. null = no SLA. */
  slaHours?: number | null;
}

export interface EscalationPolicy {
  active: boolean;
  autoReescalate: AutoReescalate;
  clock: PolicyClock;
  kind: EscalationKind;
  ladder: LadderEntry[];
  policyKey: string;
  updatedAt: Date | null;
  updatedBy: string | null;
  urgent: boolean;
}

/** An escalation as stored. Dates are instants; rowVersion is base64. */
export interface EscalationRow {
  acknowledgedAt: Date | null;
  acknowledgedByName: string | null;
  acknowledgedByUserId: number | null;
  buildingId: number | null;
  context: Record<string, unknown> | null;
  createdAt: Date;
  dueAt: Date | null;
  escalationId: number;
  kind: EscalationKind;
  lastFollowUpAt: Date | null;
  lastNotificationAttemptAt: Date | null;
  lastNotificationError: string | null;
  lastNotifiedAt: Date | null;
  level: number;
  noIndependentTarget: boolean;
  note: string | null;
  notificationAttempts: number;
  notificationState: NotificationState;
  parentEscalationId: number | null;
  policyKey: string;
  raisedByKind: RaisedByKind;
  raisedByName: string;
  raisedByUserId: number | null;
  reason: string | null;
  resolutionCode: string | null;
  resolutionNote: string | null;
  resolvedAt: Date | null;
  resolvedByName: string | null;
  resolvedByUserId: number | null;
  rowVersion: string;
  status: EscalationStatus;
  subjectId: string;
  subjectType: string;
  summary: string;
  targetRole: string | null;
  targetUserId: number | null;
  updatedAt: Date;
  urgent: boolean;
}

/** An active AppUsers row, as the ladder and the notifier need it. */
export interface DirectoryUser {
  email: string | null;
  name: string;
  role: string;
  userId: number;
}

/** Who "Escalate further" would send an escalation to (getEscalation's `next`). */
export interface NextLevelDto {
  /** The eligible people's names; empty when the level is only an env-list mailbox. */
  names: string[];
  roleLabel: string;
}

/** The signed-in person asking, for visibility and permission checks. */
export interface Viewer {
  name: string;
  roles: string[];
  userId: number | null;
}

/** Manual escalation reasons (the dialog's four choices). */
export const MANUAL_REASONS = ["stalled", "needs_decision", "over_my_authority", "other"] as const;
export type ManualReason = (typeof MANUAL_REASONS)[number];

export const REASON_LABELS: Record<ManualReason, string> = {
  needs_decision: "Needs a decision",
  other: "Other",
  over_my_authority: "Over my authority",
  stalled: "Stalled",
};

/** Why an escalation ended, stored in ResolutionCode. */
export const RESOLUTION_CODES = {
  // resolved by a person
  actionTaken: "action_taken",
  noActionNeeded: "no_action_needed",
  other: "other",
  // ended by the engine
  conditionCleared: "condition_cleared",
  // withdrawn by the raiser
  withdrawn: "withdrawn",
  // superseded: why a new row took over
  escalated: "escalated",
  followUp: "follow_up",
  reminder: "reminder",
  slaBreach: "sla_breach",
} as const;

/** Codes a person may pick when resolving. */
export const MANUAL_RESOLUTION_CODES: readonly string[] = [
  RESOLUTION_CODES.actionTaken,
  RESOLUTION_CODES.noActionNeeded,
  RESOLUTION_CODES.other,
];

export const SUMMARY_MAX_CHARS = 400;
export const NOTE_MAX_CHARS = 2000;

/** The name system-raised escalations carry (RaisedByName). */
export const SYSTEM_NAME = "Floorplan";
