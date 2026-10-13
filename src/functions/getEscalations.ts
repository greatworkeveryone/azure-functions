// GET /api/getEscalations   (the escalation inbox, PLAN §3.7)
//
//   view     mine (default) | raised | team | all | visible
//              mine     aimed at me: named for me, or at my role and not yet named for anyone else
//              raised   I raised them
//              team     what my team's roles are on the hook for or raised (managers, CFO)
//              all      everything (directors, admin)
//              visible  everything I may see; the default when a subject is given
//   status   active (default: open + acknowledged) | open (not yet acknowledged) | closed | all
//   subjectType, subjectId   one subject's escalations (the banner on a job)
//   policyKey                one policy by its exact key (job.manual), or a whole domain
//                            by a prefix ending in "." (finance.), as getDecisions does
//                            for action
//   kind (attention | authority), urgent (true | false)
//   page, pageSize           see ../pagination
//
// 200 { items: EscalationDto[], total, page, pageSize }; `total` is the count for
// the view and filters, so the top-bar badge is view=mine&pageSize=1.
//
// Gate: ESCALATION_ROLES (frontend capability viewEscalations); view=team needs
// TEAM_ESCALATION_ROLES (viewTeamEscalations); view=all needs ALL_ESCALATION_ROLES
// (viewAllEscalations). Visibility within the view is §3.7: the targets, the
// raiser and every role above the target.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { closeConnection, createRequestConnection } from "../db";
import { extractToken, requireRole, unauthorizedResponse } from "../auth";
import { toDto } from "../escalation/dto";
import { getAdapter } from "../escalation/adapters/registry";
import "../escalation/adapters";
import { EscalationError } from "../escalation/errors";
import {
  ALL_ESCALATION_ROLES,
  ESCALATION_ROLES,
  escalationErrorResponse,
  resolveCaller,
  TEAM_ESCALATION_ROLES,
  type Caller,
} from "../escalation/http";
import { listActiveUsers, listEscalations, type ListFilter, type ListStatus, type ListView } from "../escalation/store";
import { parsePagination } from "../pagination";
import type { DirectoryUser, EscalationKind } from "../escalation/types";

const VIEWS: readonly string[] = ["mine", "raised", "team", "all", "visible"];
const STATUSES: readonly string[] = ["active", "open", "closed", "all"];
const MAX_POLICY_KEY_CHARS = 64;
// A policy key is a domain and a rule in lower case (job.past_due); a prefix is
// the same up to a dot. Only prefixes are checked for shape: they go into a LIKE.
const POLICY_KEY_PREFIX = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*\.$/;

function readFilter(request: HttpRequest, caller: Caller): ListFilter {
  const q = request.query;
  const subjectType = q.get("subjectType")?.trim() || undefined;
  const subjectId = q.get("subjectId")?.trim() || undefined;
  if (subjectId && !subjectType) throw new EscalationError("bad_request", "subjectId needs a subjectType");
  if ((subjectType && subjectType.length > 32) || (subjectId && subjectId.length > 64)) {
    throw new EscalationError("bad_request", "subjectType or subjectId is too long");
  }

  const view = q.get("view")?.trim() || (subjectType ? "visible" : "mine");
  if (!VIEWS.includes(view)) throw new EscalationError("bad_request", `view must be one of ${VIEWS.join(", ")}`);
  const status = q.get("status")?.trim() || "active";
  if (!STATUSES.includes(status)) throw new EscalationError("bad_request", `status must be one of ${STATUSES.join(", ")}`);

  const kindText = q.get("kind")?.trim() || undefined;
  if (kindText !== undefined && kindText !== "attention" && kindText !== "authority") {
    throw new EscalationError("bad_request", "kind must be attention or authority");
  }
  const kind: EscalationKind | undefined = kindText;
  const urgentText = q.get("urgent")?.trim().toLowerCase();
  if (urgentText && !["true", "false", "1", "0"].includes(urgentText)) {
    throw new EscalationError("bad_request", "urgent must be true or false");
  }
  const policyText = q.get("policyKey")?.trim() || undefined;
  if (policyText && policyText.length > MAX_POLICY_KEY_CHARS) throw new EscalationError("bad_request", "policyKey is too long");
  // A trailing "." asks for every policy in a domain, e.g. finance.
  const policyKeyPrefix = policyText?.endsWith(".") ? policyText : undefined;
  if (policyKeyPrefix !== undefined && !POLICY_KEY_PREFIX.test(policyKeyPrefix)) {
    throw new EscalationError("bad_request", "policyKey must be a policy key, or a prefix ending in '.'");
  }

  return {
    kind,
    policyKey: policyKeyPrefix === undefined ? policyText : undefined,
    policyKeyPrefix,
    status: status as ListStatus,
    subjectId,
    subjectType,
    urgent: urgentText ? urgentText === "true" || urgentText === "1" : undefined,
    view: view as ListView,
    viewer: caller.viewer,
  };
}

export async function getEscalations(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const roleCheck = await requireRole(request, ESCALATION_ROLES);
  if (roleCheck) return roleCheck;

  let connection;
  let caller: Caller | null = null;
  let directory: DirectoryUser[] = [];
  try {
    connection = await createRequestConnection(token);
    caller = await resolveCaller(request, connection);
    if (!caller) return unauthorizedResponse();

    const filter = readFilter(request, caller);
    if (filter.view === "team") {
      const denied = await requireRole(request, TEAM_ESCALATION_ROLES);
      if (denied) return denied;
    }
    if (filter.view === "all") {
      const denied = await requireRole(request, ALL_ESCALATION_ROLES);
      if (denied) return denied;
    }

    const pagination = parsePagination(request.query);
    const { rows, total } = await listEscalations(connection, filter, pagination);
    directory = await listActiveUsers(connection);

    const now = new Date();
    const items = rows
      // A subject's own rule can narrow who sees its escalations further.
      .filter((row) => getAdapter(row.subjectType)?.visibleTo(caller!.viewer, row) ?? true)
      .map((row) => toDto(row, caller!.viewer, now, directory));
    return {
      status: 200,
      jsonBody: { items, page: pagination.page, pageSize: pagination.active ? pagination.pageSize : items.length, total },
    };
  } catch (error: unknown) {
    return escalationErrorResponse(error, context, "getEscalations", caller ?? undefined, directory);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("getEscalations", { methods: ["GET"], authLevel: "anonymous", handler: getEscalations });
