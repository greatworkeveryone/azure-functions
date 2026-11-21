// SECA-02 / D5: the second half of a two-person grant of director, cfo or admin (see ../roleGrants.ts).
// requestRoleGrant is called by upsertAppUser inside its transaction; decideRoleGrant confirms,
// declines or withdraws a pending request. Both steps are ledgered.

import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from "@azure/functions";
import { TYPES, type Connection } from "tedious";
import {
  AppRole,
  errorResponse,
  extractToken,
  requireRole,
  rolesForRequest,
  unauthorizedResponse,
  verifiedIdentityFromRequest,
} from "../auth";
import { beginTransaction, closeConnection, commitTransaction, createServiceRequestConnection, executeQuery, rollbackTransaction } from "../db";
import { errorMessage } from "../errorMessage";
import { record } from "../ledger";
import { ledgerUserActor } from "../ledger/actor";
import type { LedgerActor } from "../ledger/types";
import { grantDecisionRefusal, type GrantDecision } from "../roleGrants";

const DECISIONS = new Set<string>(["confirm", "decline", "withdraw"]);

/** Records a pending grant for a person, replacing any earlier pending request for them. Caller owns the transaction. */
export async function requestRoleGrant(
  connection: Connection,
  input: { actor: LedgerActor; callerName: string; callerOid: string; previousRole: string | null; requestedRole: string; targetUserId: number },
): Promise<number> {
  await executeQuery(
    connection,
    `UPDATE dbo.PendingRoleGrants SET Status = N'superseded', DecidedAt = SYSUTCDATETIME() WHERE TargetUserID = @UserID AND Status = N'pending'`,
    [{ name: "UserID", type: TYPES.Int, value: input.targetUserId }],
  );
  const inserted = await executeQuery(
    connection,
    `INSERT INTO dbo.PendingRoleGrants (TargetUserID, RequestedRole, PreviousRole, RequestedByOid, RequestedByName)
     OUTPUT INSERTED.GrantID
     VALUES (@UserID, @Role, @Previous, @Oid, @Name)`,
    [
      { name: "UserID", type: TYPES.Int, value: input.targetUserId },
      { name: "Role", type: TYPES.NVarChar, value: input.requestedRole },
      { name: "Previous", type: TYPES.NVarChar, value: input.previousRole },
      { name: "Oid", type: TYPES.NVarChar, value: input.callerOid },
      { name: "Name", type: TYPES.NVarChar, value: input.callerName },
    ],
  );
  await record(connection, {
    action: "user.role_grant_requested",
    actor: input.actor,
    after: { requestedRole: input.requestedRole, status: "pending" },
    before: { role: input.previousRole },
    subject: { id: input.targetUserId, type: "app_user" },
  });
  return Number(inserted[0]?.GrantID);
}

// ── POST /api/decideRoleGrant ────────────────────────────────────────────────
// Body: { grantId, decision: "confirm" | "decline" | "withdraw" }

export async function decideRoleGrant(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  // Director or admin; admin alone reaches upsertAppUser, but the second person may be a director.
  const denied = await requireRole(request, [AppRole.ADMIN, AppRole.DIRECTOR]);
  if (denied) return denied;
  const identity = await verifiedIdentityFromRequest(request);
  if (!identity) return unauthorizedResponse();
  const roles = await rolesForRequest(request);

  let connection;
  try {
    const body = (await request.json()) as { decision?: unknown; grantId?: unknown };
    if (typeof body?.grantId !== "number" || typeof body.decision !== "string" || !DECISIONS.has(body.decision)) {
      return { status: 400, jsonBody: { error: "grantId (number) and decision (confirm, decline or withdraw) required" } };
    }
    const decision = body.decision as GrantDecision;
    connection = await createServiceRequestConnection();

    const caller = await executeQuery(connection, "SELECT UserID, DisplayName FROM dbo.AppUsers WHERE EntraOid = @Oid", [
      { name: "Oid", type: TYPES.NVarChar, value: identity.oid },
    ]);
    const callerName = (caller[0]?.DisplayName as string | undefined) ?? identity.name ?? "Unknown";
    const actor = ledgerUserActor({ name: identity.name || callerName, roles, userId: (caller[0]?.UserID as number | undefined) ?? null });

    await beginTransaction(connection);
    try {
      const rows = await executeQuery(
        connection,
        `SELECT g.GrantID, g.TargetUserID, g.RequestedRole, g.PreviousRole, g.RequestedByOid, g.Status, u.EntraOid AS TargetOid, u.Role AS CurrentRole, u.Email AS TargetEmail
           FROM dbo.PendingRoleGrants g WITH (UPDLOCK, HOLDLOCK)
           INNER JOIN dbo.AppUsers u ON u.UserID = g.TargetUserID
          WHERE g.GrantID = @GrantID`,
        [{ name: "GrantID", type: TYPES.Int, value: body.grantId }],
      );
      const grant = rows[0];
      if (!grant) {
        await rollbackTransaction(connection).catch(() => {});
        return { status: 404, jsonBody: { error: "That request wasn't found." } };
      }
      if (grant.Status !== "pending") {
        await rollbackTransaction(connection).catch(() => {});
        return { status: 409, jsonBody: { error: "That request has already been dealt with." } };
      }
      const refusal = grantDecisionRefusal(decision, identity.oid, roles, {
        requestedByOid: grant.RequestedByOid as string,
        targetOid: (grant.TargetOid as string | null) ?? null,
      });
      if (refusal) {
        await rollbackTransaction(connection).catch(() => {});
        return { status: 403, jsonBody: { code: "role_grant_not_permitted", error: refusal } };
      }

      const status = decision === "confirm" ? "confirmed" : decision === "decline" ? "declined" : "withdrawn";
      const targetUserId = grant.TargetUserID as number;
      const requestedRole = grant.RequestedRole as string;
      await executeQuery(
        connection,
        `UPDATE dbo.PendingRoleGrants SET Status = @Status, DecidedByOid = @Oid, DecidedByName = @Name, DecidedAt = SYSUTCDATETIME() WHERE GrantID = @GrantID`,
        [
          { name: "Status", type: TYPES.NVarChar, value: status },
          { name: "Oid", type: TYPES.NVarChar, value: identity.oid },
          { name: "Name", type: TYPES.NVarChar, value: callerName },
          { name: "GrantID", type: TYPES.Int, value: body.grantId },
        ],
      );
      if (decision === "confirm") {
        const before = (grant.CurrentRole as string | null) ?? null;
        await executeQuery(connection, "UPDATE dbo.AppUsers SET Role = @Role WHERE UserID = @UserID", [
          { name: "Role", type: TYPES.NVarChar, value: requestedRole },
          { name: "UserID", type: TYPES.Int, value: targetUserId },
        ]);
        await executeQuery(
          connection,
          `INSERT INTO dbo.UserRoleAudit (ChangedByOid, ChangedByDisplayName, TargetUserID, TargetEmail, OldRole, NewRole)
           VALUES (@ChangedByOid, @ChangedByDisplayName, @TargetUserID, @TargetEmail, @OldRole, @NewRole)`,
          [
            { name: "ChangedByOid", type: TYPES.NVarChar, value: identity.oid },
            { name: "ChangedByDisplayName", type: TYPES.NVarChar, value: callerName },
            { name: "TargetUserID", type: TYPES.Int, value: targetUserId },
            { name: "TargetEmail", type: TYPES.NVarChar, value: (grant.TargetEmail as string | null) ?? "" },
            { name: "OldRole", type: TYPES.NVarChar, value: before },
            { name: "NewRole", type: TYPES.NVarChar, value: requestedRole },
          ],
        );
        await record(connection, {
          action: "user.role_change",
          actor,
          after: { role: requestedRole },
          before: { role: before },
          subject: { id: targetUserId, type: "app_user" },
        });
      }
      await record(connection, {
        action: `user.role_grant_${status}` as "user.role_grant_confirmed",
        actor,
        after: { requestedRole, status },
        before: { role: (grant.CurrentRole as string | null) ?? null, status: "pending" },
        subject: { id: targetUserId, type: "app_user" },
      });
      await commitTransaction(connection);
      return { status: 200, jsonBody: { grantId: body.grantId, status } };
    } catch (err) {
      await rollbackTransaction(connection).catch(() => {});
      throw err;
    }
  } catch (error: unknown) {
    const message = errorMessage(error);
    context.error("decideRoleGrant failed:", message);
    return errorResponse("Failed to decide the role request", message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("decideRoleGrant", { authLevel: "anonymous", handler: decideRoleGrant, methods: ["POST"] });
