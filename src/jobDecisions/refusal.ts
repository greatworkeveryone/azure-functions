// A refusal at the role gate of the endpoints that answer a decision request or finish
// its next step (jobs plan A2). Someone who is not asked is refused twice over: by the
// role gate when their role cannot even open the escalation inbox, and by the request
// or step itself when their role can but they are not one of the people it is for
// (respondService / completeService). Both are written to the ledger as `denied`, so
// the first has to find the job from the request or decision in the body, because the
// body is all there is before a connection is open. Never throws.

import type { HttpRequest, HttpResponseInit } from "@azure/functions";
import type { Connection } from "tedious";
import { closeConnection, createRequestConnection } from "../db";
import { resolveLedgerActor } from "../ledger/actor";
import { recordRefusal } from "../ledger/refusals";
import { getDecisionRow } from "./decisionsStore";
import { isOutcome } from "./respond";
import { getRequestRow } from "./store";

const positiveInt = (value: unknown): number | null => {
  const id = typeof value === "string" && /^\d{1,10}$/.test(value) ? Number(value) : value;
  return typeof id === "number" && Number.isSafeInteger(id) && id >= 1 && id <= 2_147_483_647 ? id : null;
};

/**
 * The role gate said no. Records the refusal against the job the request (or decision)
 * in the body belongs to, and leaves `denied` for the handler to return, so the
 * response is untouched. A 503 (roles could not be checked) is not a refusal and
 * records nothing, and neither does a body that names nothing real.
 */
export async function recordRoleDenial(
  request: HttpRequest,
  token: string,
  denied: HttpResponseInit,
  target: "respond" | "complete",
): Promise<void> {
  if (denied.status !== 403) return;
  const details = (denied.jsonBody as { details?: unknown } | undefined)?.details;
  const message = typeof details === "string" ? details : "Your role can't do this.";
  let connection: Connection | undefined;
  try {
    const raw = await request.json().catch(() => null);
    const body: Record<string, unknown> = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};

    let jobId: number | null = null;
    let attempted: "decision.approve" | "decision.defer" | "decision.deny" | "decision.next_step_done" | "decision.revise";
    connection = await createRequestConnection(token);
    if (target === "respond") {
      const requestId = positiveInt(body.requestId);
      if (requestId === null || !isOutcome(body.outcome)) return;
      jobId = (await getRequestRow(connection, requestId))?.jobId ?? null;
      attempted = `decision.${body.outcome}` as const;
    } else {
      const decisionId = positiveInt(body.decisionId);
      if (decisionId === null) return;
      jobId = (await getDecisionRow(connection, decisionId))?.jobId ?? null;
      attempted = "decision.next_step_done";
    }
    if (jobId === null) return;

    const actor = await resolveLedgerActor(request, connection);
    if (!actor) return;
    await recordRefusal(connection, actor, { id: jobId, type: "job" }, { attempted, code: "role_not_permitted", message }, jobId);
  } catch {
    // A refusal is not a decision: nothing here may change the answer the caller gets.
  } finally {
    if (connection) closeConnection(connection);
  }
}
