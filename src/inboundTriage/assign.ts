// Inbound email triage (EB3): a manager gives an email to someone, or moves it to someone else. The
// change, its routing-log outcome and its ledger row commit together. A person is never chosen
// from stale information: the screen sends who it believed had the email, and a different answer is
// a 409, not an overwrite. Nobody on approved leave today is chosen (the ranker never picks them
// either), and only staff roles are handed Incoming email.

import { TYPES, type Connection } from "tedious";
import { executeQuery } from "../db";
import { record } from "../ledger";
import type { LedgerActor } from "../ledger/types";
import { buildVectors, FEATURE_SCHEMA_VERSION, JOB_WINDOW_DAYS } from "./features";
import { insertOutcome, insertSet, readLatestSet, type StoredSet } from "./eventLog";
import { loadAssignedJobs, loadJob, loadOnLeave, STAFF_ROLES } from "./load";
import { todayInDarwin } from "../darwinDate";
import { withTransaction } from "./tx";
import type { FeatureVector, OutcomeKind, TriageContext } from "./types";

export interface AssignInput {
  assigneeUserId: number;
  emailId: number;
  /** Who the screen believed had the email (null: nobody). A different answer now is a conflict. */
  expectedAssigneeUserId: number | null;
  note: string | null;
}

export interface AssignActor {
  ledger: LedgerActor;
  name: string;
  oid: string;
}

export type AssignResult =
  | { ok: true; value: { assigneeName: string; assigneeUserId: number; emailId: number; outcome: OutcomeKind | "unchanged"; previousUserId: number | null } }
  | { error: string; ok: false; status: 400 | 404 | 409 };

const EMAIL_SQL = `SELECT EmailID, AssignedToUserId, Mailbox, IsTest, Status, MatchedJobID FROM dbo.Emails WHERE EmailID = @Id`;
const USER_SQL = `SELECT UserID, DisplayName, Role FROM dbo.AppUsers WHERE UserID = @Id AND IsActive = 1`;
const ASSIGN_SQL = `UPDATE dbo.Emails
     SET AssignedToUserId = @UserId, AssignedAt = SYSUTCDATETIME(), AssignedBy = @AssignedBy, AssignmentReason = @Reason
   OUTPUT INSERTED.EmailID
   WHERE EmailID = @EmailId AND (AssignedToUserId = @Expected OR (AssignedToUserId IS NULL AND @Expected IS NULL))`;

const CLOSED = new Set(["archived", "promoted", "ignored"]);
const fail = (status: 400 | 404 | 409, error: string): AssignResult => ({ error, ok: false, status });

/** A set for an email triage never saw, so the choice still has something to be logged against. */
function manualContext(emailId: number, mailbox: string | null, today: string): TriageContext {
  return {
    buildingId: null, buildingName: null, category: null, contractorId: null, emailId, intent: "other", lane: "both",
    linkedSend: null, mailbox, matchedJobId: null, replyVerified: false, senderKind: "unknown", senderVerified: false, tenancyId: null, tenancyName: null, today, urgency: null,
  };
}

/** Features for someone who was not among the ranked, computed as the ranker would have; null when they cannot be. */
async function captureFeatures(connection: Connection, set: StoredSet, person: { name: string; role: string; userId: number }, now: Date): Promise<FeatureVector | null> {
  if (!set.context || set.featureSchemaVersion !== FEATURE_SCHEMA_VERSION) return null;
  try {
    const jobs = await loadAssignedJobs(connection, [person.userId], new Date(now.getTime() - JOB_WINDOW_DAYS * 86_400_000));
    const named = set.context.matchedJobId ? await loadJob(connection, set.context.matchedJobId) : null;
    return buildVectors([person], jobs, set.context, { activity: null, namedJobAssignee: named?.assignedToUserId ?? null, now }).get(person.userId) ?? null;
  } catch {
    return null;
  }
}

export async function assignEmail(connection: Connection, input: AssignInput, actor: AssignActor, now: Date = new Date()): Promise<AssignResult> {
  const [email] = await executeQuery(connection, EMAIL_SQL, [{ name: "Id", type: TYPES.Int, value: input.emailId }]);
  if (!email) return fail(404, "Email not found");
  if (CLOSED.has(String(email.Status))) return fail(409, "This email has already been dealt with.");

  const [person] = await executeQuery(connection, USER_SQL, [{ name: "Id", type: TYPES.Int, value: input.assigneeUserId }]);
  if (!person || !(STAFF_ROLES as readonly string[]).includes(String(person.Role))) return fail(400, "That person cannot be given Incoming email.");

  const previous = email.AssignedToUserId === null || email.AssignedToUserId === undefined ? null : Number(email.AssignedToUserId);
  const staleMessage = "Someone else has changed who has this email. Refresh and try again.";
  if (previous !== input.expectedAssigneeUserId) return fail(409, staleMessage);
  const assignee = { name: String(person.DisplayName), role: String(person.Role), userId: Number(person.UserID) };
  if (previous === assignee.userId) {
    return { ok: true, value: { assigneeName: assignee.name, assigneeUserId: assignee.userId, emailId: input.emailId, outcome: "unchanged", previousUserId: previous } };
  }
  const today = todayInDarwin(now);
  if ((await loadOnLeave(connection, today)).has(assignee.userId)) return fail(409, `${assignee.name} is on leave today. Choose someone else.`);

  const mailbox = (email.Mailbox as string | null) ?? null;
  const latest = await readLatestSet(connection, input.emailId);
  const set = latest ?? { context: manualContext(input.emailId, mailbox, today), decision: "manual" as const, featureSchemaVersion: FEATURE_SCHEMA_VERSION, isTest: email.IsTest === true || email.IsTest === 1, items: [], setId: 0 };
  const item = set.items.find((candidate) => candidate.userId === assignee.userId);
  const outcome: OutcomeKind = previous !== null ? "reassigned" : item ? "accepted" : "chose_other";
  const chosenFeatures = item ? null : await captureFeatures(connection, set, assignee, now);
  const reasons = [`Assigned by ${actor.name}`, ...(item?.reasons.map((reason) => reason.text) ?? []), ...(input.note ? [`Note: ${input.note}`] : [])];

  const done = await withTransaction(connection, async () => {
    const rows = await executeQuery(connection, ASSIGN_SQL, [
      { name: "EmailId", type: TYPES.Int, value: input.emailId },
      { name: "UserId", type: TYPES.Int, value: assignee.userId },
      { name: "AssignedBy", type: TYPES.NVarChar, value: actor.name.slice(0, 160) },
      { name: "Reason", type: TYPES.NVarChar, value: reasons.join("\n").slice(0, 1000) },
      { name: "Expected", type: TYPES.Int, value: previous },
    ]);
    if (rows.length === 0) return null;
    const setId = latest
      ? latest.setId
      : await insertSet(connection, { actorName: actor.name, candidateCount: 0, category: null, context: set.context as TriageContext, decision: "manual", featureSchemaVersion: FEATURE_SCHEMA_VERSION, intent: "other", isTest: set.isTest, lane: "both", rankerVersion: "manual@1", urgency: null, workSource: "rules" }, []);
    await insertOutcome(connection, { actorName: actor.name, actorOid: actor.oid, chosenFeatures, chosenRank: item?.rank ?? null, chosenUserId: assignee.userId, emailId: input.emailId, outcome, previousUserId: previous, setId });
    await record(connection, {
      action: previous === null ? "email.assign" : "email.reassign",
      actor: actor.ledger,
      after: { assignedToUserId: assignee.userId, assignedTo: assignee.name },
      before: { assignedToUserId: previous },
      jobId: email.MatchedJobID === null || email.MatchedJobID === undefined ? null : Number(email.MatchedJobID),
      reason: input.note,
      ruleApplied: outcome,
      subject: { id: input.emailId, type: "email" },
    });
    return true;
  });
  if (!done) return fail(409, staleMessage);
  return { ok: true, value: { assigneeName: assignee.name, assigneeUserId: assignee.userId, emailId: input.emailId, outcome, previousUserId: previous } };
}
