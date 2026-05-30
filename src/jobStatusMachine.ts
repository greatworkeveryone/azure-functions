// Pure, side-effect-free state machine for Jobs.Status + Jobs.AwaitingRole.
//
// The machine state is the composite { status, awaitingRole }. Awaiting role
// is part of the state because it disambiguates the two "Awaiting Approval"
// steps: (Awaiting Approval, facilities) is awaiting quote sign-off;
// (Awaiting Approval, accounts) is awaiting invoice approval after the work
// has been done.
//
// Mirrored in command-centre/src/types/jobStatusMachine.ts — keep in sync.

export enum JobStatus {
  NEW = "New",
  QUOTE = "Quote",
  AWAITING_APPROVAL = "Awaiting Approval",
  WORK = "Work",
  TENANT = "Tenant",
  DONE = "Done",
}

export enum AwaitingRole {
  FACILITIES = "facilities",
  ACCOUNTS = "accounts",
}

export enum JobEvent {
  QUOTE_REQUESTED = "QUOTE_REQUESTED",
  QUOTE_RECEIVED = "QUOTE_RECEIVED",
  QUOTE_APPROVED = "QUOTE_APPROVED",
  PO_CREATED = "PO_CREATED",
  WORK_COMPLETED = "WORK_COMPLETED",
  INVOICE_APPROVED = "INVOICE_APPROVED",
  TENANT_BLOCKED = "TENANT_BLOCKED",
  TENANT_UNBLOCKED = "TENANT_UNBLOCKED",
}

export interface JobState {
  status: JobStatus;
  awaitingRole: AwaitingRole;
}

type Transition = {
  from: JobState;
  event: JobEvent;
  to: JobState;
};

const F = AwaitingRole.FACILITIES;
const A = AwaitingRole.ACCOUNTS;

const TRANSITIONS: Transition[] = [
  { from: { status: JobStatus.NEW, awaitingRole: F }, event: JobEvent.QUOTE_REQUESTED, to: { status: JobStatus.QUOTE, awaitingRole: F } },
  { from: { status: JobStatus.NEW, awaitingRole: F }, event: JobEvent.QUOTE_RECEIVED, to: { status: JobStatus.AWAITING_APPROVAL, awaitingRole: F } },
  { from: { status: JobStatus.QUOTE, awaitingRole: F }, event: JobEvent.QUOTE_RECEIVED, to: { status: JobStatus.AWAITING_APPROVAL, awaitingRole: F } },
  { from: { status: JobStatus.AWAITING_APPROVAL, awaitingRole: F }, event: JobEvent.QUOTE_APPROVED, to: { status: JobStatus.WORK, awaitingRole: F } },
  { from: { status: JobStatus.AWAITING_APPROVAL, awaitingRole: F }, event: JobEvent.PO_CREATED, to: { status: JobStatus.WORK, awaitingRole: F } },
  { from: { status: JobStatus.WORK, awaitingRole: F }, event: JobEvent.WORK_COMPLETED, to: { status: JobStatus.AWAITING_APPROVAL, awaitingRole: A } },
  { from: { status: JobStatus.AWAITING_APPROVAL, awaitingRole: A }, event: JobEvent.INVOICE_APPROVED, to: { status: JobStatus.DONE, awaitingRole: A } },
];

function statesEqual(a: JobState, b: JobState): boolean {
  return a.status === b.status && a.awaitingRole === b.awaitingRole;
}

export function nextState(current: JobState, event: JobEvent): JobState | null {
  // Tenant block: reachable from any non-Done state, preserves awaitingRole
  // so we know which queue the job came from when it unblocks.
  if (event === JobEvent.TENANT_BLOCKED) {
    return current.status === JobStatus.DONE
      ? null
      : { status: JobStatus.TENANT, awaitingRole: current.awaitingRole };
  }
  // Returning from a tenant block lands back on Work / facilities.
  if (event === JobEvent.TENANT_UNBLOCKED) {
    return current.status === JobStatus.TENANT
      ? { status: JobStatus.WORK, awaitingRole: F }
      : null;
  }
  const match = TRANSITIONS.find((t) => statesEqual(t.from, current) && t.event === event);
  return match?.to ?? null;
}

/**
 * Whether the picker / addJobEvent may set status to `target` from the given
 * current composite state. A target is reachable if either:
 *   - A defined system-event edge from `current` lands on a state with that status, OR
 *   - It's the Tenant escape / Tenant return shortcut (always available where allowed).
 *
 * Returns false for `current.status === target` (no-op) and for Done (terminal).
 */
export function canTransition(current: JobState, target: JobStatus): boolean {
  if (current.status === target) return false;
  if (current.status === JobStatus.DONE) return false;
  if (target === JobStatus.TENANT) return true;
  if (current.status === JobStatus.TENANT && target === JobStatus.WORK) return true;
  return TRANSITIONS.some((t) => statesEqual(t.from, current) && t.to.status === target);
}

export function allowedNextStatuses(current: JobState): JobStatus[] {
  return Object.values(JobStatus).filter((s) => canTransition(current, s));
}

/**
 * Given the current composite state and a status the user picked manually
 * (via the picker / addJobEvent), return the resolved composite state
 * (status + awaitingRole). The new awaitingRole is inferred from the
 * matching transition edge — e.g. picking AWAITING_APPROVAL from WORK
 * flips role to accounts. Returns null if the pick is illegal.
 */
export function resolveManualTarget(
  current: JobState,
  targetStatus: JobStatus,
): JobState | null {
  if (!canTransition(current, targetStatus)) return null;
  if (targetStatus === JobStatus.TENANT) {
    return { status: JobStatus.TENANT, awaitingRole: current.awaitingRole };
  }
  if (current.status === JobStatus.TENANT && targetStatus === JobStatus.WORK) {
    return { status: JobStatus.WORK, awaitingRole: F };
  }
  const edge = TRANSITIONS.find(
    (t) => statesEqual(t.from, current) && t.to.status === targetStatus,
  );
  return edge?.to ?? null;
}
