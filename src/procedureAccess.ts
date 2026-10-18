// Who may do what with a procedure (beta sprint U4), on top of the role gates.
//
//   writing and asking     an editor (a manager, the CFO, a director, admin) works on the
//                          procedures written for their own team: reading and writing
//                          are decided by the same audience rule, procedureAudience.ts
//                          (director and admin see all). Least privilege: editing does
//                          not widen reading.
//   publishing             a director's act. requireRole lets admin through every gate,
//                          but an approval is a person's, so admin alone is refused
//                          (as for schedule sign-off, decision 4).

import type { HttpRequest, HttpResponseInit } from "@azure/functions";
import { type Connection, TYPES } from "tedious";
import { forbiddenResponse, requireRole, rolesForRequest, serviceUnavailableResponse } from "./auth";
import { executeQuery } from "./db";
import { splitAudience } from "./procedureLibrary";
import { PROCEDURE_APPROVER_ROLE } from "./procedureRoles";

/** The caller's roles, or null when they cannot be read (the caller then answers 503, writing nothing). */
export async function readCallerRoles(request: HttpRequest): Promise<string[] | null> {
  try {
    return await rolesForRequest(request);
  } catch {
    return null;
  }
}

export function outsideAudienceResponse(): HttpResponseInit {
  return { jsonBody: { error: "That procedure is written for another team." }, status: 403 };
}

/** The stored audience of a procedure, or null when there is no such procedure yet. */
export async function storedAudience(connection: Connection, slug: string): Promise<string[] | null> {
  const rows = await executeQuery(connection, "SELECT Audience FROM dbo.Procedures WHERE Slug = @Slug", [
    { name: "Slug", type: TYPES.NVarChar, value: slug },
  ]);
  return rows.length === 0 ? null : splitAudience(rows[0].Audience);
}

/**
 * The gate for publishing: a director, admin alone refused. Null when the caller may,
 * a 403 (or a 503 when roles cannot be read) when not.
 */
export async function requireProcedureApprover(request: HttpRequest): Promise<HttpResponseInit | null> {
  const denied = await requireRole(request, [PROCEDURE_APPROVER_ROLE]);
  if (denied) return denied;
  const roles = await readCallerRoles(request);
  if (roles === null) return serviceUnavailableResponse();
  if (roles.includes(PROCEDURE_APPROVER_ROLE)) return null;
  return forbiddenResponse("Only a director can publish a procedure. Admin alone cannot approve one.");
}
