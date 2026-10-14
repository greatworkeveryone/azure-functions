// src/functions/approval-limits.ts
//
// Admin-only endpoint to upsert a row in dbo.ApprovalLimits. Idempotent.
// The Roles admin page calls this when an admin edits a per-role limit.
//
// Changing a limit is a decision (PLAN §3.12): the new value and its ledger row
// commit together or not at all. Re-saving the value a role already has changes
// nothing and writes no ledger row.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { TYPES } from "tedious";
import {
  beginTransaction,
  closeConnection,
  commitTransaction,
  createRequestConnection,
  executeQuery,
  rollbackTransaction,
} from "../db";
import { invalidateApprovalLimitsCache } from "../approval-limits-db";
import { AppRole, extractToken, unauthorizedResponse, errorResponse, rolesForRequest } from "../auth";
import { LedgerValidationError, record } from "../ledger";
import { resolveLedgerActor } from "../ledger/actor";
import { requireMoneyContext } from "../moneyGate";

interface SetApprovalLimitBody {
  RoleName: string;
  /** null = unlimited authority. Numeric values must be >= 0. */
  MaxApprovalAmount: number | null;
}

export async function setApprovalLimit(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const userRoles = await rolesForRequest(request);
  if (!userRoles.includes(AppRole.ADMIN)) {
    return { status: 403, jsonBody: { error: "Admin role required" } };
  }
  // Money action (S11): allowed network, fresh sign-in, MFA. src/money-gated-routes.ts
  const gate = await requireMoneyContext(request);
  if (gate) return gate;

  let connection;
  try {
    const body = (await request.json()) as SetApprovalLimitBody;
    const { RoleName, MaxApprovalAmount } = body ?? {};
    if (typeof RoleName !== "string" || !RoleName.trim()) {
      return { status: 400, jsonBody: { error: "RoleName (non-empty string) required" } };
    }
    if (MaxApprovalAmount !== null && (typeof MaxApprovalAmount !== "number" || MaxApprovalAmount < 0)) {
      return { status: 400, jsonBody: { error: "MaxApprovalAmount must be null or a non-negative number" } };
    }
    // The column is DECIMAL(18,2): settle on whole cents here so the value we
    // compare, store and record are the same number.
    const limit = MaxApprovalAmount === null ? null : Math.round(MaxApprovalAmount * 100) / 100;

    connection = await createRequestConnection(token);
    const actor = await resolveLedgerActor(request, connection);
    if (!actor) return unauthorizedResponse();

    await beginTransaction(connection);
    try {
      // Locked until commit, so the "before" we record is the value we replace.
      const existing = await executeQuery(
        connection,
        `SELECT MaxApprovalAmount FROM dbo.ApprovalLimits WITH (UPDLOCK, HOLDLOCK) WHERE RoleName = @RoleName`,
        [{ name: "RoleName", type: TYPES.NVarChar, value: RoleName }],
      );
      const hadRow = existing.length > 0;
      const previous = hadRow ? ((existing[0].MaxApprovalAmount as number | null) ?? null) : null;

      await executeQuery(
        connection,
        `MERGE dbo.ApprovalLimits AS target
         USING (SELECT @RoleName AS RoleName) AS src
           ON target.RoleName = src.RoleName
         WHEN MATCHED THEN
           UPDATE SET MaxApprovalAmount = @MaxApprovalAmount
         WHEN NOT MATCHED THEN
           INSERT (RoleName, MaxApprovalAmount) VALUES (@RoleName, @MaxApprovalAmount);`,
        [
          { name: "RoleName", type: TYPES.NVarChar, value: RoleName },
          // Without precision/scale tedious sends scale 0 and rounds away the cents.
          {
            name: "MaxApprovalAmount",
            options: { precision: 18, scale: 2 },
            type: TYPES.Decimal,
            value: limit,
          },
        ],
      );

      if (!hadRow || previous !== limit) {
        await record(connection, {
          action: "approval_limit.change",
          actor,
          after: { maxApprovalAmount: limit },
          before: hadRow ? { maxApprovalAmount: previous } : undefined,
          subject: { id: RoleName, type: "approval_limit" },
        });
      }
      await commitTransaction(connection);
    } catch (err) {
      await rollbackTransaction(connection).catch(() => {});
      throw err;
    }

    invalidateApprovalLimitsCache();
    return { status: 200, jsonBody: { ok: true, roleName: RoleName, maxApprovalAmount: limit } };
  } catch (error: unknown) {
    // The decision was rolled back above; the entry itself was unrecordable
    // (a role name too long for the ledger, say).
    if (error instanceof LedgerValidationError) {
      return { status: 400, jsonBody: { error: error.message } };
    }
    const message = error instanceof Error ? error.message : String(error);
    context.error("setApprovalLimit failed:", message);
    return errorResponse("Set approval limit failed", message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("setApprovalLimit", { methods: ["POST"], authLevel: "anonymous", handler: setApprovalLimit });
