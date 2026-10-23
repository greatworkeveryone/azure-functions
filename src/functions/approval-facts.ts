// POST /api/setApprovalFact   (LAUNCH-READINESS R13, WP43a-2)
//
// The CFO edits a fact beside the approval limits: the PO variance margin
// (percent of the original approved amount) or its cap in dollars. Defaults 10%
// and $1,000, seeded by migration 117; Connor and Johanne to confirm.
//
// Body { factKey: "po_variance_margin_percent" | "po_variance_cap", value }
//   margin: 0 to 100 percent; cap: $0 or more. Two decimal places at most.
// Changing a fact is a decision (PLAN §3.12): the value and its ledger row
// (approval_fact.change, an exception) commit together. Re-saving the value a
// fact already has changes nothing and writes no row. A money action (S11).
// director_approval_threshold is director/admin only; margin and cap are CFO only.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { TYPES } from "tedious";
import { VARIANCE_FACT_KEYS } from "../approvalAuthority-db";
import { AppRole, errorResponse, extractToken, rolesForRequest, unauthorizedResponse, verifiedIdentityFromRequest } from "../auth";
import { beginTransaction, closeConnection, commitTransaction, createRequestConnection, executeQuery, rollbackTransaction } from "../db";
import { record } from "../ledger";
import { resolveLedgerActor } from "../ledger/actor";
import { requireMoneyContext } from "../moneyGate";

const BOUNDS: Record<string, { label: string; max: number }> = {
  director_approval_threshold: { label: "The director approval threshold", max: 1_000_000_000 },
  [VARIANCE_FACT_KEYS.capDollars]: { label: "The variance cap", max: 1_000_000 },
  [VARIANCE_FACT_KEYS.marginPercent]: { label: "The variance margin", max: 100 },
};

export async function setApprovalFact(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const userRoles = await rolesForRequest(request);
  const isCfo = userRoles.includes(AppRole.CFO);
  const isDirector = userRoles.includes(AppRole.DIRECTOR) || userRoles.includes(AppRole.ADMIN);
  if (!isCfo && !isDirector) {
    return { status: 403, jsonBody: { error: "CFO role required" } };
  }
  // Money action (S11): allowed network, fresh sign-in, MFA. src/money-gated-routes.ts
  const gate = await requireMoneyContext(request);
  if (gate) return gate;

  let connection;
  try {
    const body = ((await request.json().catch(() => null)) ?? {}) as { factKey?: unknown; value?: unknown };
    const key = typeof body.factKey === "string" ? body.factKey : "";
    const bounds = BOUNDS[key];
    if (!bounds) return { status: 400, jsonBody: { error: `factKey must be one of ${Object.keys(BOUNDS).join(", ")}` } };
    // The director threshold bounds the CFO's own reach, so the CFO cannot set it alone.
    const thresholdKey = key === "director_approval_threshold";
    if (thresholdKey ? !isDirector : !isCfo) {
      return { status: 403, jsonBody: { error: thresholdKey ? "Director role required to set the director approval threshold" : "CFO role required" } };
    }
    const value = body.value;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || (key === "director_approval_threshold" && value === 0) || value > bounds.max || Math.round(value * 100) !== value * 100) {
      return { status: 400, jsonBody: { error: `${bounds.label} must be a number from 0 to ${bounds.max}, with at most 2 decimal places` } };
    }
    const identity = await verifiedIdentityFromRequest(request);
    if (!identity) return unauthorizedResponse();

    connection = await createRequestConnection(token);
    const actor = await resolveLedgerActor(request, connection);
    if (!actor) return unauthorizedResponse();

    await beginTransaction(connection);
    try {
      const existing = await executeQuery(connection, `SELECT FactValue FROM dbo.ApprovalFacts WITH (UPDLOCK, HOLDLOCK) WHERE FactKey = @FactKey`, [
        { name: "FactKey", type: TYPES.NVarChar, value: key },
      ]);
      const hadRow = existing.length > 0;
      const previous = hadRow ? Number(existing[0].FactValue) : null;
      if (previous !== value) {
        await executeQuery(
          connection,
          `MERGE dbo.ApprovalFacts AS target
           USING (SELECT @FactKey AS FactKey) AS src ON target.FactKey = src.FactKey
           WHEN MATCHED THEN UPDATE SET FactValue = @FactValue, UpdatedAt = SYSUTCDATETIME(), UpdatedBy = @UpdatedBy
           WHEN NOT MATCHED THEN INSERT (FactKey, FactValue, UpdatedBy) VALUES (@FactKey, @FactValue, @UpdatedBy);`,
          [
            { name: "FactKey", type: TYPES.NVarChar, value: key },
            { name: "FactValue", options: { precision: 18, scale: 4 }, type: TYPES.Decimal, value },
            { name: "UpdatedBy", type: TYPES.NVarChar, value: identity.name },
          ],
        );
        await record(connection, {
          action: "approval_fact.change",
          actor,
          after: { factKey: key, value },
          before: hadRow ? { factKey: key, value: previous } : undefined,
          subject: { id: key, type: "approval_limit" },
        });
      }
      await commitTransaction(connection);
    } catch (err) {
      await rollbackTransaction(connection).catch(() => {});
      throw err;
    }
    return { status: 200, jsonBody: { factKey: key, ok: true, value } };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    context.error("setApprovalFact failed:", message);
    return errorResponse("Set approval fact failed", message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("setApprovalFact", { methods: ["POST"], authLevel: "anonymous", handler: setApprovalFact });
