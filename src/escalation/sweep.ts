// The escalation sweep (PLAN §3.7): everything that happens to escalations
// because time passed, run every 30 minutes by escalationSweepTimer. It does not
// depend on any PLANNER_* setting.
//
//  1. Attention escalations whose condition has cleared end (condition_cleared).
//  2. Open escalations past their SLA move up a level, or are repeated as a
//     reminder at the top (autoReescalate on the policy decides).
//     Then the rows that carry a reminder schedule (a decision request's) are
//     emailed when one of their times has come: no new row, and not a row that has
//     just moved up (reminders.ts). Then a deferred decision whose day has come is
//     asked again: a new pending request to the same people, once (jobDecisions/reask.ts).
//  3. Jobs that meet a job policy and have no live escalation for it get one:
//     stalled and unacknowledged, unassigned, quote not back, invoice waiting,
//     past due. A policy switched off in dbo.EscalationPolicies is skipped, and
//     job.past_due is seeded off until Jobs has a real due date. What a person
//     already closed is not raised again until the condition's clock moves; a new
//     email linked to the job is the exception for a stalled job (follow-up).
//  4. A new email linked to a job with an open attention escalation restarts its
//     clock at its current level and tells the target again (a same-level
//     supersede). Emergencies (urgent) are not delayed by it.
//  5. Notifications that failed, or never left, are tried again with back-off.
//  6. system.health goes to admin when settings are missing, sends keep failing
//     or this run had failures, and ends when the problem has gone.
//
// Writes happen only in "live" mode (ESCALATION_SWEEP_ENABLED === "true"); in
// "dry-run" (ESCALATION_SWEEP_DRY_RUN === "true") it reads, logs what it would
// raise, supersede or resolve, and writes nothing. One run makes at most
// ESCALATION_SWEEP_MAX_ACTIONS writes (default 100), so switching it on against
// a backlog is paced over several runs rather than one flood. Every step is
// idempotent: running the sweep twice does nothing the second time.

import type { Connection } from "tedious";
import { businessDayStart, darwinDateKey, holidaysFromEnv, parseHolidays } from "./businessTime";
import { MAX_NOTIFICATION_ATTEMPTS, missingNotificationConfig, sweepMaxActions } from "./config";
import { autoResolve, escalateFurther, hasNextLevel, raise, SWEEP_ACTOR } from "./engine";
import type { AutoResolveInput, EscalateFurtherInput, EscalateFurtherResult, RaiseInput, RaiseResult } from "./engine";
import { EscalationError } from "./errors";
import { getAdapter, type EscalationAdapter } from "./adapters/registry";
import {
  ATTRIBUTION_SUBJECT_TYPE,
  attributionSubjectId,
  listUnansweredAttributions,
  noticePolicy,
  type AttributionRef,
} from "./adapters/approvalAttribution";
import { latestEmailArrivals, loadLiveJobFacts } from "./adapters/jobFacts";
import {
  conditionEpoch,
  jobConditionActive,
  jobHeadline,
  SWEEP_JOB_POLICIES,
  type JobFacts,
  type SweepJobPolicy,
} from "./adapters/jobRules";
import { listOverdueRequests, REQUEST_POLICY, REQUEST_SUBJECT_TYPE, type OverdueRequest } from "../intake/overdue";
import { countExhaustedNotifications, SYSTEM_SUBJECTS } from "./adapters/system";
import { DECISION_PENDING_POLICY, isNextStepRow } from "./decisionRows";
import { dueDeferrals, type DueDeferral } from "../jobDecisions/decisionsStore";
import { reaskDeferral, type ReaskOptions, type ReaskResult } from "../jobDecisions/reask";
import { dueReminder } from "./reminders";
import { eventForRetry, isRetryDue, notifyTargets, type NotifyEvent, type NotifyOptions, type NotifyOutcome } from "./notifier";
import { getPolicy } from "./policies";
import { latestKey, latestTimesBySubject, listLiveEscalations, type LatestEscalationTimes } from "./store";
import { RESOLUTION_CODES, type EscalationPolicy, type EscalationRow } from "./types";

export interface SweepOptions {
  dryRun: boolean;
  env?: NodeJS.ProcessEnv;
  log: (message: string) => void;
  maxActions?: number;
  now?: Date;
  warn: (message: string) => void;
}

/** What a run did. In a dry run these are what it would have done. */
export interface SweepReport {
  autoResolved: number;
  dryRun: boolean;
  errors: string[];
  followUps: number;
  healthRaised: number;
  healthResolved: number;
  notificationsRetried: number;
  raised: number;
  /** Deferred decisions whose day came, asked again as a new pending request (jobs plan A2). */
  reasked: number;
  reminded: number;
  /** Scheduled reminders emailed to the people a row is for (a decision request's). */
  scheduledReminders: number;
  /** Conditions a person already dealt with, so not raised again. */
  skippedAsHandled: number;
  superseded: number;
  /** The run stopped early at its action limit. */
  truncated: boolean;
}

export interface SweepDeps {
  autoResolve(connection: Connection, input: AutoResolveInput): Promise<EscalationRow>;
  countExhaustedNotifications(connection: Connection, maxAttempts: number): Promise<number>;
  escalateFurther(connection: Connection, input: EscalateFurtherInput): Promise<EscalateFurtherResult>;
  getAdapter(subjectType: string): EscalationAdapter | null;
  getPolicy(connection: Connection, policyKey: string, nowMs: number): Promise<EscalationPolicy | null>;
  hasNextLevel(connection: Connection, row: EscalationRow, now: Date): Promise<boolean>;
  latestEmailArrivals(connection: Connection, jobIds: readonly number[]): Promise<Map<number, Date>>;
  latestTimesBySubject(connection: Connection, subjectType: string): Promise<Map<string, LatestEscalationTimes>>;
  listDueDeferrals(connection: Connection, today: string, limit: number): Promise<DueDeferral[]>;
  listLiveEscalations(connection: Connection): Promise<EscalationRow[]>;
  /** R2/R13: attributions nobody has answered. Optional, so a sweep built without it skips the step. */
  listUnansweredAttributions?(connection: Connection): Promise<{ attributedToUserId: number; ref: AttributionRef }[]>;
  loadLiveJobFacts(connection: Connection): Promise<JobFacts[]>;
  /** TR1: requests past the acknowledgement target Facilities set. Optional, so a sweep built without it skips the step. */
  listOverdueRequests?(connection: Connection, now: Date): Promise<OverdueRequest[]>;
  notifyTargets(connection: Connection, row: EscalationRow, event: NotifyEvent, options: NotifyOptions): Promise<NotifyOutcome>;
  raise(connection: Connection, input: RaiseInput): Promise<RaiseResult>;
  reaskDeferral(connection: Connection, deferral: DueDeferral, options: ReaskOptions): Promise<ReaskResult>;
}

export const defaultSweepDeps: SweepDeps = {
  autoResolve,
  countExhaustedNotifications,
  escalateFurther,
  getAdapter,
  getPolicy,
  hasNextLevel,
  latestEmailArrivals,
  latestTimesBySubject,
  listDueDeferrals: dueDeferrals,
  listLiveEscalations,
  listUnansweredAttributions,
  listOverdueRequests,
  loadLiveJobFacts,
  notifyTargets,
  raise,
  reaskDeferral,
};

const PRIORITY_RANK: Record<string, number> = { Critical: 0, High: 1, Normal: 2, Low: 3 };
const SEND_ATTEMPTS = 3;
const SEND_BACKOFF_MS = 1000;

const rowKey = (row: Pick<EscalationRow, "policyKey" | "subjectId" | "subjectType">): string =>
  `${row.subjectType}\u0000${row.subjectId}\u0000${row.policyKey}`;

/** Someone else got there first, or it is over: not a failure of the sweep. */
const isRace = (error: unknown): boolean =>
  error instanceof EscalationError && ["stale", "not_live", "not_found", "already_acknowledged", "no_further_level"].includes(error.code);

class Run {
  readonly report: SweepReport;
  private left: number;
  private readonly warnedAdapters = new Set<string>();

  constructor(
    readonly connection: Connection,
    readonly options: SweepOptions,
    readonly deps: SweepDeps,
    readonly now: Date,
    readonly env: NodeJS.ProcessEnv,
  ) {
    this.report = {
      autoResolved: 0,
      dryRun: options.dryRun,
      errors: [],
      followUps: 0,
      healthRaised: 0,
      healthResolved: 0,
      notificationsRetried: 0,
      raised: 0,
      reasked: 0,
      reminded: 0,
      scheduledReminders: 0,
      skippedAsHandled: 0,
      superseded: 0,
      truncated: false,
    };
    this.left = options.maxActions ?? sweepMaxActions(env);
  }

  /** Takes one write from the run's allowance; false once it is spent. */
  take(): boolean {
    if (this.left <= 0) {
      this.report.truncated = true;
      return false;
    }
    this.left -= 1;
    return true;
  }

  fail(what: string, error: unknown): void {
    const message = `${what}: ${error instanceof Error ? error.message : String(error)}`;
    this.report.errors.push(message);
    this.options.warn(`escalationSweep: ${message}`);
  }

  /** Runs one action; a lost race is skipped quietly, anything else is a failure. */
  async attempt(what: string, work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (error) {
      if (isRace(error)) {
        this.options.log(`escalationSweep: ${what}: skipped (${(error as EscalationError).code})`);
      } else {
        this.fail(what, error);
      }
    }
  }

  warnOnce(subjectType: string): void {
    if (this.warnedAdapters.has(subjectType)) return;
    this.warnedAdapters.add(subjectType);
    this.options.warn(`escalationSweep: no adapter is registered for "${subjectType}", so its escalations are left alone`);
  }

  notifyOptions(): NotifyOptions {
    return { attempts: SEND_ATTEMPTS, backoffMs: SEND_BACKOFF_MS, log: this.options.warn, now: () => this.now };
  }
}

// ── 1. Cleared conditions ────────────────────────────────────────────────────

async function endClearedConditions(run: Run): Promise<void> {
  for (const row of await run.deps.listLiveEscalations(run.connection)) {
    if (row.kind !== "attention") continue;
    const adapter = run.deps.getAdapter(row.subjectType);
    if (!adapter) {
      run.warnOnce(row.subjectType);
      continue;
    }
    let active: boolean;
    try {
      active = await adapter.isConditionActive(run.connection, row, run.now);
    } catch (error) {
      run.fail(`checking escalation #${row.escalationId}`, error);
      continue;
    }
    if (active) continue;
    if (!run.take()) return;

    if (run.options.dryRun) {
      run.options.log(`escalationSweep: would end #${row.escalationId} ${row.policyKey} on ${row.subjectType} ${row.subjectId}: ${RESOLUTION_CODES.conditionCleared}`);
      run.report.autoResolved += 1;
      continue;
    }
    await run.attempt(`ending escalation #${row.escalationId}`, async () => {
      await run.deps.autoResolve(run.connection, { escalationId: row.escalationId, expectedRowVersion: row.rowVersion, now: run.now });
      run.report.autoResolved += 1;
    });
  }
}

// ── 2. SLA breaches ──────────────────────────────────────────────────────────

async function moveUpOverdue(run: Run): Promise<void> {
  for (const row of await run.deps.listLiveEscalations(run.connection)) {
    if (row.status !== "open" || row.dueAt === null || row.dueAt.getTime() > run.now.getTime()) continue;
    const policy = await run.deps.getPolicy(run.connection, row.policyKey, run.now.getTime());
    if (!policy || policy.autoReescalate === "no") continue;

    // "yes" moves up while there is a level above; at the top, and for
    // reminder / nudge policies, it repeats the level with a fresh clock.
    let mode: "next_level" | "same_level" = "same_level";
    try {
      if (policy.autoReescalate === "yes" && (await run.deps.hasNextLevel(run.connection, row, run.now))) mode = "next_level";
    } catch (error) {
      run.fail(`planning escalation #${row.escalationId}`, error);
      continue;
    }
    if (!run.take()) return;

    const label = mode === "next_level" ? "move up" : "remind";
    if (run.options.dryRun) {
      run.options.log(`escalationSweep: would ${label} #${row.escalationId} ${row.policyKey} on ${row.subjectType} ${row.subjectId} (due ${row.dueAt.toISOString()})`);
      if (mode === "next_level") run.report.superseded += 1;
      else run.report.reminded += 1;
      continue;
    }
    await run.attempt(`${label} escalation #${row.escalationId}`, async () => {
      await run.deps.escalateFurther(run.connection, {
        actor: SWEEP_ACTOR,
        code: mode === "next_level" ? RESOLUTION_CODES.slaBreach : RESOLUTION_CODES.reminder,
        escalationId: row.escalationId,
        expectedRowVersion: row.rowVersion,
        mode,
        notify: run.notifyOptions(),
        now: run.now,
        onlyIfOpen: true,
      });
      if (mode === "next_level") run.report.superseded += 1;
      else run.report.reminded += 1;
    });
  }
}

// ── 2b. Scheduled reminders ──────────────────────────────────────────────────

async function sendScheduledReminders(run: Run): Promise<void> {
  for (const row of await run.deps.listLiveEscalations(run.connection)) {
    if (!dueReminder(row, run.now)) continue;
    if (!run.take()) return;

    if (run.options.dryRun) {
      run.options.log(`escalationSweep: would remind the people on #${row.escalationId} ${row.policyKey} on ${row.subjectType} ${row.subjectId}`);
      run.report.scheduledReminders += 1;
      continue;
    }
    await run.attempt(`reminding on escalation #${row.escalationId}`, async () => {
      // A reminder that goes through costs the row no attempts; one that fails does,
      // and the next run tries again (the row is still due) until one gets through.
      const outcome = await run.deps.notifyTargets(run.connection, row, "reminder", { ...run.notifyOptions(), countAttempts: "failures" });
      if (outcome.state === "sent") {
        run.report.scheduledReminders += 1;
      } else if (outcome.state === "failed") {
        throw new Error(outcome.error ?? "the reminder could not be sent");
      } else {
        run.options.log(`escalationSweep: no reminder sent on #${row.escalationId} (${outcome.state}${outcome.error ? `: ${outcome.error}` : ""})`);
      }
    });
  }
}

// ── 2c. Deferred questions come back ─────────────────────────────────────────

/** A deferral comes back when its day opens: 08:30 Darwin on the date, the first
 *  sweep at or after it. One that was missed (the sweep was off) comes back at once. */
async function reaskDeferred(run: Run): Promise<void> {
  const due = (await run.deps.listDueDeferrals(run.connection, darwinDateKey(run.now), sweepMaxActions(run.env))).filter(
    (deferral) => businessDayStart(deferral.deferUntil).getTime() <= run.now.getTime(),
  );
  if (due.length === 0) return;

  const policy = await run.deps.getPolicy(run.connection, DECISION_PENDING_POLICY, run.now.getTime());
  if (!policy?.active) {
    run.options.log(
      `escalationSweep: ${due.length} deferred decision${due.length === 1 ? " is" : "s are"} due, but ${DECISION_PENDING_POLICY} ${policy ? "is switched off (Active = 0)" : "has no row in dbo.EscalationPolicies"}, so ${due.length === 1 ? "it is" : "they are"} not asked again`,
    );
    return;
  }

  const holidays = holidaysFromEnv(run.env);
  for (const deferral of due) {
    if (!run.take()) return;
    if (run.options.dryRun) {
      run.options.log(`escalationSweep: would ask job #${deferral.jobId} again (decision #${deferral.decisionId}, deferred until ${deferral.deferUntil})`);
      run.report.reasked += 1;
      continue;
    }
    await run.attempt(`asking job #${deferral.jobId} again`, async () => {
      const result = await run.deps.reaskDeferral(run.connection, deferral, { holidays, notify: run.notifyOptions(), now: run.now });
      if (result === "asked") run.report.reasked += 1;
    });
  }
}

// ── 3. Job policies ──────────────────────────────────────────────────────────

interface Candidate {
  job: JobFacts;
  policyKey: SweepJobPolicy;
  since: Date | null;
}

const priorityRank = (job: JobFacts): number => PRIORITY_RANK[job.priority ?? ""] ?? 2;

async function raiseForJobs(run: Run): Promise<void> {
  const policies = new Map<string, EscalationPolicy>();
  for (const key of SWEEP_JOB_POLICIES) {
    const policy = await run.deps.getPolicy(run.connection, key, run.now.getTime());
    if (policy?.active) policies.set(key, policy);
    else if (run.options.dryRun) {
      run.options.log(`escalationSweep: ${key} ${policy ? "is switched off (Active = 0)" : "has no row in dbo.EscalationPolicies"}, so it is skipped`);
    }
  }
  if (policies.size === 0) return;

  const facts = await run.deps.loadLiveJobFacts(run.connection);
  const latest = await run.deps.latestTimesBySubject(run.connection, "job");
  const live = new Set((await run.deps.listLiveEscalations(run.connection)).map(rowKey));
  const rule = { env: run.env, holidays: holidaysFromEnv(run.env), now: run.now };

  const candidates: Candidate[] = [];
  const handledStalled: JobFacts[] = [];
  for (const policyKey of SWEEP_JOB_POLICIES) {
    if (!policies.has(policyKey)) continue;
    for (const job of facts) {
      if (!jobConditionActive(policyKey, job, rule)) continue;
      if (live.has(rowKey({ policyKey, subjectId: String(job.jobId), subjectType: "job" }))) continue;

      const last = latest.get(latestKey(String(job.jobId), policyKey));
      const epoch = conditionEpoch(policyKey, job);
      if (last && epoch && last.lastCreatedAt.getTime() >= epoch.getTime()) {
        // A person (or an earlier run) already dealt with this stretch of the condition.
        if (policyKey === "job.stalled_unacknowledged") handledStalled.push(job);
        else run.report.skippedAsHandled += 1;
        continue;
      }
      candidates.push({ job, policyKey, since: epoch });
    }
  }

  // A stalled job someone had closed is raised again when new mail about it
  // arrives after that escalation ended: the tenant or contractor is chasing.
  if (handledStalled.length > 0) {
    const arrivals = await run.deps.latestEmailArrivals(run.connection, handledStalled.map((job) => job.jobId));
    for (const job of handledStalled) {
      const last = latest.get(latestKey(String(job.jobId), "job.stalled_unacknowledged"));
      const arrival = arrivals.get(job.jobId);
      const boundary = last ? (last.lastEndedAt ?? last.lastCreatedAt) : null;
      if (arrival && boundary && arrival.getTime() > boundary.getTime()) {
        candidates.push({ job, policyKey: "job.stalled_unacknowledged", since: conditionEpoch("job.stalled_unacknowledged", job) });
        run.report.followUps += 1;
      } else {
        run.report.skippedAsHandled += 1;
      }
    }
  }

  // If the allowance runs out, the most urgent jobs go first.
  candidates.sort((a, b) => priorityRank(a.job) - priorityRank(b.job) || a.job.jobId - b.job.jobId);

  for (const { job, policyKey, since } of candidates) {
    if (!run.take()) return;
    if (run.options.dryRun) {
      run.options.log(`escalationSweep: would raise ${policyKey} on job #${job.jobId}: ${jobHeadline(policyKey, job, run.now)}`);
      run.report.raised += 1;
      continue;
    }
    await run.attempt(`raising ${policyKey} on job #${job.jobId}`, async () => {
      const result = await run.deps.raise(run.connection, {
        actor: SWEEP_ACTOR,
        context: { rule: policyKey, since: since ? since.toISOString() : null },
        headline: jobHeadline(policyKey, job, run.now),
        notify: run.notifyOptions(),
        now: run.now,
        policyKey,
        skipConditionCheck: true,
        subjectId: String(job.jobId),
        subjectType: "job",
      });
      if (result.created) run.report.raised += 1;
    });
  }
}

// ── 3b. Attribution notices (R2, R13) ───────────────────────────────────────

/**
 * Every attributed approval or accepted variance the named manager hasn't
 * answered has had its notice: the decision raises it after commit, and this
 * raises any that never were (a failed raise, or one made before the policies
 * existed). A subject that has had a notice before is left alone, so a notice a
 * person closed without answering isn't raised again every half hour.
 */
async function raiseAttributionNotices(run: Run): Promise<void> {
  const list = run.deps.listUnansweredAttributions;
  if (!list) return;
  const unanswered = await list(run.connection);
  if (unanswered.length === 0) return;
  const latest = await run.deps.latestTimesBySubject(run.connection, ATTRIBUTION_SUBJECT_TYPE);
  for (const { attributedToUserId, ref } of unanswered) {
    const subjectId = attributionSubjectId(ref);
    const policyKey = noticePolicy(ref.kind);
    if (latest.has(latestKey(subjectId, policyKey))) continue;
    if (!run.take()) return;
    if (run.options.dryRun) {
      run.options.log(`escalationSweep: would raise ${policyKey} on ${subjectId}`);
      run.report.raised += 1;
      continue;
    }
    await run.attempt(`raising ${policyKey} on ${subjectId}`, async () => {
      const result = await run.deps.raise(run.connection, {
        actor: SWEEP_ACTOR,
        notify: run.notifyOptions(),
        now: run.now,
        policyKey,
        subjectId,
        subjectType: ATTRIBUTION_SUBJECT_TYPE,
        userTargets: [attributedToUserId],
      });
      if (result.created) run.report.raised += 1;
    });
  }
}

// ── 3c. Unacknowledged tenant requests (TR1) ───────────────────────────────

/**
 * A request still unacknowledged past the response target for its priority gets request.unacknowledged. With no
 * target set the list is empty, so nothing is raised. A request that has had one before is left alone, so one a
 * person closed without acknowledging isn't raised again every half hour.
 */
async function raiseUnacknowledgedRequests(run: Run): Promise<void> {
  const list = run.deps.listOverdueRequests;
  if (!list) return;
  const overdue = await list(run.connection, run.now);
  if (overdue.length === 0) return;
  const latest = await run.deps.latestTimesBySubject(run.connection, REQUEST_SUBJECT_TYPE);
  for (const request of overdue) {
    const subjectId = String(request.workRequestId);
    if (latest.has(latestKey(subjectId, REQUEST_POLICY))) continue;
    if (!run.take()) return;
    if (run.options.dryRun) {
      run.options.log(`escalationSweep: would raise ${REQUEST_POLICY} on request #${subjectId}`);
      run.report.raised += 1;
      continue;
    }
    await run.attempt(`raising ${REQUEST_POLICY} on request #${subjectId}`, async () => {
      const result = await run.deps.raise(run.connection, {
        actor: SWEEP_ACTOR,
        context: { dueAt: request.dueAt.toISOString(), priority: request.priority },
        headline: `${request.priority} priority, not acknowledged yet`,
        notify: run.notifyOptions(),
        now: run.now,
        policyKey: REQUEST_POLICY,
        subjectId,
        subjectType: REQUEST_SUBJECT_TYPE,
      });
      if (result.created) run.report.raised += 1;
    });
  }
}

// ── 4. Follow-up emails ──────────────────────────────────────────────────────

/** The moment from which a new email counts as a follow-up on a row. */
export function followUpSince(row: Pick<EscalationRow, "createdAt" | "lastFollowUpAt" | "lastNotifiedAt">): Date {
  return new Date(Math.max(row.createdAt.getTime(), row.lastNotifiedAt?.getTime() ?? 0, row.lastFollowUpAt?.getTime() ?? 0));
}

async function restartOnFollowUps(run: Run): Promise<void> {
  // Emergencies don't wait for a tenant's email to restart their clock, and a next step
  // is due when its decision said, whatever mail arrives about the job.
  const rows = (await run.deps.listLiveEscalations(run.connection)).filter(
    (row) => row.status === "open" && row.kind === "attention" && !row.urgent && row.subjectType === "job" && !isNextStepRow(row),
  );
  if (rows.length === 0) return;

  const jobIds = [...new Set(rows.map((row) => Number(row.subjectId)).filter(Number.isInteger))];
  const arrivals = await run.deps.latestEmailArrivals(run.connection, jobIds);

  for (const row of rows) {
    const arrival = arrivals.get(Number(row.subjectId));
    if (!arrival || arrival.getTime() <= followUpSince(row).getTime()) continue;
    if (!run.take()) return;

    if (run.options.dryRun) {
      run.options.log(`escalationSweep: would restart the clock on #${row.escalationId} ${row.policyKey} (new email on job ${row.subjectId})`);
      run.report.followUps += 1;
      continue;
    }
    await run.attempt(`restarting escalation #${row.escalationId}`, async () => {
      await run.deps.escalateFurther(run.connection, {
        actor: SWEEP_ACTOR,
        code: RESOLUTION_CODES.followUp,
        escalationId: row.escalationId,
        expectedRowVersion: row.rowVersion,
        mode: "same_level",
        notify: run.notifyOptions(),
        now: run.now,
        onlyIfOpen: true,
      });
      run.report.followUps += 1;
    });
  }
}

// ── 5. Notification retries ──────────────────────────────────────────────────

async function retryNotifications(run: Run): Promise<void> {
  // Nothing can be sent while the settings are missing; system.health says so.
  if (missingNotificationConfig(run.env).length > 0) return;
  for (const row of await run.deps.listLiveEscalations(run.connection)) {
    if (!isRetryDue(row, run.now)) continue;
    if (run.options.dryRun) {
      run.options.log(`escalationSweep: would retry the ${row.notificationState} notification on #${row.escalationId}`);
      run.report.notificationsRetried += 1;
      continue;
    }
    await run.attempt(`retrying notification on #${row.escalationId}`, async () => {
      await run.deps.notifyTargets(run.connection, row, eventForRetry(row), run.notifyOptions());
      run.report.notificationsRetried += 1;
    });
  }
}

// ── 6. system.health ─────────────────────────────────────────────────────────

const HEALTH_POLICY = "system.health";

async function ensureHealth(run: Run, subjectId: string, headline: string, context: Record<string, unknown>): Promise<void> {
  const live = await run.deps.listLiveEscalations(run.connection);
  if (live.some((row) => rowKey(row) === rowKey({ policyKey: HEALTH_POLICY, subjectId, subjectType: "system" }))) return;
  if (run.options.dryRun) {
    run.options.log(`escalationSweep: would raise ${HEALTH_POLICY} (${subjectId}): ${headline}`);
    run.report.healthRaised += 1;
    return;
  }
  await run.attempt(`raising ${HEALTH_POLICY} (${subjectId})`, async () => {
    const result = await run.deps.raise(run.connection, {
      actor: SWEEP_ACTOR,
      context,
      notify: run.notifyOptions(),
      now: run.now,
      policyKey: HEALTH_POLICY,
      skipConditionCheck: true,
      subjectId,
      subjectType: "system",
      summary: headline,
    });
    if (result.created) run.report.healthRaised += 1;
  });
}

async function checkHealth(run: Run): Promise<void> {
  const missing = missingNotificationConfig(run.env);
  if (missing.length > 0) {
    await ensureHealth(run, SYSTEM_SUBJECTS.notificationConfig, `Escalation emails can't be sent: ${missing.join(", ")} not set`, { missing });
  }
  const exhausted = await run.deps.countExhaustedNotifications(run.connection, MAX_NOTIFICATION_ATTEMPTS);
  if (exhausted > 0) {
    await ensureHealth(run, SYSTEM_SUBJECTS.notifications, `${exhausted} escalation email${exhausted === 1 ? "" : "s"} could not be sent after ${MAX_NOTIFICATION_ATTEMPTS} tries`, { count: exhausted });
  }
}

/** The last word on the run: failures raise health to admin, a clean run ends it. */
async function reportRun(run: Run): Promise<void> {
  if (run.report.errors.length > 0) {
    const errors = run.report.errors.slice(0, 5);
    await ensureHealth(run, SYSTEM_SUBJECTS.sweep, `The escalation sweep had ${run.report.errors.length} problem${run.report.errors.length === 1 ? "" : "s"}: ${errors[0]}`.slice(0, 400), { errors });
    return;
  }
  const open = (await run.deps.listLiveEscalations(run.connection)).find(
    (row) => rowKey(row) === rowKey({ policyKey: HEALTH_POLICY, subjectId: SYSTEM_SUBJECTS.sweep, subjectType: "system" }),
  );
  if (!open) return;
  if (run.options.dryRun) {
    run.options.log("escalationSweep: would end the sweep health escalation: this run was clean");
    run.report.healthResolved += 1;
    return;
  }
  await run.attempt("ending the sweep health escalation", async () => {
    await run.deps.autoResolve(run.connection, { escalationId: open.escalationId, expectedRowVersion: open.rowVersion, now: run.now });
    run.report.healthResolved += 1;
  });
}

// ── The run ──────────────────────────────────────────────────────────────────

/**
 * One sweep. Each step is guarded on its own, so a failure in one does not stop
 * the rest; failures are collected and end up in system.health.
 */
export async function runSweep(
  connection: Connection,
  options: SweepOptions,
  deps: SweepDeps = defaultSweepDeps,
): Promise<SweepReport> {
  const env = options.env ?? process.env;
  const run = new Run(connection, options, deps, options.now ?? new Date(), env);

  const badHolidays = parseHolidays(env.ESCALATION_HOLIDAYS).invalid;
  if (badHolidays.length > 0) {
    options.warn(`escalationSweep: ESCALATION_HOLIDAYS has entries that are not YYYY-MM-DD dates and are ignored: ${badHolidays.join(", ")}`);
  }

  const steps: [string, (run: Run) => Promise<void>][] = [
    ["ending cleared conditions", endClearedConditions],
    ["moving up overdue escalations", moveUpOverdue],
    ["sending scheduled reminders", sendScheduledReminders],
    ["asking deferred decisions again", reaskDeferred],
    ["raising for jobs", raiseForJobs],
    ["raising attribution notices", raiseAttributionNotices],
    ["raising unacknowledged requests", raiseUnacknowledgedRequests],
    ["restarting on follow-up emails", restartOnFollowUps],
    ["retrying notifications", retryNotifications],
    ["checking health", checkHealth],
  ];
  for (const [name, step] of steps) {
    try {
      await step(run);
    } catch (error) {
      run.fail(name, error);
    }
  }
  try {
    await reportRun(run);
  } catch (error) {
    run.fail("reporting the run", error);
  }

  const r = run.report;
  options.log(
    `escalationSweep: ${options.dryRun ? "DRY RUN (nothing written), would" : "done,"} raised=${r.raised} superseded=${r.superseded} reminded=${r.reminded} ` +
      `scheduledReminders=${r.scheduledReminders} reasked=${r.reasked} autoResolved=${r.autoResolved} followUps=${r.followUps} notificationsRetried=${r.notificationsRetried} ` +
      `healthRaised=${r.healthRaised} healthResolved=${r.healthResolved} skippedAsHandled=${r.skippedAsHandled} ` +
      `errors=${r.errors.length}${r.truncated ? " (stopped at the action limit; the rest waits for the next run)" : ""}`,
  );
  return r;
}
