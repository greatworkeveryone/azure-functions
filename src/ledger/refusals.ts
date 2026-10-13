import type { HttpRequest, HttpResponseInit } from "@azure/functions";
import { TYPES, type Connection } from "tedious";
import {
  beginTransaction,
  closeConnection,
  commitTransaction,
  createRequestConnection,
  executeQuery,
  rollbackTransaction,
} from "../db";
import { checkRateLimit } from "../rateLimit";
import { Sentry } from "../sentry";
import type { LedgerAction } from "./actions";
import { resolveLedgerActor } from "./actor";
import { record } from "./index";
import { jobScope, ledgerReason, type LedgerScope } from "./moneyDecisions";
import type { LedgerActor } from "./types";

// Refused attempts (WP19b): when an approval endpoint turns a decision down,
// one `denied` row (or `sod_blocked` for self-approval) lands in the ledger so
// the CFO can see the attempt. Deliberately not re-exported from ./index, for
// the same reason as ./actor.
//
// A refusal is not a decision, so these writes never get in the way of the
// answer the caller was going to get: they run in their own small transaction,
// after the decision's own transaction has rolled back, and a failure is
// logged and swallowed. The response is exactly what it was before.

export type RefusalSubjectType = "invoice" | "job" | "payment" | "purchase_order" | "quote";

export interface RefusalSubject {
  id: number;
  type: RefusalSubjectType;
}

export interface Refusal {
  /** `denied` unless the refusal is a self-approval block. */
  action?: "denied" | "sod_blocked";
  /** The decision that was refused, e.g. "quote.director_approve". */
  attempted: LedgerAction;
  /** Short reason code, stored as the row's rule: "role_not_permitted". */
  code: string;
  /** The sentence the caller was shown, stored as the row's reason. */
  message?: string | null;
  /** How the record stood when it was refused. */
  state?: Record<string, unknown>;
}

// Refused attempts are written to a table that can never be emptied, so one
// person hammering a refused endpoint must not fill it. Per instance, like the
// limiter itself; a person making real mistakes never gets near this.
const REFUSALS_PER_MINUTE = 20;

const SUBJECT_SCOPE_SQL: Record<RefusalSubjectType, string> = {
  invoice:
    "SELECT j.JobID, j.BuildingID FROM JobInvoices s INNER JOIN Jobs j ON j.JobID = s.JobID WHERE s.JobInvoiceID = @Id",
  job: "SELECT JobID, BuildingID FROM Jobs WHERE JobID = @Id",
  payment:
    "SELECT j.JobID, j.BuildingID FROM Payments s INNER JOIN Jobs j ON j.JobID = s.JobID WHERE s.PaymentID = @Id",
  purchase_order:
    "SELECT j.JobID, j.BuildingID FROM PurchaseOrders s INNER JOIN Jobs j ON j.JobID = s.JobID WHERE s.PurchaseOrderID = @Id",
  quote: "SELECT j.JobID, j.BuildingID FROM Quotes s INNER JOIN Jobs j ON j.JobID = s.JobID WHERE s.QuoteID = @Id",
};

/** The job and building a subject belongs to, or null when there is no such
 *  record: a refused attempt on something that doesn't exist isn't worth a row. */
async function subjectScope(connection: Connection, subject: RefusalSubject): Promise<LedgerScope | null> {
  const rows = await executeQuery(connection, SUBJECT_SCOPE_SQL[subject.type], [
    { name: "Id", type: TYPES.Int, value: subject.id },
  ]);
  if (rows.length === 0) return null;
  return {
    buildingId: (rows[0].BuildingID as number | null | undefined) ?? null,
    jobId: (rows[0].JobID as number | null | undefined) ?? null,
  };
}

function report(attempted: string, subject: string, err: unknown): void {
  console.error(`[ledger] could not record a refused ${attempted} on ${subject}:`, err instanceof Error ? err.message : err);
  Sentry.captureException(err, { extra: { attempted, subject }, tags: { area: "ledger-refusal" } });
}

/**
 * Writes one refusal row on `connection`, in a transaction of its own. Call it
 * after the decision's transaction has rolled back (or before one has begun).
 * Never throws.
 *
 * `jobId` is the job the record belongs to when the handler already loaded it
 * (null for none); leave it out to have the job found from the subject.
 */
export async function recordRefusal(
  connection: Connection,
  actor: LedgerActor,
  subject: RefusalSubject,
  refusal: Refusal,
  jobId?: number | null,
): Promise<void> {
  try {
    // An account with no role yet has no authority to be refused, and the
    // ledger can't name it: nothing to record.
    if (actor.kind === "user" && !actor.role.trim()) return;
    const who = actor.kind === "user" ? (actor.userId ?? actor.name) : actor.name;
    if (!checkRateLimit(`ledger-refusal:${who}`, { limit: REFUSALS_PER_MINUTE }).allowed) {
      console.warn(`[ledger] refusal rows for ${who} are rate limited; not recording this ${refusal.attempted}`);
      return;
    }
    const scope = jobId !== undefined ? await jobScope(connection, jobId) : await subjectScope(connection, subject);
    if (!scope) return;

    await beginTransaction(connection);
    try {
      await record(connection, {
        action: refusal.action ?? "denied",
        actor,
        before: { attempted: refusal.attempted, ...refusal.state },
        buildingId: scope.buildingId,
        jobId: scope.jobId,
        reason: ledgerReason(refusal.message),
        ruleApplied: refusal.code,
        subject,
      });
      await commitTransaction(connection);
    } catch (err) {
      await rollbackTransaction(connection).catch(() => {});
      throw err;
    }
  } catch (err) {
    report(refusal.attempted, `${subject.type} ${subject.id}`, err);
  }
}

export interface RefusalTarget {
  /** The decision that was refused; a function of the body when the endpoint
   *  takes more than one kind (an email reply approves or rejects), returning
   *  null when this request isn't a ledgered decision (an edit, say). */
  attempted: LedgerAction | ((body: Record<string, unknown>) => LedgerAction | null);
  /** The request body field holding the subject's id, e.g. "QuoteID". */
  idField: string;
  subjectType: RefusalSubjectType;
}

/**
 * For a refusal that happens before the handler has a connection or has read
 * its body (the role gate, the director-only check): finds the subject from the
 * request body and records the refusal. Does nothing when the body names no
 * existing record. Never throws.
 */
export async function recordRefusalForRequest(
  request: HttpRequest,
  token: string,
  target: RefusalTarget,
  refusal: Omit<Refusal, "attempted">,
): Promise<void> {
  let connection: Connection | undefined;
  try {
    const raw = await request.json().catch(() => null);
    const body: Record<string, unknown> = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
    const id = body[target.idField];
    if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) return;
    const attempted = typeof target.attempted === "function" ? target.attempted(body) : target.attempted;
    if (attempted === null) return;

    connection = await createRequestConnection(token);
    const actor = await resolveLedgerActor(request, connection);
    if (!actor) return;
    await recordRefusal(connection, actor, { id, type: target.subjectType }, { ...refusal, attempted });
  } catch (err) {
    report(typeof target.attempted === "function" ? "decision" : target.attempted, target.subjectType, err);
  } finally {
    if (connection) closeConnection(connection);
  }
}

/**
 * The role gate said no. Records the refusal and leaves `denied` for the
 * handler to return, so the response is untouched. A 503 (roles could not be
 * checked) is not a refusal and records nothing.
 */
export async function recordRoleRefusal(
  request: HttpRequest,
  token: string,
  denied: HttpResponseInit,
  target: RefusalTarget,
): Promise<void> {
  if (denied.status !== 403) return;
  const details = (denied.jsonBody as { details?: unknown } | undefined)?.details;
  await recordRefusalForRequest(request, token, target, {
    code: "role_not_permitted",
    message: typeof details === "string" ? details : "Your role can't make this decision",
  });
}
