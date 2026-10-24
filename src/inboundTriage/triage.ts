// Inbound email triage (EB3): route one email. Work out what it is about, who may be given it, rank
// them, then either assign automatically (a strong match) or leave it for a manager's "Needs
// triage" queue with the top three. Every set, assignment and outcome is logged in the same
// transaction as the change it records, and an assignment is ledgered.
//
// A dry run does everything except the writes and says what it would have done.

import type { Connection } from "tedious";
import { TYPES } from "tedious";
import { accessLoggingEnabled } from "../access/accessEvents";
import { executeQuery } from "../db";
import { record } from "../ledger";
import { buildContext, readWork, type TriageEmail } from "./context";
import { decide, QUEUE_SUGGESTIONS, type Verdict } from "./decide";
import { insertOutcome, insertSet, type LoggedItem } from "./eventLog";
import { buildVectors, chooseEligible, FEATURE_SCHEMA_VERSION, JOB_WINDOW_DAYS, toCandidates } from "./features";
import { loadActivity, loadAssignedJobs, loadOnLeave, loadStaff, type ActivityFacts } from "./load";
import { storeLink } from "./replyLink";
import { tidyReasons } from "./reasons";
import { withTransaction } from "./tx";
import type { Candidate, Ranker, ScoredCandidate, TriageContext } from "./types";

/** How many ranked people are logged with a set; the queue shows the first three. */
export const MAX_LOGGED = 5;
export const AUTOMATIC = "Floorplan (automatic)";

/** Said first beside every suggestion for an email whose sender could not be verified, so the manager reads it before choosing. */
export const SENDER_UNVERIFIED_REASON = "The sender could not be verified, so this email may not be from who it says.";
export const REPLY_UNVERIFIED_REASON = "Replies to a message Floorplan sent, but not from the address it was sent to.";

export interface TriageOptions {
  dryRun: boolean;
  inactivityDays: number;
  now: Date;
  ranker: Ranker;
}

export interface TriageResult {
  chosen: { name: string; userId: number } | null;
  /** "skipped": someone assigned the email by hand while it was being triaged, so nothing was kept. */
  decision: "auto" | "queued" | "skipped";
  emailId: number;
  rule: Verdict["rule"];
  setId: number | null;
}

/** Whatever a ranker returns is untrusted: only people it was given, each once, with a real score. */
export function acceptRanked(candidates: readonly Candidate[], ranked: readonly ScoredCandidate[]): ScoredCandidate[] {
  const allowed = new Set(candidates.map((candidate) => candidate.userId));
  const seen = new Set<number>();
  return ranked
    .filter((item) => {
      if (!allowed.has(item.userId) || seen.has(item.userId) || !Number.isFinite(item.score)) return false;
      seen.add(item.userId);
      return true;
    })
    .map((item) => ({ ...item, reasons: tidyReasons(item.reasons) }));
}

async function activityFor(connection: Connection, userIds: readonly number[]): Promise<ActivityFacts | null> {
  if (!accessLoggingEnabled()) return null;
  try {
    return await loadActivity(connection, userIds);
  } catch {
    // The log cannot be read: nobody is held back for it, and the ranking says nothing about sign-ins.
    return null;
  }
}

/** The ranked candidates for an email's context: eligibility, features, then the ranker. */
export async function rankFor(
  connection: Connection,
  context: TriageContext,
  options: { inactivityDays: number; namedJobAssignee: number | null; now: Date; ranker: Ranker },
): Promise<{ candidates: Candidate[]; ranked: ScoredCandidate[] }> {
  const staff = await loadStaff(connection, context.linkedSend?.sentByUserId ?? null);
  const onLeave = await loadOnLeave(connection, context.today);
  const activity = await activityFor(connection, staff.map((person) => person.userId));
  const { eligible } = chooseEligible(staff, context.lane, {
    activity,
    inactivityDays: options.inactivityDays,
    linkedSenderId: context.linkedSend?.sentByUserId ?? null,
    now: options.now,
    onLeave,
  });
  const since = new Date(options.now.getTime() - JOB_WINDOW_DAYS * 86_400_000);
  const jobs = await loadAssignedJobs(connection, eligible.map((person) => person.userId), since);
  const vectors = buildVectors(eligible, jobs, context, { activity, namedJobAssignee: options.namedJobAssignee, now: options.now });
  const candidates = toCandidates(eligible, vectors);
  return { candidates, ranked: acceptRanked(candidates, await options.ranker.rank(candidates, context)) };
}

const ASSIGN_SQL = `UPDATE dbo.Emails
     SET AssignedToUserId = @UserId, AssignedAt = SYSUTCDATETIME(), AssignedBy = @AssignedBy, AssignmentReason = @Reason
   OUTPUT INSERTED.EmailID
   WHERE EmailID = @EmailId AND AssignedToUserId IS NULL`;

export const assignmentReason = (reasons: readonly { text: string }[]): string => reasons.map((reason) => reason.text).join("\n").slice(0, 1000);

export async function triageEmail(connection: Connection, email: TriageEmail, options: TriageOptions): Promise<TriageResult> {
  const work = await readWork(email);
  const { context, namedJob } = await buildContext(connection, email, work, options.now);
  const { candidates, ranked } = await rankFor(connection, context, {
    inactivityDays: options.inactivityDays,
    namedJobAssignee: namedJob?.assignedToUserId ?? null,
    now: options.now,
    ranker: options.ranker,
  });
  const verdict = decide(ranked, context);
  const warning = verdict.rule === "sender_unverified" ? SENDER_UNVERIFIED_REASON : verdict.rule === "reply_unverified" ? REPLY_UNVERIFIED_REASON : null;
  const shown = warning ? ranked.map((item) => ({ ...item, reasons: [{ caution: true, text: warning }, ...item.reasons] })) : ranked;
  const chosen = verdict.decision === "auto" ? verdict.chosen : null;
  const result: TriageResult = {
    chosen: chosen ? { name: chosen.name, userId: chosen.userId } : null,
    decision: verdict.decision,
    emailId: email.emailId,
    rule: verdict.rule,
    setId: null,
  };
  if (options.dryRun) return result;

  // Link the reply (once) now that the lookup has been asked: a send core that landed after the sync still catches up.
  if (context.linkedSend) await storeLink(connection, email.emailId, context.linkedSend);

  const top: LoggedItem[] = shown.slice(0, MAX_LOGGED).map((item, index) => ({ features: item.features, rank: index + 1, reasons: item.reasons, score: item.score, userId: item.userId }));
  const logged = await withTransaction(connection, async () => {
    const setId = await insertSet(
      connection,
      {
        actorName: AUTOMATIC,
        candidateCount: candidates.length,
        category: context.category,
        context,
        decision: verdict.decision,
        featureSchemaVersion: FEATURE_SCHEMA_VERSION,
        intent: context.intent,
        isTest: email.isTest,
        lane: context.lane,
        rankerVersion: options.ranker.version,
        urgency: context.urgency,
        workSource: work.source,
      },
      top,
    );
    if (!chosen) return { setId };

    const rows = await executeQuery(connection, ASSIGN_SQL, [
      { name: "EmailId", type: TYPES.Int, value: email.emailId },
      { name: "UserId", type: TYPES.Int, value: chosen.userId },
      { name: "AssignedBy", type: TYPES.NVarChar, value: AUTOMATIC },
      { name: "Reason", type: TYPES.NVarChar, value: assignmentReason(chosen.reasons) },
    ]);
    // Someone assigned it by hand since the batch read it: theirs stands, and none of this is kept.
    if (rows.length === 0) return null;
    const position = ranked.findIndex((item) => item.userId === chosen.userId) + 1;
    await insertOutcome(connection, {
      actorName: AUTOMATIC,
      actorOid: null,
      chosenFeatures: null,
      chosenRank: position <= MAX_LOGGED ? position : null,
      chosenUserId: chosen.userId,
      emailId: email.emailId,
      outcome: "auto_assigned",
      previousUserId: null,
      setId,
    });
    await record(connection, {
      action: "email.auto_assign",
      actor: { kind: "system", name: "inboundTriage" },
      after: { assignedToUserId: chosen.userId, assignedTo: chosen.name, reasons: chosen.reasons.map((reason) => reason.text) },
      before: { assignedToUserId: null },
      buildingId: context.buildingId,
      jobId: context.matchedJobId,
      ruleApplied: verdict.rule,
      subject: { id: email.emailId, type: "email" },
      tenantId: context.tenancyId,
    });
    return { setId };
  });
  return logged ? { ...result, setId: logged.setId } : { ...result, chosen: null, decision: "skipped", setId: null };
}
