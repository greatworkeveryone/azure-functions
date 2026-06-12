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
  // Standing-contract fast path (WP10): authorise work directly from New,
  // skipping the quote round. Legal ONLY for contract jobs (isContract = true).
  WORK_AUTHORIZED = "WORK_AUTHORIZED",
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

/**
 * Optional context the machine consults for the tenant-unblock restore.
 * `preBlockState` is the composite the job sat in immediately before
 * TENANT_BLOCKED fired (captured by the caller — see addJobEvent). When
 * present it is restored exactly on unblock, so a job blocked at
 * (Awaiting Approval, facilities) returns there instead of leapfrogging into
 * Work without QUOTE_APPROVED. Legacy blocked jobs with no captured state
 * fall back to the historical (Work, facilities) landing.
 */
export interface TransitionOptions {
  preBlockState?: JobState;
  /**
   * Whether the job runs under a standing maintenance contract (WP10). Contract
   * jobs are pre-authorised — they may move New → Work via WORK_AUTHORIZED,
   * skipping the quote round entirely while every financial control (invoice
   * approval, limits, director tier) stays intact downstream. Defaults to false
   * (omitted) so non-contract jobs are behaviour-identical to before WP10.
   */
  isContract?: boolean;
}

/** The safe landing for an unblock with no (or a nonsensical) pre-block state. */
const UNBLOCK_FALLBACK: JobState = { status: JobStatus.WORK, awaitingRole: F };

/**
 * Resolve where TENANT_UNBLOCKED / a manual Tenant → Work pick lands. Restores
 * the captured pre-block state when it's a sane re-entry point, otherwise the
 * legacy fallback. A pre-block state of Tenant or Done is rejected (you can't
 * have blocked from Done, and a Tenant pre-block can't be a restore target).
 */
function resolveUnblockTarget(preBlockState: JobState | undefined): JobState {
  if (
    preBlockState &&
    preBlockState.status !== JobStatus.TENANT &&
    preBlockState.status !== JobStatus.DONE
  ) {
    return preBlockState;
  }
  return UNBLOCK_FALLBACK;
}

export function nextState(
  current: JobState,
  event: JobEvent,
  opts?: TransitionOptions,
): JobState | null {
  // Tenant block: reachable from any non-Done state, preserves awaitingRole
  // so we know which queue the job came from when it unblocks.
  if (event === JobEvent.TENANT_BLOCKED) {
    return current.status === JobStatus.DONE
      ? null
      : { status: JobStatus.TENANT, awaitingRole: current.awaitingRole };
  }
  // Returning from a tenant block restores the captured pre-block state
  // exactly (e.g. back to Awaiting Approval if the quote was never approved),
  // falling back to (Work, facilities) when none was captured.
  if (event === JobEvent.TENANT_UNBLOCKED) {
    return current.status === JobStatus.TENANT
      ? resolveUnblockTarget(opts?.preBlockState)
      : null;
  }
  // Standing-contract fast path: New → Work, skipping quotes. Legal only when
  // the job is a contract job and only from (New, facilities).
  if (event === JobEvent.WORK_AUTHORIZED) {
    return opts?.isContract &&
      current.status === JobStatus.NEW &&
      current.awaitingRole === F
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
export function canTransition(
  current: JobState,
  target: JobStatus,
  opts?: TransitionOptions,
): boolean {
  if (current.status === target) return false;
  if (current.status === JobStatus.DONE) return false;
  if (target === JobStatus.TENANT) return true;
  if (current.status === JobStatus.TENANT && target === JobStatus.WORK) return true;
  // Standing-contract jobs may start work directly from New (WORK_AUTHORIZED),
  // bypassing the quote round. Non-contract jobs cannot — they keep the
  // New → Quote/Awaiting-Approval path only.
  if (
    opts?.isContract &&
    current.status === JobStatus.NEW &&
    current.awaitingRole === F &&
    target === JobStatus.WORK
  ) {
    return true;
  }
  return TRANSITIONS.some((t) => statesEqual(t.from, current) && t.to.status === target);
}

export function allowedNextStatuses(
  current: JobState,
  opts?: TransitionOptions,
): JobStatus[] {
  return Object.values(JobStatus).filter((s) => canTransition(current, s, opts));
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
  opts?: TransitionOptions,
): JobState | null {
  if (!canTransition(current, targetStatus, opts)) return null;
  if (targetStatus === JobStatus.TENANT) {
    return { status: JobStatus.TENANT, awaitingRole: current.awaitingRole };
  }
  // A manual Tenant → Work pick is the unblock path: restore the captured
  // pre-block state (so the picker label / write matches where the job
  // actually returns), falling back to (Work, facilities).
  if (current.status === JobStatus.TENANT && targetStatus === JobStatus.WORK) {
    return resolveUnblockTarget(opts?.preBlockState);
  }
  // Standing-contract "Start work" — New → Work, no quote. canTransition has
  // already gated this on opts.isContract, so we only reach here for contracts.
  if (current.status === JobStatus.NEW && targetStatus === JobStatus.WORK) {
    return { status: JobStatus.WORK, awaitingRole: F };
  }
  const edge = TRANSITIONS.find(
    (t) => statesEqual(t.from, current) && t.to.status === targetStatus,
  );
  return edge?.to ?? null;
}
