// POST /api/answerApprovalAttribution   (LAUNCH-READINESS R2, R13; PLAN §3.7)
//
// The manager named on an attributed quote approval, or on an amount accepted
// within the R13 margin, answers the notice they were sent.
//
// Body { kind: "quote" | "variance", id, agreed: boolean, reason? }
//   agreed true    "Yes, I agreed": the answer is stamped and the notice ends.
//   agreed false   "I didn't agree to this": a reason is required. In ONE
//                  transaction the answer is stamped, the ledger records
//                  quote.attribution_disputed / po.variance_disputed (an
//                  exception, the manager as actor), the notice ends and the
//                  *_disputed escalation is raised to facilities managers, then
//                  directors (never the disputer). Its targets are emailed after
//                  commit.
//
// 200 { answered: true, disputed }
// 400 malformed, or no reason given for a dispute
// 403 not_named_manager: only the person named may answer (ledgered, denied)
// 404 not found, or nobody was named on it
// 409 already_answered (ledgered, denied)

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { TYPES, type Connection } from "tedious";
import { AppRole, errorResponse, extractToken, requireRole, unauthorizedResponse } from "../auth";
import { beginTransaction, closeConnection, commitTransaction, createRequestConnection, executeQuery, rollbackTransaction } from "../db";
import "../escalation/adapters";
import {
  ATTRIBUTION_SUBJECT_TYPE,
  attributionSubjectId,
  disputedPolicy,
  loadAttribution,
  noticePolicy,
  type AttributionKind,
  type AttributionRecord,
} from "../escalation/adapters/approvalAttribution";
import { raiseWithin, resolveWithin, type RaiseWithinResult } from "../escalation/engine";
import { findLiveEscalation } from "../escalation/store";
import { record } from "../ledger";
import { resolveLedgerActor } from "../ledger/actor";
import type { LedgerActor } from "../ledger/types";
import { refuseMoneyChange } from "../moneyJob-db";

const REASON_MAX = 1000;
const ANSWER_ROLES = [AppRole.FACILITIES_APPROVAL, AppRole.ACCOUNTS, AppRole.ACCOUNTS_APPROVAL, AppRole.CFO, AppRole.DIRECTOR];

interface AnswerBody {
  agreed?: unknown;
  id?: unknown;
  kind?: unknown;
  reason?: unknown;
}

type Parsed = { agreed: boolean; id: number; kind: AttributionKind; reason: string | null };

function parse(body: AnswerBody): Parsed | string {
  if (body.kind !== "quote" && body.kind !== "variance") return 'kind must be "quote" or "variance"';
  if (typeof body.id !== "number" || !Number.isInteger(body.id) || body.id <= 0) return "id must be a positive whole number";
  if (typeof body.agreed !== "boolean") return "agreed must be true or false";
  if (body.reason !== undefined && body.reason !== null && (typeof body.reason !== "string" || body.reason.length > REASON_MAX)) {
    return `reason must be text of ${REASON_MAX} characters or fewer`;
  }
  const reason = typeof body.reason === "string" && body.reason.trim() ? body.reason.trim() : null;
  if (!body.agreed && !reason) return "Say why you didn't agree to it (a reason is required).";
  return { agreed: body.agreed, id: body.id, kind: body.kind, reason };
}

const disputeAction = (kind: AttributionKind): "po.variance_disputed" | "quote.attribution_disputed" =>
  kind === "quote" ? "quote.attribution_disputed" : "po.variance_disputed";

/** The money record the ledger row is about: the quote, or the PO or invoice the variance was on. */
const subjectOf = (found: AttributionRecord) => ({ id: found.subjectId, type: found.subjectType });

function moneyFacts(found: AttributionRecord): Record<string, unknown> {
  return { amount: found.amount, contractorId: found.contractorId, contractorName: found.contractorName };
}

async function stampAnswer(connection: Connection, found: AttributionRecord, disputed: boolean): Promise<void> {
  if (found.ref.kind === "quote") {
    await executeQuery(connection, "UPDATE Quotes SET AttributionAnsweredAt = SYSUTCDATETIME() WHERE QuoteID = @Id", [
      { name: "Id", type: TYPES.Int, value: found.ref.id },
    ]);
    return;
  }
  await executeQuery(connection, "UPDATE dbo.MoneyVariances SET AnsweredAt = SYSUTCDATETIME(), Disputed = @Disputed WHERE VarianceID = @Id", [
    { name: "Id", type: TYPES.Int, value: found.ref.id },
    { name: "Disputed", type: TYPES.Bit, value: disputed },
  ]);
}

async function addJobEvent(connection: Connection, found: AttributionRecord, by: string, text: string, eventType: string): Promise<void> {
  await executeQuery(
    connection,
    `INSERT INTO JobEvents (JobID, CreatedBy, [Text], EventType) VALUES (@JobID, @CreatedBy, @Text, @EventType);`,
    [
      { name: "JobID", type: TYPES.Int, value: found.jobId },
      { name: "CreatedBy", type: TYPES.NVarChar, value: by },
      { name: "Text", type: TYPES.NVarChar, value: text },
      { name: "EventType", type: TYPES.NVarChar, value: eventType },
    ],
  );
}

/** The answer, its job event, its ledger row and the escalations, on the open transaction. */
async function writeAnswer(connection: Connection, actor: LedgerActor, found: AttributionRecord, answer: Parsed): Promise<RaiseWithinResult | null> {
  const disputed = !answer.agreed;
  await stampAnswer(connection, found, disputed);
  await addJobEvent(
    connection,
    found,
    actor.name,
    disputed ? `${actor.name} didn't agree to ${found.label}: ${answer.reason}` : `${actor.name} confirmed they agreed to ${found.label}`,
    disputed ? "attribution_disputed" : "attribution_confirmed",
  );

  const subjectId = attributionSubjectId(found.ref);
  const notice = await findLiveEscalation(connection, ATTRIBUTION_SUBJECT_TYPE, subjectId, noticePolicy(found.ref.kind));
  if (notice) {
    await resolveWithin(connection, {
      actor,
      escalationId: notice.escalationId,
      note: answer.reason,
      resolutionCode: disputed ? "disputed" : "agreed",
    });
  }
  if (!disputed) return null;

  await record(connection, {
    action: disputeAction(found.ref.kind),
    actor,
    after: { ...moneyFacts(found), disputed: true },
    before: { contractorId: found.contractorId, contractorName: found.contractorName, approvedBy: found.byName },
    buildingId: found.buildingId,
    jobId: found.jobId,
    reason: answer.reason,
    ruleApplied: found.ref.kind === "quote" ? "attributed_approval_disputed" : "variance_disputed",
    subject: subjectOf(found),
  });
  return raiseWithin(connection, {
    actor,
    headline: `${actor.name} didn't agree to it`,
    note: answer.reason,
    policyKey: disputedPolicy(found.ref.kind),
    subjectId,
    subjectType: ATTRIBUTION_SUBJECT_TYPE,
  });
}

export async function answerApprovalAttribution(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  // Only someone who can approve on their own authority is ever named; the
  // handler then checks the caller IS the person named.
  const denied = await requireRole(request, ANSWER_ROLES);
  if (denied) return denied;

  let connection;
  try {
    const raw = await request.json().catch(() => null);
    const parsed = parse(typeof raw === "object" && raw !== null ? (raw as AnswerBody) : {});
    if (typeof parsed === "string") return { jsonBody: { error: parsed }, status: 400 };

    connection = await createRequestConnection(token);
    const actor = await resolveLedgerActor(request, connection);
    if (!actor || actor.kind !== "user") return unauthorizedResponse();

    await beginTransaction(connection);
    let raised: RaiseWithinResult | null;
    try {
      const found = await loadAttribution(connection, { id: parsed.id, kind: parsed.kind }, true);
      if (!found || found.attributedToUserId === null) {
        await rollbackTransaction(connection).catch(() => {});
        return { jsonBody: { error: "There is no attributed approval to answer here." }, status: 404 };
      }
      const refusal =
        actor.userId !== found.attributedToUserId
          ? { code: "not_named_manager", message: `Only ${found.attributedToName ?? "the manager named"} can answer this: they were named on it.`, status: 403 as const }
          : found.answeredAt !== null
            ? { code: "already_answered", message: "This has already been answered. Reload to see the answer.", status: 409 as const }
            : null;
      if (refusal) {
        return await refuseMoneyChange(connection, request, {
          attempted: disputeAction(found.ref.kind),
          jobId: found.jobId,
          refusal,
          state: { answeredAt: found.answeredAt ? found.answeredAt.toISOString() : null, attributionKind: found.ref.kind },
          subject: subjectOf(found),
        });
      }
      raised = await writeAnswer(connection, actor, found, parsed);
      await commitTransaction(connection);
    } catch (err) {
      await rollbackTransaction(connection).catch(() => {});
      throw err;
    }
    if (raised) await raised.announce();
    return { jsonBody: { answered: true, disputed: !parsed.agreed }, status: 200 };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    context.error("answerApprovalAttribution failed:", message);
    return errorResponse("Answer failed", message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("answerApprovalAttribution", { authLevel: "anonymous", handler: answerApprovalAttribution, methods: ["POST"] });
