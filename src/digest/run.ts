// One run of the morning digest (N1): read the facts once, work out what needs
// each person, and send each person who has something one email. Nobody gets an
// email when nothing needs them. Opt-outs are respected, addresses go through
// resolveRecipient (DEV_EMAIL_OVERRIDE), and one person's failed send never stops
// the others. A dry run does everything except send.
//
// Reads only: nothing in the database is written.

import type { Connection } from "tedious";
import { loadApprovalFacts } from "../approvalAuthority-db";
import type { AuthorityFacts } from "../approvalAuthority";
import { resolveRecipient } from "../email-recipient";
// Registers the escalation adapters, whose links the escalation lines use.
import "../escalation/adapters";
import { appBaseUrl, missingNotificationConfig } from "../escalation/config";
import { darwinDateKey } from "../escalation/businessTime";
import { graphSendMail } from "../graph";
import { assertMayLeave, type EgressSubject } from "../test-data";
import { DIGEST_MAX_LINES } from "./config";
import { buildDigestEmail } from "./email";
import { deriveItems, type DeriveContext } from "./items";
import { loadDigestFacts } from "./store";
import type { DigestFacts, DigestUser } from "./types";

/** `egress` is what the digest names; one that names a test record is refused (D9). */
export type SendMail = (to: string[], subject: string, body: string, egress: EgressSubject) => Promise<void>;

export interface DigestOptions {
  dryRun: boolean;
  env?: NodeJS.ProcessEnv;
  log: (message: string) => void;
  now?: Date;
}

/** What a run did. In a dry run `wouldSend` is what it would have sent. */
export interface DigestReport {
  /** Mail settings that are missing; the run sent and read nothing. */
  configMissing: string[];
  /** People considered: active, with a role, not opted out. */
  considered: number;
  dryRun: boolean;
  errors: string[];
  /** Had something waiting but no email address. */
  noAddress: number;
  /** Considered, but nothing needed them. */
  nothingToSend: number;
  optedOut: number;
  sent: number;
  wouldSend: number;
}

/** The pieces a run depends on, so the rules can be tested without a database or Graph. */
export interface DigestDeps {
  authority(connection: Connection, buildingIds: readonly (number | null)[]): Promise<DeriveContext["authorityFacts"]>;
  load(connection: Connection, now: Date): Promise<DigestFacts>;
  send: SendMail;
}

/** Approval-authority facts per building, loaded once each. Until residences
 *  (WP44) every building gets the same facts, but the seam is per building. */
async function loadAuthority(connection: Connection, buildingIds: readonly (number | null)[]): Promise<DeriveContext["authorityFacts"]> {
  const byBuilding = new Map<number, AuthorityFacts>();
  for (const id of new Set<number>([0, ...buildingIds.filter((id): id is number => id !== null)])) {
    byBuilding.set(id, await loadApprovalFacts(connection, id));
  }
  return (buildingId) => byBuilding.get(buildingId ?? 0) ?? (byBuilding.get(0) as AuthorityFacts);
}

export const defaultDeps: DigestDeps = {
  authority: loadAuthority,
  load: loadDigestFacts,
  send: (to, subject, body, egress) => graphSendMail(egress, to, subject, body),
};

function emptyReport(dryRun: boolean): DigestReport {
  return { configMissing: [], considered: 0, dryRun, errors: [], noAddress: 0, nothingToSend: 0, optedOut: 0, sent: 0, wouldSend: 0 };
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

export async function runDigest(connection: Connection, options: DigestOptions, deps: DigestDeps = defaultDeps): Promise<DigestReport> {
  const env = options.env ?? process.env;
  const now = options.now ?? new Date();
  const report = emptyReport(options.dryRun);

  // A dry run sends nothing, so it can be read before the mail settings exist.
  const missing = options.dryRun ? [] : missingNotificationConfig(env);
  if (missing.length > 0) {
    report.configMissing = missing;
    report.errors.push(`Notification settings are missing: ${missing.join(", ")}`);
    return report;
  }

  const facts = await deps.load(connection, now);
  const buildingIds = facts.waitingApprovals.map((approval) => approval.buildingId);
  const authorityFacts = await deps.authority(connection, buildingIds);
  const context: DeriveContext = { authorityFacts, now };
  const today = darwinDateKey(now);

  // Everything for one person runs in one try: a problem with one person's items,
  // email or send is recorded against them and never stops the others.
  const handle = async (user: DigestUser): Promise<void> => {
    const items = deriveItems(user, facts, context);
    if (items.length === 0) {
      report.nothingToSend += 1;
      return;
    }

    const recipient = resolveRecipient(user.email);
    if (!recipient.address) {
      report.noAddress += 1;
      options.log(`digest: user #${user.userId} has ${items.length} item(s) waiting but no email address`);
      return;
    }

    const email = buildDigestEmail(user, items, {
      baseUrl: appBaseUrl(env),
      maxLines: DIGEST_MAX_LINES,
      overriddenFrom: recipient.overridden ? recipient.original : null,
      today,
    });

    if (options.dryRun) {
      report.wouldSend += 1;
      options.log(`digest dry run: would email user #${user.userId} (${user.role}) "${email.subject}"`);
      for (const item of items.slice(0, DIGEST_MAX_LINES)) options.log(`  ${item.line} -> ${item.path}`);
      if (items.length > DIGEST_MAX_LINES) options.log(`  and ${items.length - DIGEST_MAX_LINES} more`);
      return;
    }

    // The reads already leave test records out; this is the last check before
    // anything leaves (an item's key is "job:<id>" for a job line).
    const egress = { isTest: items.some((item) => facts.testKeys?.has(item.dedupeKey) ?? false) };
    assertMayLeave("digest", egress);
    await deps.send([recipient.address], email.subject, email.body, egress);
    report.sent += 1;
  };

  for (const user of facts.users) {
    if (user.optedOut) {
      report.optedOut += 1;
      continue;
    }
    report.considered += 1;
    try {
      await handle(user);
    } catch (error) {
      report.errors.push(`user #${user.userId}: ${errorText(error)}`);
    }
  }
  return report;
}

/** The one log line a run leaves: the counts a TimerRuns row records. */
export function formatDigestSummary(report: DigestReport, darwinDate: string): string {
  const skipped = report.nothingToSend + report.optedOut + report.noAddress;
  const lead = report.dryRun ? `dry-run: wouldSend=${report.wouldSend} sent=${report.sent}` : `live: sent=${report.sent}`;
  return `digest ${darwinDate} ${lead} skipped=${skipped} errors=${report.errors.length} (nothingToSend=${report.nothingToSend} optedOut=${report.optedOut} noAddress=${report.noAddress})`;
}
