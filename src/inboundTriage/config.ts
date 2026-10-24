// Inbound email triage (EB3): the switches, read once per run. Everything here is
// off or empty by default, so until Will sets something the mailboxes Floorplan
// reads and what it does with the mail are exactly as before. See
// docs/runbooks/switches.md.

import { incomingMailbox } from "../email/mailbox";

const ADDRESS = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;
const DEFAULT_NOTICES = "notices@randazzo.properties";

export interface InboundConfig {
  /** Mail older than this many days is left alone when triage is first switched on. */
  maxAgeDays: number;
  /** Most emails one run triages; the rest wait for the next. */
  maxPerRun: number;
  /** Days without a sign-in after which someone is not chosen. */
  inactivityDays: number;
  /** Extra mailboxes read into Incoming, each with its own watermark (EmailSyncState). */
  extraMailboxes: string[];
  /** Entries of INBOUND_EXTRA_MAILBOXES or INBOUND_TRIAGE_MAILBOXES that are not addresses; ignored and logged. */
  ignored: string[];
  /** The mailboxes whose mail is triaged: notices@, plus INBOUND_TRIAGE_MAILBOXES. Lower case. */
  triageMailboxes: string[];
  /** INBOUND_TRIAGE_DRY_RUN: work out and log every decision, change nothing. Wins over enabled. */
  dryRun: boolean;
  /** INBOUND_TRIAGE_ENABLED equals "true". */
  enabled: boolean;
}

function wholeBetween(raw: string | undefined, fallback: number, max: number): number {
  const n = Number(raw);
  return raw !== undefined && /^\d+$/.test(raw.trim()) && n >= 1 && n <= max ? n : fallback;
}

function addresses(raw: string | undefined, ignored: string[]): string[] {
  const out: string[] = [];
  for (const part of (raw ?? "").split(",")) {
    const value = part.trim().toLowerCase();
    if (value === "") continue;
    if (!ADDRESS.test(value)) ignored.push(value);
    else if (!out.includes(value)) out.push(value);
  }
  return out;
}

/** The mailbox mail "to notices@" arrives in: INBOUND_NOTICES_MAILBOX, else the address Floorplan sends from, else the decided one (PLAN §13). */
export function noticesMailbox(env: Record<string, string | undefined> = process.env): string {
  for (const candidate of [env.INBOUND_NOTICES_MAILBOX, env.COMMS_FROM_ADDRESS]) {
    const value = candidate?.trim().toLowerCase();
    if (value && ADDRESS.test(value)) return value;
  }
  return DEFAULT_NOTICES;
}

export function readInboundConfig(env: Record<string, string | undefined> = process.env): InboundConfig {
  const ignored: string[] = [];
  const primary = incomingMailbox()?.toLowerCase() ?? null;
  const extraMailboxes = addresses(env.INBOUND_EXTRA_MAILBOXES, ignored).filter((mailbox) => mailbox !== primary);
  const triageMailboxes = [noticesMailbox(env), ...addresses(env.INBOUND_TRIAGE_MAILBOXES, ignored)].filter(
    (mailbox, index, all) => all.indexOf(mailbox) === index,
  );
  return {
    dryRun: env.INBOUND_TRIAGE_DRY_RUN === "true",
    enabled: env.INBOUND_TRIAGE_ENABLED === "true",
    extraMailboxes,
    ignored,
    inactivityDays: wholeBetween(env.INBOUND_TRIAGE_INACTIVITY_DAYS, 7, 365),
    maxAgeDays: wholeBetween(env.INBOUND_TRIAGE_MAX_AGE_DAYS, 3, 60),
    maxPerRun: wholeBetween(env.INBOUND_TRIAGE_MAX_PER_RUN, 25, 200),
    triageMailboxes,
  };
}

/**
 * True when the sync should write the inbound columns (migration 176): triage is on, or an extra mailbox
 * is set. With both off the sync's SQL is exactly what it was before 176, so a database that has not had
 * 176 applied yet is never asked for a column it lacks.
 */
export function inboundColumnsOn(config: InboundConfig = readInboundConfig()): boolean {
  return config.enabled || config.dryRun || config.extraMailboxes.length > 0;
}
