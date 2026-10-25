// GET /api/previewEscalationTarget?subjectType=job&subjectId=123[&targetUserId=7]
//
// Who a manual escalation raised by the caller would go to, before they send it
// (the escalate dialog: "Goes to: Facilities manager (Adam)"). Writes nothing.
//
// 200 {
//   policyKey, level, urgent, slaHours,
//   targetRole, targetRoleLabel,
//   targets: [{ userId, name }],      // the people at that level
//   targetUserId,                     // set when targetUserId was passed and valid
//   noIndependentTarget,              // true: nobody independent of the caller; goes to the directors
//   goesTo,                           // "Facilities manager (Adam)"
//   label                             // "Goes to: Facilities manager (Adam)", as the dialog shows it
// }
// 404 when the subject doesn't exist or the caller can't see it; 422 when
// targetUserId isn't someone at that level.
//
// Gate: ESCALATION_ROLES (frontend capability raiseEscalation).

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { closeConnection, createRequestConnection } from "../db";
import { extractToken, requireRole, unauthorizedResponse } from "../auth";
import "../escalation/adapters";
import { requireAdapter } from "../escalation/adapters/registry";
import { previewTarget } from "../escalation/engine";
import { EscalationError } from "../escalation/errors";
import { describeTarget } from "../escalation/ladder";
import { manualPolicyKey } from "../escalation/manual";
import { ESCALATION_ROLES, escalationErrorResponse, readOptionalUserId, resolveCaller, type Caller } from "../escalation/http";
import { roleLabel } from "../escalation/roles";

export async function previewEscalationTarget(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const roleCheck = await requireRole(request, ESCALATION_ROLES);
  if (roleCheck) return roleCheck;

  let connection;
  let caller: Caller | null = null;
  try {
    const subjectType = request.query.get("subjectType")?.trim() ?? "";
    const subjectId = request.query.get("subjectId")?.trim() ?? "";
    if (!subjectType || subjectType.length > 32 || !subjectId || subjectId.length > 64) {
      throw new EscalationError("bad_request", "subjectType and subjectId are required");
    }
    const preferredUserId = readOptionalUserId(request.query.get("targetUserId"), "targetUserId");

    connection = await createRequestConnection(token);
    caller = await resolveCaller(request, connection);
    if (!caller) return unauthorizedResponse();

    const adapter = requireAdapter(subjectType);
    const policyKey = await manualPolicyKey(connection, subjectType);
    if (!adapter.visibleTo(caller.viewer, { policyKey, subjectId, subjectType }) || !(await adapter.loadSummary(connection, subjectId))) {
      throw new EscalationError("subject_not_found", "That can't be found, or you can't escalate it");
    }

    const { policy, target } = await previewTarget(connection, { actor: caller.actor, policyKey, preferredUserId });
    return {
      status: 200,
      jsonBody: {
        goesTo: describeTarget(target),
        label: `Goes to: ${describeTarget(target)}`,
        level: target.level,
        noIndependentTarget: target.noIndependentTarget,
        policyKey: policy.policyKey,
        slaHours: target.slaHours,
        targetRole: target.role,
        targetRoleLabel: roleLabel(target.role),
        targetUserId: target.targetUserId,
        targets: target.users.map((user) => ({ name: user.name, userId: user.userId })),
        urgent: policy.urgent,
      },
    };
  } catch (error: unknown) {
    return escalationErrorResponse(error, context, "previewEscalationTarget", caller ?? undefined);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("previewEscalationTarget", { methods: ["GET"], authLevel: "anonymous", handler: previewEscalationTarget });
