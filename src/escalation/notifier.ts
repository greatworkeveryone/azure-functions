// Escalation emails (PLAN §3.7, D21). They run after the escalation is
// committed and never block or undo it:
//
//   raise      -> email the targets
//   supersede  -> email the new level, and tell the previous level (FYI)
//   resolve    -> email the raiser, when a person raised it
//
// An email is a pointer into Floorplan with a link, never the place a decision
// is made. The recipients are active AppUsers by role (FACILITIES_MANAGER_EMAILS
// stands in only while no active facilities_manager exists), every address goes
// through resolveRecipient so DEV_EMAIL_OVERRIDE is honoured, and a send that
// fails is recorded as failed, never as delivered, and retried later with back-off
// (the sweep calls retryDue).

import type { Connection } from "tedious";
import { resolveRecipient } from "../email-recipient";
import { graphSendMail } from "../graph";
import { formatDarwinDateTime } from "../ledger/darwinTime";
import { getAdapter } from "./adapters/registry";
import { absoluteLink, fallbackEmailsByRole, MAX_NOTIFICATION_ATTEMPTS, missingNotificationConfig } from "./config";
import { normaliseRole, ROLES, roleLabel } from "./roles";
import { listActiveUsers, recordNotification } from "./store";
import { REASON_LABELS, type DirectoryUser, type EscalationRow, type ManualReason, type NotificationState } from "./types";

export type SendMail = (to: string[], subject: string, body: string) => Promise<void>;

export type NotifyEvent = "follow_up" | "raise" | "reminder" | "supersede";

export interface NotifyOptions {
  /** Tries before giving up in this call (default 1: HTTP requests don't wait). */
  attempts?: number;
  /** First wait between tries, doubled each time (default 500 ms). */
  backoffMs?: number;
  env?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
  now?: () => Date;
  sendMail?: SendMail;
  sleep?: (ms: number) => Promise<void>;
  /** The directory, when the caller already loaded it. */
  users?: readonly DirectoryUser[];
}

export interface NotifyOutcome {
  attempts: number;
  error: string | null;
  recipients: string[];
  state: NotificationState;
}

// Told when nobody independent is at the level (NoIndependentTarget).
const OVERSIGHT_ROLES: ReadonlySet<string> = new Set([ROLES.director, ROLES.admin]);

const defaultSend: SendMail = (to, subject, body) => graphSendMail(to, subject, body);
const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const NOTE_IN_EMAIL_MAX = 300;

// ── Who to tell ──────────────────────────────────────────────────────────────

function excludedUserIds(row: EscalationRow): Set<number> {
  const excluded = new Set<number>();
  if (row.raisedByUserId !== null) excluded.add(row.raisedByUserId);
  const named = row.context?.excludeUserIds;
  if (Array.isArray(named)) for (const id of named) if (typeof id === "number") excluded.add(id);
  return excluded;
}

/** The people an escalation row is for. A row that is flagged NoIndependentTarget
 *  tells the directors and admin, since there is no one else to look at it. */
export function targetUsers(row: EscalationRow, users: readonly DirectoryUser[]): DirectoryUser[] {
  const excluded = excludedUserIds(row);
  const active = users.filter((user) => !excluded.has(user.userId));
  if (row.noIndependentTarget) {
    return active.filter((user) => OVERSIGHT_ROLES.has(normaliseRole(user.role)));
  }
  if (row.targetUserId !== null) return active.filter((user) => user.userId === row.targetUserId);
  const role = normaliseRole(row.targetRole);
  return role === "" ? [] : active.filter((user) => normaliseRole(user.role) === role);
}

/** Email addresses to send to: the target users', or the env list when a
 *  facilities_manager level has no active user. DEV_EMAIL_OVERRIDE applied. */
export function targetAddresses(row: EscalationRow, users: readonly DirectoryUser[], env: NodeJS.ProcessEnv = process.env): string[] {
  let real = targetUsers(row, users).map((user) => user.email);
  if (real.every((address) => !address) && normaliseRole(row.targetRole) === ROLES.facilitiesManager && !row.noIndependentTarget) {
    // No active facilities manager to tell: the env list stands in, minus the raiser.
    const raiserEmail = users.find((user) => user.userId === row.raisedByUserId)?.email?.toLowerCase();
    real = (fallbackEmailsByRole(env)[ROLES.facilitiesManager] ?? []).filter((address) => address.toLowerCase() !== raiserEmail);
  }
  return uniqueAddresses(real);
}

function uniqueAddresses(real: readonly (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const address of real) {
    const resolved = resolveRecipient(address).address;
    if (!resolved) continue;
    const key = resolved.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(resolved);
  }
  return result;
}

// ── What to say ──────────────────────────────────────────────────────────────

const HEADLINES: Record<NotifyEvent | "fyi" | "resolved", string> = {
  follow_up: "A new email about this arrived, so the clock on it has restarted.",
  fyi: "This has moved up a level because it wasn't picked up in time. You don't need to do anything.",
  raise: "Something needs your attention in Floorplan.",
  reminder: "This is still waiting for someone to pick it up.",
  resolved: "This has been resolved.",
  supersede: "This has been escalated to you.",
};

function reasonLine(row: EscalationRow): string[] {
  const lines: string[] = [];
  if (row.reason) lines.push(`Reason: ${REASON_LABELS[row.reason as ManualReason] ?? row.reason}`);
  if (row.note) lines.push(`Note: ${row.note.length > NOTE_IN_EMAIL_MAX ? `${row.note.slice(0, NOTE_IN_EMAIL_MAX)}...` : row.note}`);
  return lines;
}

/** Subject and body for one email. Plain text; the link is the point of it. */
export function buildEmail(
  kind: NotifyEvent | "fyi" | "resolved",
  row: EscalationRow,
  link: string | null,
): { body: string; subject: string } {
  const prefix: Record<typeof kind, string> = {
    follow_up: "New email on an escalation",
    fyi: "FYI, moved up",
    raise: row.urgent ? "URGENT escalation" : "Escalation",
    reminder: "Reminder",
    resolved: "Resolved",
    supersede: row.urgent ? "URGENT escalated to you" : "Escalated to you",
  };
  const lines = [
    "Hi,",
    "",
    HEADLINES[kind],
    "",
    row.summary,
    ...reasonLine(row),
    `Raised by: ${row.raisedByKind === "system" ? "Floorplan (automatic)" : row.raisedByName}`,
    `Goes to: ${roleLabel(row.targetRole)}`,
  ];
  if (kind !== "resolved" && row.dueAt) lines.push(`Respond by: ${formatDarwinDateTime(row.dueAt)} Darwin time`);
  lines.push("", link ? `Open it in Floorplan: ${link}` : "Open Floorplan to see it.");
  lines.push("", "This email only points you to Floorplan. Decisions are made there, not by replying.");
  return { body: `${lines.join("\n")}\n`, subject: `${prefix[kind]}: ${row.summary}`.slice(0, 250) };
}

function linkFor(row: EscalationRow, env: NodeJS.ProcessEnv): string | null {
  const adapter = getAdapter(row.subjectType);
  return adapter ? absoluteLink(adapter.deepLink(row.subjectId), env) : null;
}

// ── Sending ──────────────────────────────────────────────────────────────────

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

async function sendWithRetry(
  send: SendMail,
  to: string[],
  subject: string,
  body: string,
  options: NotifyOptions,
): Promise<{ attempts: number; error: string | null }> {
  const total = Math.max(1, Math.trunc(options.attempts ?? 1));
  const sleep = options.sleep ?? defaultSleep;
  let delay = options.backoffMs ?? 500;
  let error: string | null = null;
  for (let attempt = 1; attempt <= total; attempt += 1) {
    try {
      await send(to, subject, body);
      return { attempts: attempt, error: null };
    } catch (caught) {
      error = errorText(caught);
      if (attempt < total) {
        await sleep(delay);
        delay *= 2;
      }
    }
  }
  return { attempts: total, error };
}

async function remember(
  connection: Connection,
  row: EscalationRow,
  outcome: NotifyOutcome,
  now: Date,
  options: NotifyOptions,
): Promise<void> {
  try {
    await recordNotification(
      connection,
      row.escalationId,
      {
        attemptedAt: now,
        error: outcome.error,
        notifiedAt: outcome.state === "sent" ? now : null,
        state: outcome.state,
      },
      outcome.attempts,
    );
  } catch (error) {
    // The escalation is committed and the email may have gone; bookkeeping that
    // can't be written is logged and the sweep's retry will sort it out.
    options.log?.(`escalation ${row.escalationId}: could not record the notification outcome: ${errorText(error)}`);
  }
}

/**
 * Tells the people an escalation row is for and records how it went on the row:
 * sent only after a send succeeded; failed (with the error) after a send failed;
 * pending while settings are missing, with nothing counted; none when there is
 * no one with an address to tell. Never throws.
 */
export async function notifyTargets(
  connection: Connection,
  row: EscalationRow,
  event: NotifyEvent,
  options: NotifyOptions = {},
): Promise<NotifyOutcome> {
  const env = options.env ?? process.env;
  const now = (options.now ?? (() => new Date()))();
  let outcome: NotifyOutcome;
  try {
    const missing = missingNotificationConfig(env);
    if (missing.length > 0) {
      outcome = { attempts: 0, error: `Notification settings are missing: ${missing.join(", ")}`, recipients: [], state: "pending" };
    } else {
      const users = options.users ?? (await listActiveUsers(connection));
      const recipients = targetAddresses(row, users, env);
      if (recipients.length === 0) {
        outcome = { attempts: 0, error: "No one with an email address is at this level", recipients, state: "none" };
      } else {
        const { body, subject } = buildEmail(event, row, linkFor(row, env));
        const sent = await sendWithRetry(options.sendMail ?? defaultSend, recipients, subject, body, options);
        outcome = { attempts: sent.attempts, error: sent.error, recipients, state: sent.error === null ? "sent" : "failed" };
      }
    }
  } catch (error) {
    outcome = { attempts: 0, error: errorText(error), recipients: [], state: "failed" };
  }
  await remember(connection, row, outcome, now, options);
  return outcome;
}

/** Tells the previous level that the escalation has moved up. One try; it is a
 *  courtesy and is not tracked on the row. People who are also in the new level
 *  already got the real email and are left out. */
export async function notifyPreviousLevel(
  connection: Connection,
  previous: EscalationRow,
  next: EscalationRow,
  options: NotifyOptions = {},
): Promise<void> {
  const env = options.env ?? process.env;
  try {
    if (missingNotificationConfig(env).length > 0) return;
    const users = options.users ?? (await listActiveUsers(connection));
    const already = new Set(targetAddresses(next, users, env).map((address) => address.toLowerCase()));
    const recipients = targetAddresses(previous, users, env).filter((address) => !already.has(address.toLowerCase()));
    if (recipients.length === 0) return;
    const { body, subject } = buildEmail("fyi", next, linkFor(next, env));
    await (options.sendMail ?? defaultSend)(recipients, subject, body);
  } catch (error) {
    options.log?.(`escalation ${previous.escalationId}: could not tell the previous level: ${errorText(error)}`);
  }
}

/** Tells a person who raised an escalation that it is resolved. One try, not tracked. */
export async function notifyRaiserResolved(
  connection: Connection,
  row: EscalationRow,
  options: NotifyOptions = {},
): Promise<void> {
  const env = options.env ?? process.env;
  try {
    if (row.raisedByKind !== "user" || row.raisedByUserId === null) return;
    if (row.resolvedByUserId !== null && row.resolvedByUserId === row.raisedByUserId) return;
    if (missingNotificationConfig(env).length > 0) return;
    const users = options.users ?? (await listActiveUsers(connection));
    const raiser = users.find((user) => user.userId === row.raisedByUserId);
    const recipients = uniqueAddresses([raiser?.email]);
    if (recipients.length === 0) return;
    const { body, subject } = buildEmail("resolved", row, linkFor(row, env));
    await (options.sendMail ?? defaultSend)(recipients, subject, body);
  } catch (error) {
    options.log?.(`escalation ${row.escalationId}: could not tell the raiser: ${errorText(error)}`);
  }
}

// ── Retrying ─────────────────────────────────────────────────────────────────

const RETRY_BASE_MS = 15 * 60_000;
const RETRY_MAX_MS = 8 * 60 * 60_000;
/** A pending send younger than this may still be in flight in the request that made it. */
const PENDING_GRACE_MS = 5 * 60_000;

/** Wait before send number `attempts + 1`: 15 min, 30 min, 1 h, 2 h ... up to 8 h. */
export function retryDelayMs(attempts: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1));
}

/** Whether the sweep should try this row's notification again now. */
export function isRetryDue(row: EscalationRow, now: Date): boolean {
  if (row.status !== "open") return false;
  const last = (row.lastNotificationAttemptAt ?? row.createdAt).getTime();
  if (row.notificationState === "pending") return now.getTime() - last >= PENDING_GRACE_MS;
  if (row.notificationState === "failed") {
    return row.notificationAttempts < MAX_NOTIFICATION_ATTEMPTS && now.getTime() - last >= retryDelayMs(row.notificationAttempts);
  }
  return false;
}

/** The email a retry sends is the one the row would have got first. */
export function eventForRetry(row: EscalationRow): NotifyEvent {
  return row.parentEscalationId === null ? "raise" : "supersede";
}
