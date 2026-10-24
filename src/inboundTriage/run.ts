// Inbound email triage (EB3): the batch. Picks the emails that still need an owner, positively: mail
// to a triage mailbox (notices@, plus INBOUND_TRIAGE_MAILBOXES), arrived recently, unassigned, not
// yet triaged, not test data, not from the mailbox itself. Each is triaged on its own, so one bad
// email is counted and logged without holding up the rest. Nothing runs unless INBOUND_TRIAGE_ENABLED
// or INBOUND_TRIAGE_DRY_RUN equals "true".

import { TYPES, type Connection } from "tedious";
import { executeQuery } from "../db";
import { Sentry } from "../sentry";
import { readInboundConfig, type InboundConfig } from "./config";
import type { TriageEmail } from "./context";
import { resolveRanker } from "./registry";
import { triageEmail } from "./triage";
import type { Ranker } from "./types";

export interface TriageRunSummary {
  assigned: number;
  dryRun: boolean;
  examined: number;
  failed: number;
  queued: number;
  skipped: number;
}

const PENDING_SQL = `SELECT TOP (@Max) e.EmailID, e.Mailbox, e.FromAddress, e.Subject, e.Body, e.ReceivedAt, e.MatchedJobID,
    e.AIClassification, e.AIParsedData, e.AIFlaggedForReview, e.InReplyTo, e.ReferenceIds, e.IsTest, e.SenderAuthenticated
  FROM dbo.Emails e
  WHERE e.Mailbox IN (SELECT [value] FROM OPENJSON(@Mailboxes))
    AND e.AssignedToUserId IS NULL AND e.Status IN ('unread', 'matched') AND e.ArchivedAt IS NULL
    AND e.IsTest = 0 AND e.Source = 'graph' AND e.ReceivedAt >= @Since
    AND (e.FromAddress IS NULL OR e.FromAddress <> e.Mailbox)
    AND NOT EXISTS (SELECT 1 FROM dbo.EmailRoutingSets s WHERE s.EmailId = e.EmailID)
  ORDER BY e.ReceivedAt`;

export async function loadPending(connection: Connection, config: InboundConfig, now: Date): Promise<TriageEmail[]> {
  const rows = await executeQuery(connection, PENDING_SQL, [
    { name: "Max", type: TYPES.Int, value: config.maxPerRun },
    { name: "Mailboxes", type: TYPES.NVarChar, value: JSON.stringify(config.triageMailboxes) },
    { name: "Since", type: TYPES.DateTime2, value: new Date(now.getTime() - config.maxAgeDays * 86_400_000) },
  ]);
  return rows.map((row) => ({
    aiClassification: (row.AIClassification as string | null) ?? null,
    aiFlagged: row.AIFlaggedForReview === true || row.AIFlaggedForReview === 1,
    aiParsedData: (row.AIParsedData as string | null) ?? null,
    body: (row.Body as string | null) ?? null,
    emailId: Number(row.EmailID),
    fromAddress: (row.FromAddress as string | null) ?? null,
    inReplyTo: (row.InReplyTo as string | null) ?? null,
    isTest: row.IsTest === true || row.IsTest === 1,
    mailbox: (row.Mailbox as string | null) ?? null,
    matchedJobId: row.MatchedJobID === null || row.MatchedJobID === undefined ? null : Number(row.MatchedJobID),
    receivedAt: row.ReceivedAt ? new Date(row.ReceivedAt as Date | string) : null,
    referenceIds: (row.ReferenceIds as string | null) ?? null,
    senderAuthenticated: row.SenderAuthenticated === null || row.SenderAuthenticated === undefined ? null : row.SenderAuthenticated === true || row.SenderAuthenticated === 1,
    subject: (row.Subject as string | null) ?? null,
  }));
}

export interface RunDeps {
  config?: InboundConfig;
  log?: (message: string) => void;
  now?: Date;
  ranker?: Ranker;
  /** No new email is started after this time (epoch ms); the rest wait for the next run. */
  until?: number;
}

/** Null when triage is off (nothing was read). */
export async function runInboundTriage(connection: Connection, deps: RunDeps = {}): Promise<TriageRunSummary | null> {
  const config = deps.config ?? readInboundConfig();
  if (!config.enabled && !config.dryRun) return null;
  const log = deps.log ?? (() => undefined);
  const now = deps.now ?? new Date();
  const dryRun = config.dryRun;
  const { fellBack, ranker, requested } = deps.ranker ? { fellBack: false, ranker: deps.ranker, requested: deps.ranker.version } : resolveRanker();
  if (fellBack) log(`TRIAGE_RANKER "${requested}" is not a registered ranker; using ${ranker.version}`);

  const summary: TriageRunSummary = { assigned: 0, dryRun, examined: 0, failed: 0, queued: 0, skipped: 0 };
  const pending = await loadPending(connection, config, now);
  for (const email of pending) {
    if (deps.until !== undefined && Date.now() >= deps.until) break;
    summary.examined += 1;
    try {
      const result = await triageEmail(connection, email, { dryRun, inactivityDays: config.inactivityDays, now, ranker });
      if (result.decision === "auto") summary.assigned += 1;
      else if (result.decision === "queued") summary.queued += 1;
      else summary.skipped += 1;
      if (dryRun) log(`inbound triage dry run: email ${email.emailId} would be ${result.decision === "auto" ? `assigned to user ${result.chosen?.userId} (${result.rule})` : `queued for a manager (${result.rule})`}`);
    } catch (error) {
      summary.failed += 1;
      log(`inbound triage: email ${email.emailId} failed: ${error instanceof Error ? error.message : String(error)}`);
      Sentry.captureException(error, { extra: { context: "inbound triage failed", emailId: email.emailId } });
    }
  }
  return summary;
}
