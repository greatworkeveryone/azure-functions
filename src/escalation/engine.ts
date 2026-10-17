// The escalation engine (PLAN §3.7, D4): raise, acknowledge, resolve, withdraw,
// escalate further and auto-resolve. It wraps a domain's state and never makes
// the domain's decision: an authority escalation ends when the decision is made,
// and the engine's resolve refuses it.
//
// Every operation is one transaction that holds the escalation row, changes it,
// lets the subject's adapter keep its own flags in step, and writes its row in the
// decision ledger. If the ledger write fails the whole thing rolls back: no
// ledger row, no decision. Emails go out afterwards (notifier.ts) and can fail
// without touching the escalation.
//
// Callers check who may do what (permissions.ts) before calling in; the engine
// checks the state: that the row exists, is in the right status, and, when the
// caller passes the version it read, that nobody changed it since (409).

import { randomUUID } from "crypto";
import type { Connection } from "tedious";
import { beginTransaction, commitTransaction, rollbackTransaction } from "../db";
import { record, type LedgerAction, type LedgerActor, type LedgerEntryInput } from "../ledger";
import "./adapters";
import { requireAdapter, type EscalationAdapter } from "./adapters/registry";
import { addClockHours, holidaysFromEnv } from "./businessTime";
import { fallbackEmailsByRole } from "./config";
import { isDecisionRow } from "./decisionRows";
import { EscalationError, isUniqueViolation } from "./errors";
import { LadderError, levelOfRole, resolveTarget, type AuthorityRouteStep, type ResolvedTarget } from "./ladder";
import { notifyPreviousLevel, notifyRaiserResolved, notifyTargets, type NotifyEvent, type NotifyOptions } from "./notifier";
import { getPolicy } from "./policies";
import { roleLabel } from "./roles";
import {
  findLiveEscalation,
  getEscalationRow,
  insertEscalation,
  listActiveUsers,
  listLiveForSubject,
  updateEscalation,
  type EscalationChanges,
  type NewEscalation,
} from "./store";
import {
  LIVE_STATUSES,
  MANUAL_RESOLUTION_CODES,
  NOTE_MAX_CHARS,
  RESOLUTION_CODES,
  SUMMARY_MAX_CHARS,
  SYSTEM_NAME,
  type DirectoryUser,
  type EscalationPolicy,
  type EscalationRow,
  type EscalationStatus,
} from "./types";

// ── Shared pieces ────────────────────────────────────────────────────────────

/** The actor the sweep acts as. */
export const SWEEP_ACTOR: LedgerActor = { kind: "system", name: "escalationSweepTimer" };

const actorUserId = (actor: LedgerActor): number | null => (actor.kind === "user" ? actor.userId : null);
const actorName = (actor: LedgerActor): string => (actor.kind === "user" ? actor.name : SYSTEM_NAME);

async function inTransaction<T>(connection: Connection, work: () => Promise<T>): Promise<T> {
  await beginTransaction(connection);
  try {
    const result = await work();
    await commitTransaction(connection);
    return result;
  } catch (error) {
    await rollbackTransaction(connection).catch(() => undefined);
    throw error;
  }
}

async function lockRow(connection: Connection, escalationId: number, expectedRowVersion?: string): Promise<EscalationRow> {
  const row = await getEscalationRow(connection, escalationId, { forUpdate: true });
  if (!row) throw new EscalationError("not_found", "That escalation doesn't exist");
  if (expectedRowVersion !== undefined && row.rowVersion !== expectedRowVersion) {
    throw new EscalationError("stale", "Someone else changed this escalation. Reload it to see their change.", { current: row });
  }
  return row;
}

function requireStatus(row: EscalationRow, allowed: readonly EscalationStatus[]): void {
  if (allowed.includes(row.status)) return;
  throw new EscalationError("not_live", `This escalation is already ${row.status}.`, { current: row });
}

async function reload(connection: Connection, escalationId: number): Promise<EscalationRow> {
  const row = await getEscalationRow(connection, escalationId);
  if (!row) throw new EscalationError("not_found", "That escalation doesn't exist");
  return row;
}

async function applyChanges(connection: Connection, locked: EscalationRow, changes: EscalationChanges): Promise<void> {
  // We hold the row's lock, so the version we read is still current; a false
  // here means something outside this engine changed the row in the meantime.
  if (!(await updateEscalation(connection, locked.escalationId, locked.rowVersion, changes))) {
    throw new EscalationError("stale", "Someone else changed this escalation. Reload it to see their change.", { current: locked });
  }
}

function snapshot(row: EscalationRow): Record<string, unknown> {
  return {
    dueAt: row.dueAt ? row.dueAt.toISOString() : null,
    kind: row.kind,
    level: row.level,
    noIndependentTarget: row.noIndependentTarget,
    parentEscalationId: row.parentEscalationId,
    policyKey: row.policyKey,
    status: row.status,
    subject: `${row.subjectType}:${row.subjectId}`,
    targetRole: row.targetRole,
    targetUserId: row.targetUserId,
    urgent: row.urgent,
  };
}

function ledgerEntry(
  action: LedgerAction,
  actor: LedgerActor,
  row: EscalationRow,
  adapter: EscalationAdapter,
  extra: Partial<LedgerEntryInput> = {},
): LedgerEntryInput {
  const scope = adapter.ledgerScope?.(row) ?? {};
  return {
    action,
    actor,
    buildingId: row.buildingId,
    jobId: scope.jobId ?? null,
    subject: { id: row.escalationId, type: "escalation" },
    tenantId: scope.tenantId ?? null,
    ...extra,
  };
}

function trimNote(value: string | null | undefined): string | null {
  const text = value?.trim();
  if (!text) return null;
  if (text.length > NOTE_MAX_CHARS) throw new EscalationError("bad_request", `Notes can be at most ${NOTE_MAX_CHARS} characters`);
  return text;
}

function ladderFailure(error: unknown): never {
  if (error instanceof LadderError) {
    throw new EscalationError(error.code === "target_not_eligible" ? "target_not_eligible" : "bad_request", error.message);
  }
  throw error;
}

/** The person asking, as the ladder needs them; null for the system. */
function raiserFor(actor: LedgerActor, users: readonly DirectoryUser[]) {
  if (actor.kind !== "user") return null;
  return { email: users.find((user) => user.userId === actor.userId)?.email ?? null, role: actor.role, userId: actor.userId };
}

function raiserOf(row: Pick<EscalationRow, "raisedByKind" | "raisedByUserId">, users: readonly DirectoryUser[]) {
  if (row.raisedByKind !== "user" || row.raisedByUserId === null) return null;
  const person = users.find((user) => user.userId === row.raisedByUserId);
  return { email: person?.email ?? null, role: person?.role ?? null, userId: row.raisedByUserId };
}

function contextNumbers(context: EscalationRow["context"], key: string): number[] {
  const value = context?.[key];
  return Array.isArray(value) ? value.filter((id): id is number => typeof id === "number") : [];
}

// ── raise ────────────────────────────────────────────────────────────────────

export interface RaiseInput {
  actor: LedgerActor;
  authorityRoute?: readonly AuthorityRouteStep[];
  /** Overrides the adapter's building. */
  buildingId?: number | null;
  /** Merged over the adapter's context. */
  context?: Record<string, unknown>;
  /** Shared by the ledger rows of the operation this raise is part of (a decision
   *  request writes its own row beside the engine's), so they can be read together. */
  correlationId?: string;
  /** Overrides the SLA of the level it lands on: the moment it moves up if nobody
   *  has acted. null means never. Left out, the ladder's `slaHours` decides. For a
   *  caller whose deadline is its own (a decision request's tier). */
  dueAt?: Date | null;
  /** Authority escalations: whoever prepared or created the subject. */
  excludeUserIds?: readonly number[];
  /** Appended to the subject's name: "Job #12 · Leaking roof — Needs an owner". */
  headline?: string;
  note?: string | null;
  notify?: NotifyOptions;
  now?: Date;
  policyKey: string;
  /** PLAN §3.7 rule 4: the person the raiser picked at the resolved level. */
  preferredUserId?: number | null;
  reason?: string | null;
  /** For callers that just evaluated the condition (the sweep). */
  skipConditionCheck?: boolean;
  /** Start at the first ladder level holding this role instead of the bottom:
   *  a rent reduction goes to the directors at once, a re-raised approval goes
   *  back to the level it had reached. Rules 1-3 still apply from there. */
  startAtRole?: string | null;
  subjectId: string;
  subjectType: string;
  /** Replaces the subject's name and the headline altogether. */
  summary?: string;
  /** Overrides the policy's urgency for this one escalation. */
  urgent?: boolean;
  userTargets?: readonly number[];
}

export type RaiseResult = { created: boolean; escalation: EscalationRow };

function composeSummary(input: Pick<RaiseInput, "headline" | "summary">, subjectSummary: string): string {
  const text = input.summary ?? (input.headline ? `${subjectSummary} — ${input.headline}` : subjectSummary);
  return text.slice(0, SUMMARY_MAX_CHARS);
}

/** Where an escalation would go, without writing anything (the dialog's preview). */
export async function previewTarget(
  connection: Connection,
  input: Pick<RaiseInput, "actor" | "authorityRoute" | "excludeUserIds" | "policyKey" | "preferredUserId" | "userTargets"> & { now?: Date },
): Promise<{ policy: EscalationPolicy; target: ResolvedTarget }> {
  const now = input.now ?? new Date();
  const policy = await getPolicy(connection, input.policyKey, now.getTime());
  if (!policy) throw new EscalationError("unknown_policy", `There is no escalation policy "${input.policyKey}"`);
  const users = await listActiveUsers(connection);
  try {
    const target = resolveTarget({
      activeUsers: users,
      authorityRoute: input.authorityRoute,
      excludeUserIds: input.excludeUserIds,
      fallbackEmails: fallbackEmailsByRole(),
      kind: policy.kind,
      ladder: policy.ladder,
      onNoTarget: "directors",
      preferredUserId: input.preferredUserId,
      raiser: raiserFor(input.actor, users),
      userTargets: input.userTargets,
    });
    // "directors" never returns null: with nobody eligible it flags the escalation.
    if (!target) throw new EscalationError("bad_request", "This escalation has nowhere to go");
    return { policy, target };
  } catch (error) {
    return ladderFailure(error);
  }
}

/** Everything a raise has worked out before it writes: the values of the row, the
 *  adapter, and who is in the directory. */
interface RaisePlan {
  adapter: EscalationAdapter;
  input: RaiseInput;
  target: ResolvedTarget;
  users: DirectoryUser[];
  values: NewEscalation;
}

/**
 * The checks and the target of a raise, without a write: the policy is there and
 * on, the subject exists, an attention condition holds, nothing is live for it
 * already (then that one is the answer), and the ladder has someone to send it to.
 */
async function planRaise(connection: Connection, input: RaiseInput): Promise<{ existing: EscalationRow } | { plan: RaisePlan }> {
  const now = input.now ?? new Date();
  const policy = await getPolicy(connection, input.policyKey, now.getTime());
  if (!policy) throw new EscalationError("unknown_policy", `There is no escalation policy "${input.policyKey}"`);
  if (!policy.active) throw new EscalationError("policy_inactive", `The escalation policy "${input.policyKey}" is switched off`);

  const adapter = requireAdapter(input.subjectType);
  const subject = await adapter.loadSummary(connection, input.subjectId);
  if (!subject) throw new EscalationError("subject_not_found", "The thing you are escalating no longer exists");

  if (policy.kind === "attention" && !input.skipConditionCheck) {
    const ref = { policyKey: input.policyKey, subjectId: input.subjectId, subjectType: input.subjectType };
    if (!(await adapter.isConditionActive(connection, ref, now))) {
      throw new EscalationError("condition_not_met", "There is nothing to escalate: it is already sorted out or closed");
    }
  }

  const existing = await findLiveEscalation(connection, input.subjectType, input.subjectId, input.policyKey);
  if (existing) return { existing };

  const users = await listActiveUsers(connection);
  const raiser = raiserFor(input.actor, users);
  const fromLevel = input.startAtRole
    ? levelOfRole(policy.ladder, input.startAtRole, { authorityRoute: input.authorityRoute, raiserRole: raiser?.role, userTargets: input.userTargets })
    : undefined;
  let target: ResolvedTarget | null;
  try {
    target = resolveTarget({
      activeUsers: users,
      authorityRoute: input.authorityRoute,
      excludeUserIds: input.excludeUserIds,
      fallbackEmails: fallbackEmailsByRole(),
      fromLevel,
      kind: policy.kind,
      ladder: policy.ladder,
      onNoTarget: "directors",
      preferredUserId: input.preferredUserId,
      raiser,
      userTargets: input.userTargets,
    });
  } catch (error) {
    return ladderFailure(error);
  }
  if (!target) throw new EscalationError("bad_request", "This escalation has nowhere to go");

  const excludeUserIds = [...(input.excludeUserIds ?? [])];
  const userTargets = [...(input.userTargets ?? [])];
  const context: Record<string, unknown> = {
    ...subject.context,
    ...(input.context ?? {}),
    ...(excludeUserIds.length > 0 ? { excludeUserIds } : {}),
    ...(userTargets.length > 0 ? { userTargets } : {}),
  };

  const values: NewEscalation = {
    buildingId: input.buildingId !== undefined ? input.buildingId : subject.buildingId,
    context,
    dueAt:
      input.dueAt !== undefined
        ? input.dueAt
        : target.slaHours === null
          ? null
          : addClockHours(policy.clock, now, target.slaHours, holidaysFromEnv()),
    kind: policy.kind,
    level: target.level,
    noIndependentTarget: target.noIndependentTarget,
    note: trimNote(input.note),
    notificationState: "pending",
    parentEscalationId: null,
    policyKey: policy.policyKey,
    raisedByKind: input.actor.kind,
    raisedByName: actorName(input.actor),
    raisedByUserId: actorUserId(input.actor),
    reason: input.reason ?? null,
    subjectId: input.subjectId,
    subjectType: input.subjectType,
    summary: composeSummary(input, subject.summary),
    targetRole: target.role,
    targetUserId: target.targetUserId,
    urgent: input.urgent ?? policy.urgent,
  };
  return { plan: { adapter, input, target, users, values } };
}

/** The writes of a raise: the row, the subject's own flags and the ledger row.
 *  Inside a transaction somebody else has opened. */
async function writeRaise(connection: Connection, plan: RaisePlan): Promise<EscalationRow> {
  const { adapter, input, target, values } = plan;
  const id = await insertEscalation(connection, values);
  const inserted = await reload(connection, id);
  await adapter.onChange?.(connection, inserted);
  const flagged = target.noIndependentTarget;
  await record(
    connection,
    ledgerEntry("escalation.raise", input.actor, inserted, adapter, {
      after: snapshot(inserted),
      computed:
        flagged || target.skippedLevels.length > 0
          ? { noIndependentTarget: flagged, skippedLevels: target.skippedLevels, ...(flagged ? { targetRole: "director" } : {}) }
          : undefined,
      correlationId: input.correlationId,
      reason: values.note,
      ruleApplied: flagged ? "no_independent_target" : values.policyKey,
    }),
  );
  return inserted;
}

/** Emails the targets of a row just written and returns it as it stands after. */
async function announceRaise(connection: Connection, plan: RaisePlan, row: EscalationRow): Promise<EscalationRow> {
  await notifyTargets(connection, row, "raise", { ...plan.input.notify, users: plan.users });
  return reload(connection, row.escalationId);
}

/**
 * Raises an escalation: finds who it goes to (rules 1-4), starts its SLA clock,
 * writes the row and its ledger row together, then emails the targets. If the
 * same subject and policy already has a live escalation, that one is returned
 * and nothing is written (created: false).
 */
export async function raise(connection: Connection, input: RaiseInput): Promise<RaiseResult> {
  const planned = await planRaise(connection, input);
  if ("existing" in planned) return { created: false, escalation: planned.existing };
  const { plan } = planned;

  let row: EscalationRow;
  try {
    row = await inTransaction(connection, () => writeRaise(connection, plan));
  } catch (error) {
    if (isUniqueViolation(error)) {
      // Another request raised the same thing between our check and our insert.
      const winner = await findLiveEscalation(connection, input.subjectType, input.subjectId, input.policyKey);
      if (winner) return { created: false, escalation: winner };
    }
    throw error;
  }

  return { created: true, escalation: await announceRaise(connection, plan, row) };
}

export type RaiseWithinResult = RaiseResult & {
  /** Emails the targets and returns the row after. Call it once, after the
   *  caller's transaction has committed; it never throws for a failed send. A
   *  row that was already there (created: false) is returned as it is. */
  announce(): Promise<EscalationRow>;
};

/**
 * `raise`, for a caller that owns the transaction: the row, the subject's flags
 * and the ledger row are written on the caller's open transaction, so they commit
 * or roll back together with whatever else the caller writes (a decision request
 * writes its own row and ledger row beside this). Nothing is begun, committed or
 * rolled back here, and nobody is emailed until the caller calls `announce()`
 * after its commit. A unique-index race is the caller's to handle: it surfaces
 * as the SQL error, with the caller's transaction to roll back.
 */
export async function raiseWithin(connection: Connection, input: RaiseInput): Promise<RaiseWithinResult> {
  const planned = await planRaise(connection, input);
  if ("existing" in planned) {
    return { announce: async () => planned.existing, created: false, escalation: planned.existing };
  }
  const row = await writeRaise(connection, planned.plan);
  return { announce: () => announceRaise(connection, planned.plan, row), created: true, escalation: row };
}

// ── acknowledge ──────────────────────────────────────────────────────────────

export interface AcknowledgeInput {
  actor: LedgerActor;
  escalationId: number;
  expectedRowVersion?: string;
  now?: Date;
}

/** The target claims it: sets the person, stops SLA re-escalation for this level,
 *  clears the subject's escalated flag. Acknowledging twice as the same person is
 *  a no-op; someone else's claim is a conflict. */
export async function acknowledge(connection: Connection, input: AcknowledgeInput): Promise<EscalationRow> {
  const now = input.now ?? new Date();
  await inTransaction(connection, async () => {
    const row = await lockRow(connection, input.escalationId, input.expectedRowVersion);
    if (row.status === "acknowledged") {
      const same = row.acknowledgedByUserId !== null && row.acknowledgedByUserId === actorUserId(input.actor);
      if (same) return;
      throw new EscalationError("already_acknowledged", `${row.acknowledgedByName ?? "Someone"} has already acknowledged this.`, { current: row });
    }
    requireStatus(row, ["open"]);
    // A decision is answered, not acknowledged: claiming it would stop it moving
    // up while nobody had decided anything.
    if (isDecisionRow(row)) {
      throw new EscalationError("bad_request", "A decision request is answered, not acknowledged. Open the job and respond to it.", { current: row });
    }
    const adapter = requireAdapter(row.subjectType);

    await applyChanges(connection, row, {
      AcknowledgedAt: now,
      AcknowledgedByName: actorName(input.actor),
      AcknowledgedByUserId: actorUserId(input.actor),
      Status: "acknowledged",
      TargetUserId: actorUserId(input.actor) ?? row.targetUserId,
    });
    const updated = await reload(connection, row.escalationId);
    await adapter.onChange?.(connection, updated);
    await record(
      connection,
      ledgerEntry("escalation.acknowledge", input.actor, updated, adapter, {
        after: snapshot(updated),
        before: snapshot(row),
      }),
    );
  });
  return reload(connection, input.escalationId);
}

// ── resolve ──────────────────────────────────────────────────────────────────

export interface ResolveInput {
  actor: LedgerActor;
  escalationId: number;
  expectedRowVersion?: string;
  note?: string | null;
  now?: Date;
  notify?: NotifyOptions;
  /** One of MANUAL_RESOLUTION_CODES; defaults to action_taken. */
  resolutionCode?: string;
}

/** A person ends an attention escalation. Authority escalations end when the
 *  decision is made, so this refuses them (422) and points at the subject. */
export async function resolve(connection: Connection, input: ResolveInput): Promise<EscalationRow> {
  const now = input.now ?? new Date();
  const code = input.resolutionCode ?? RESOLUTION_CODES.actionTaken;
  if (!MANUAL_RESOLUTION_CODES.includes(code)) {
    throw new EscalationError("bad_request", `resolutionCode must be one of ${MANUAL_RESOLUTION_CODES.join(", ")}`);
  }
  const note = trimNote(input.note);

  await inTransaction(connection, async () => {
    const row = await lockRow(connection, input.escalationId, input.expectedRowVersion);
    requireStatus(row, LIVE_STATUSES);
    const adapter = requireAdapter(row.subjectType);
    if (row.kind === "authority") {
      const path = adapter.deepLink(row.subjectId);
      throw new EscalationError(
        "authority_resolve",
        "This is waiting on a decision, so it can't be resolved from here. Open it and approve or reject it there.",
        { deepLink: path, subjectId: row.subjectId, subjectType: row.subjectType },
      );
    }

    const who = { name: actorName(input.actor), userId: actorUserId(input.actor) };
    await applyChanges(connection, row, {
      // Resolving an unacknowledged escalation also claims it.
      ...(row.acknowledgedAt === null
        ? { AcknowledgedAt: now, AcknowledgedByName: who.name, AcknowledgedByUserId: who.userId, TargetUserId: who.userId ?? row.targetUserId }
        : {}),
      ResolutionCode: code,
      ResolutionNote: note,
      ResolvedAt: now,
      ResolvedByName: who.name,
      ResolvedByUserId: who.userId,
      Status: "resolved",
    });
    const updated = await reload(connection, row.escalationId);
    await adapter.onChange?.(connection, updated);
    await record(
      connection,
      ledgerEntry("escalation.resolve", input.actor, updated, adapter, {
        after: { ...snapshot(updated), resolutionCode: code },
        before: snapshot(row),
        reason: note,
      }),
    );
  });

  const done = await reload(connection, input.escalationId);
  await notifyRaiserResolved(connection, done, input.notify);
  return done;
}

// ── withdraw ─────────────────────────────────────────────────────────────────

export interface WithdrawInput {
  actor: LedgerActor;
  /** Shared with the other ledger rows of the operation this is part of. */
  correlationId?: string;
  escalationId: number;
  expectedRowVersion?: string;
  now?: Date;
  /** Required: why it was not needed. */
  reason: string | null | undefined;
}

/** The writes of a withdrawal, on a transaction somebody else has opened. An
 *  acknowledged row is refused unless the subject's own domain is ending it. */
async function withdrawWork(connection: Connection, input: WithdrawInput, reason: string, endedByDomain: boolean): Promise<void> {
  const now = input.now ?? new Date();
  const row = await lockRow(connection, input.escalationId, input.expectedRowVersion);
  // Withdrawing only this would leave the request it belongs to pending with nothing
  // chasing it; the request is withdrawn, and takes this with it (withdrawWithin).
  if (isDecisionRow(row) && !endedByDomain) {
    throw new EscalationError("bad_request", "A decision request is withdrawn from the request itself, not from here.", { current: row });
  }
  if (row.status === "acknowledged" && !endedByDomain) {
    throw new EscalationError("not_live", `${row.acknowledgedByName ?? "Someone"} has already acknowledged this, so it can't be withdrawn. Ask them to resolve it.`, { current: row });
  }
  requireStatus(row, endedByDomain ? LIVE_STATUSES : ["open"]);
  const adapter = requireAdapter(row.subjectType);

  await applyChanges(connection, row, {
    ResolutionCode: RESOLUTION_CODES.withdrawn,
    ResolutionNote: reason,
    ResolvedAt: now,
    ResolvedByName: actorName(input.actor),
    ResolvedByUserId: actorUserId(input.actor),
    Status: "withdrawn",
  });
  const updated = await reload(connection, row.escalationId);
  await adapter.onChange?.(connection, updated);
  await record(
    connection,
    ledgerEntry("escalation.withdraw", input.actor, updated, adapter, {
      after: { ...snapshot(updated), resolutionCode: RESOLUTION_CODES.withdrawn },
      before: snapshot(row),
      correlationId: input.correlationId,
      reason,
    }),
  );
}

function withdrawReason(input: WithdrawInput): string {
  const reason = trimNote(input.reason);
  if (!reason) throw new EscalationError("reason_required", "Say why you are withdrawing it");
  return reason;
}

/** The raiser takes back an escalation nobody has picked up yet. */
export async function withdraw(connection: Connection, input: WithdrawInput): Promise<EscalationRow> {
  const reason = withdrawReason(input);
  await inTransaction(connection, () => withdrawWork(connection, input, reason, false));
  return reload(connection, input.escalationId);
}

/**
 * `withdraw`, for the subject's own domain ending the escalation inside its own
 * transaction (a decision request withdrawn, so the question stops being chased in
 * the same commit that records the withdrawal). The caller owns the transaction;
 * nothing is begun or committed here. The domain decides, so a row somebody has
 * acknowledged ends too; permissions are the caller's to have checked.
 */
export async function withdrawWithin(connection: Connection, input: WithdrawInput): Promise<EscalationRow> {
  const reason = withdrawReason(input);
  await withdrawWork(connection, input, reason, true);
  return reload(connection, input.escalationId);
}

// ── auto-resolve ─────────────────────────────────────────────────────────────

export interface AutoResolveInput {
  actor?: LedgerActor;
  escalationId: number;
  expectedRowVersion?: string;
  now?: Date;
}

/**
 * The condition behind an attention escalation has cleared (the job was
 * acknowledged, assigned, got a quote...), so it ends by itself with the code
 * condition_cleared: an escalation nobody picked up is withdrawn, one somebody
 * had acknowledged is resolved (PLAN §3.7 lifecycle).
 */
export async function autoResolve(connection: Connection, input: AutoResolveInput): Promise<EscalationRow> {
  const now = input.now ?? new Date();
  const actor = input.actor ?? SWEEP_ACTOR;
  await inTransaction(connection, async () => {
    const row = await lockRow(connection, input.escalationId, input.expectedRowVersion);
    requireStatus(row, LIVE_STATUSES);
    if (row.kind === "authority") {
      throw new EscalationError("authority_resolve", "An authority escalation ends with the decision, not when a condition clears");
    }
    const adapter = requireAdapter(row.subjectType);
    const status: EscalationStatus = row.status === "open" ? "withdrawn" : "resolved";

    await applyChanges(connection, row, {
      ResolutionCode: RESOLUTION_CODES.conditionCleared,
      ResolutionNote: "The condition that raised this has cleared.",
      ResolvedAt: now,
      ResolvedByName: actorName(actor),
      ResolvedByUserId: actorUserId(actor),
      Status: status,
    });
    const updated = await reload(connection, row.escalationId);
    await adapter.onChange?.(connection, updated);
    await record(
      connection,
      ledgerEntry("escalation.auto_resolve", actor, updated, adapter, {
        after: { ...snapshot(updated), resolutionCode: RESOLUTION_CODES.conditionCleared },
        before: snapshot(row),
        ruleApplied: RESOLUTION_CODES.conditionCleared,
      }),
    );
  });
  return reload(connection, input.escalationId);
}

// ── conclude (the subject's own decision) ────────────────────────────────────

export interface ConcludeInput {
  actor: LedgerActor;
  /** What the subject's decision was, stored as ResolutionCode ("approved",
   *  "returned", ...): lower-case words joined by underscores, at most 32 characters. */
  code: string;
  /** The decision's note or reason; required when an escalation is withdrawn. */
  note?: string | null;
  now?: Date;
  notify?: NotifyOptions;
  /** Only escalations under these policies; every live one on the subject when left out. */
  policyKeys?: readonly string[];
  subjectId: string;
  subjectType: string;
  /** The subject is gone (cancelled): an escalation nobody acknowledged is
   *  withdrawn rather than resolved. */
  withdrawOpen?: boolean;
}

const DECISION_CODE_RE = /^[a-z][a-z_]{0,31}$/;

/**
 * The subject's own decision has ended its escalations (PLAN §3.7: "authority
 * escalations resolve only through the domain decision"). The domain calls this
 * once its decision has committed: each live escalation on the subject (under
 * `policyKeys`, if given) ends in a transaction of its own, resolved with the
 * decision as its code, or withdrawn when the subject was cancelled and nobody
 * had picked it up. Unlike resolve, it ends authority escalations too: the
 * caller is the domain, and it has just decided. Ledgered like every other
 * transition; the human raiser of one that was resolved is told. Returns the
 * rows it ended; one someone else ended first is skipped.
 */
export async function concludeForSubject(connection: Connection, input: ConcludeInput): Promise<EscalationRow[]> {
  const now = input.now ?? new Date();
  if (!DECISION_CODE_RE.test(input.code)) throw new EscalationError("bad_request", `"${input.code}" isn't a resolution code`);
  const note = trimNote(input.note);
  const live = (await listLiveForSubject(connection, input.subjectType, input.subjectId)).filter(
    (row) => !input.policyKeys || input.policyKeys.includes(row.policyKey),
  );
  const ended: EscalationRow[] = [];
  for (const seen of live) {
    const withdraw = input.withdrawOpen === true && seen.status === "open";
    if (withdraw && !note) throw new EscalationError("reason_required", "Say why: a withdrawn escalation needs a reason");
    const done = await inTransaction(connection, async () => {
      const row = await lockRow(connection, seen.escalationId);
      if (!LIVE_STATUSES.includes(row.status)) return null;
      const adapter = requireAdapter(row.subjectType);
      const status: EscalationStatus = withdraw && row.status === "open" ? "withdrawn" : "resolved";
      await applyChanges(connection, row, {
        ResolutionCode: input.code,
        ResolutionNote: note,
        ResolvedAt: now,
        ResolvedByName: actorName(input.actor),
        ResolvedByUserId: actorUserId(input.actor),
        Status: status,
      });
      const updated = await reload(connection, row.escalationId);
      await adapter.onChange?.(connection, updated);
      await record(
        connection,
        ledgerEntry(status === "withdrawn" ? "escalation.withdraw" : "escalation.resolve", input.actor, updated, adapter, {
          after: { ...snapshot(updated), resolutionCode: input.code },
          before: snapshot(row),
          reason: note,
          ruleApplied: input.code,
        }),
      );
      return updated;
    });
    if (!done) continue;
    ended.push(done);
    if (done.status === "resolved") await notifyRaiserResolved(connection, done, input.notify);
  }
  return ended;
}

// ── escalate further (supersede) ─────────────────────────────────────────────

export type SupersedeCode = typeof RESOLUTION_CODES.escalated | typeof RESOLUTION_CODES.followUp | typeof RESOLUTION_CODES.reminder | typeof RESOLUTION_CODES.slaBreach;

export interface EscalateFurtherInput {
  actor: LedgerActor;
  authorityRoute?: readonly AuthorityRouteStep[];
  /** Why it was superseded; defaults by code. */
  code?: SupersedeCode;
  escalationId: number;
  expectedRowVersion?: string;
  /** next_level moves up the ladder; same_level starts a fresh clock where it is
   *  (a reminder, or a follow-up email restarting the clock). */
  mode: "next_level" | "same_level";
  note?: string | null;
  notify?: NotifyOptions;
  now?: Date;
  /** The SLA path: an escalation somebody acknowledged is left alone. */
  onlyIfOpen?: boolean;
  preferredUserId?: number | null;
}

function supersedeReason(code: SupersedeCode, input: EscalateFurtherInput, target: ResolvedTarget): string {
  const to = roleLabel(target.role);
  const note = input.note?.trim();
  switch (code) {
    case RESOLUTION_CODES.slaBreach:
      return `No one acknowledged it in time, so it moved up to ${to}`;
    case RESOLUTION_CODES.reminder:
      return `Still waiting after its SLA, so ${to} was reminded`;
    case RESOLUTION_CODES.followUp:
      return "A new email about this arrived, so the clock restarted";
    case RESOLUTION_CODES.escalated:
      return `Pushed up to ${to} by ${actorName(input.actor)}${note ? `: ${note}` : ""}`;
  }
}

export interface EscalateFurtherResult {
  next: EscalationRow;
  previous: EscalationRow;
}

/** Who a live escalation would go to next: the level above it, or the same level
 *  again. Null when there is no one eligible. */
function resolveFurther(
  row: EscalationRow,
  policy: EscalationPolicy,
  users: readonly DirectoryUser[],
  mode: "next_level" | "same_level",
  authorityRoute?: readonly AuthorityRouteStep[],
  preferredUserId?: number | null,
): ResolvedTarget | null {
  return resolveTarget({
    activeUsers: users,
    authorityRoute,
    excludeUserIds: contextNumbers(row.context, "excludeUserIds"),
    fallbackEmails: fallbackEmailsByRole(),
    fromLevel: mode === "next_level" ? row.level + 1 : row.level,
    kind: row.kind,
    ladder: policy.ladder,
    // A flagged escalation (nobody independent) stays flagged when it is repeated.
    onNoTarget: mode === "same_level" && row.noIndependentTarget ? "directors" : "none",
    preferredUserId,
    raiser: raiserOf(row, users),
    userTargets: contextNumbers(row.context, "userTargets"),
  });
}

/** Whether the ladder has anyone eligible above this escalation's level (the
 *  sweep uses it to tell "move up" from "remind"). */
export async function hasNextLevel(connection: Connection, row: EscalationRow, now: Date = new Date()): Promise<boolean> {
  const policy = await getPolicy(connection, row.policyKey, now.getTime());
  if (!policy) return false;
  try {
    return resolveFurther(row, policy, await listActiveUsers(connection), "next_level") !== null;
  } catch {
    return false;
  }
}

/**
 * Supersedes a live escalation with a new row (ParentEscalationId points back):
 * at the next level up the ladder, or at the same level with a fresh SLA clock.
 * The old row ends as superseded; both rows are written to the ledger under one
 * correlation id. The people at the new level are emailed, and the previous
 * level is told.
 */
export async function escalateFurther(connection: Connection, input: EscalateFurtherInput): Promise<EscalateFurtherResult> {
  const now = input.now ?? new Date();
  const code: SupersedeCode =
    input.code ?? (input.mode === "same_level" ? RESOLUTION_CODES.reminder : RESOLUTION_CODES.escalated);

  const seen = await getEscalationRow(connection, input.escalationId);
  if (!seen) throw new EscalationError("not_found", "That escalation doesn't exist");
  if (input.expectedRowVersion !== undefined && seen.rowVersion !== input.expectedRowVersion) {
    throw new EscalationError("stale", "Someone else changed this escalation. Reload it to see their change.", { current: seen });
  }
  requireStatus(seen, input.onlyIfOpen ? ["open"] : LIVE_STATUSES);

  const policy = await getPolicy(connection, seen.policyKey, now.getTime());
  if (!policy) throw new EscalationError("unknown_policy", `There is no escalation policy "${seen.policyKey}"`);
  const adapter = requireAdapter(seen.subjectType);
  const users = await listActiveUsers(connection);

  let target: ResolvedTarget | null;
  try {
    target = resolveFurther(seen, policy, users, input.mode, input.authorityRoute, input.preferredUserId);
  } catch (error) {
    return ladderFailure(error);
  }
  if (!target) {
    throw new EscalationError(
      "no_further_level",
      input.mode === "next_level" ? "This is already with the top of the ladder, so there is nowhere further to send it." : "There is no one left at this level to remind.",
      { current: seen },
    );
  }
  const resolvedTarget = target;

  const correlationId = randomUUID();
  const ended = { name: actorName(input.actor), userId: actorUserId(input.actor) };
  const reason = supersedeReason(code, input, resolvedTarget);
  const note = trimNote(input.note);

  const { next, previous } = await inTransaction(connection, async () => {
    const locked = await lockRow(connection, input.escalationId, input.expectedRowVersion);
    // What we resolved the target from must still hold.
    if (locked.status !== seen.status || locked.level !== seen.level) {
      throw new EscalationError("stale", "Someone else changed this escalation. Reload it to see their change.", { current: locked });
    }
    requireStatus(locked, input.onlyIfOpen ? ["open"] : LIVE_STATUSES);

    // The old row leaves the "live" set first, so the new row can take its place
    // under the unique index on (subject, policy) for live escalations.
    await applyChanges(connection, locked, {
      ResolutionCode: code,
      ResolutionNote: note ?? reason,
      ResolvedAt: now,
      ResolvedByName: ended.name,
      ResolvedByUserId: ended.userId,
      Status: "superseded",
    });

    const newId = await insertEscalation(connection, {
      buildingId: locked.buildingId,
      context: locked.context,
      dueAt: resolvedTarget.slaHours === null ? null : addClockHours(policy.clock, now, resolvedTarget.slaHours, holidaysFromEnv()),
      kind: locked.kind,
      lastFollowUpAt: code === RESOLUTION_CODES.followUp ? now : null,
      level: resolvedTarget.level,
      noIndependentTarget: resolvedTarget.noIndependentTarget,
      note: locked.note,
      notificationState: "pending",
      parentEscalationId: locked.escalationId,
      policyKey: locked.policyKey,
      raisedByKind: locked.raisedByKind,
      raisedByName: locked.raisedByName,
      raisedByUserId: locked.raisedByUserId,
      reason: locked.reason,
      subjectId: locked.subjectId,
      subjectType: locked.subjectType,
      summary: locked.summary,
      targetRole: resolvedTarget.role,
      targetUserId: resolvedTarget.targetUserId,
      urgent: locked.urgent,
    });
    const superseded = await reload(connection, locked.escalationId);
    const created = await reload(connection, newId);
    await adapter.onChange?.(connection, created);

    await record(
      connection,
      ledgerEntry("escalation.supersede", input.actor, superseded, adapter, {
        after: { ...snapshot(superseded), resolutionCode: code, supersededBy: newId },
        before: snapshot(locked),
        correlationId,
        reason,
        ruleApplied: code,
      }),
    );
    await record(
      connection,
      ledgerEntry("escalation.raise", input.actor, created, adapter, {
        after: snapshot(created),
        before: { parentEscalationId: locked.escalationId },
        computed:
          resolvedTarget.noIndependentTarget || resolvedTarget.skippedLevels.length > 0
            ? { noIndependentTarget: resolvedTarget.noIndependentTarget, skippedLevels: resolvedTarget.skippedLevels }
            : undefined,
        correlationId,
        reason,
        ruleApplied: code,
      }),
    );
    return { next: created, previous: superseded };
  });

  const event: NotifyEvent = code === RESOLUTION_CODES.followUp ? "follow_up" : input.mode === "same_level" ? "reminder" : "supersede";
  await notifyTargets(connection, next, event, { ...input.notify, users });
  if (input.mode === "next_level") await notifyPreviousLevel(connection, previous, next, { ...input.notify, users });
  return { next: await reload(connection, next.escalationId), previous };
}
