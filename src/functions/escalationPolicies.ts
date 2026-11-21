// GET /api/getEscalationPolicies and POST /api/setEscalationPolicy: the admin screen's switch for every
// escalation policy (Admin > System). Admin only, mirrored in the frontend action-roles table
// (manageEscalationPolicies). Switching a policy on or off is a row update, so it is ledgered with who and when,
// and carries the state the screen showed: a stale switch is a 409, never a silent overwrite.
//
// Nothing here switches a policy on by itself. The cache is per instance and lasts five minutes
// (escalation/policies.ts), so a change reaches every instance within that time.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { TYPES } from "tedious";
import { ACTION_ROLES } from "../action-roles";
import { authorizeWrite, badRequest, conflict, inTransaction, notFound, readJsonBody, txFail, txOk } from "../assetRegisterSupport";
import { closeConnection, createRequestConnection, executeQuery } from "../db";
import { describeLadder, describePolicy } from "../escalation/policyDescriptions";
import { invalidatePolicyCache, parsePolicyRow } from "../escalation/policies";
import { record } from "../ledger";
import { resolveLedgerActor } from "../ledger/actor";
import { errorMessage } from "../errorMessage";

const COLUMNS = "PolicyKey, Kind, Urgent, Clock, Ladder, AutoReescalate, Active, UpdatedAt, UpdatedBy";

// What the sweep does when a level is overdue, from the stored AutoReescalate. Only true while the sweep is live.
const CHASING: Record<string, string> = {
  no: "Never moves up by itself",
  nudge: "Repeats the same level when overdue",
  reminder: "Repeats the same level when overdue",
  yes: "Moves up a level when overdue",
};

export interface PolicyDto {
  active: boolean;
  chasing: string;
  description: string;
  kind: "attention" | "authority";
  policyKey: string;
  /** Who is told, in order, from the stored ladder. Empty when the row is unreadable. */
  tellsInOrder: string;
  updatedAt: string | null;
  updatedBy: string | null;
}

export function toPolicyDto(row: Record<string, unknown>): PolicyDto {
  const key = String(row.PolicyKey ?? "");
  const updatedAt = row.UpdatedAt instanceof Date ? row.UpdatedAt.toISOString() : null;
  const updatedBy = typeof row.UpdatedBy === "string" ? row.UpdatedBy : null;
  let tells = "";
  let kind: PolicyDto["kind"] = row.Kind === "authority" ? "authority" : "attention";
  try {
    const policy = parsePolicyRow(row);
    tells = describeLadder(policy.ladder, policy.clock);
    kind = policy.kind;
  } catch {
    tells = "";
  }
  return {
    active: Boolean(row.Active),
    chasing: CHASING[String(row.AutoReescalate)] ?? "",
    description: describePolicy(key),
    kind,
    policyKey: key,
    tellsInOrder: tells,
    updatedAt,
    updatedBy,
  };
}

export async function getEscalationPolicies(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const auth = await authorizeWrite(request, ACTION_ROLES.manageEscalationPolicies.gate);
  if (!auth.ok) return auth.response;
  let connection;
  try {
    connection = await createRequestConnection(auth.token);
    const rows = await executeQuery(connection, `SELECT ${COLUMNS} FROM dbo.EscalationPolicies ORDER BY PolicyKey`);
    return { jsonBody: { policies: rows.map(toPolicyDto) }, status: 200 };
  } catch (error) {
    context.error("getEscalationPolicies failed:", errorMessage(error));
    return { jsonBody: { error: "The policies couldn't be loaded. Try again." }, status: 500 };
  } finally {
    if (connection) closeConnection(connection);
  }
}

export async function setEscalationPolicy(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const auth = await authorizeWrite(request, ACTION_ROLES.manageEscalationPolicies.gate);
  if (!auth.ok) return auth.response;
  const body = await readJsonBody(request);
  if (!body) return badRequest("JSON object required");
  const { active, policyKey, wasActive } = body;
  if (typeof policyKey !== "string" || !/^[a-z_]+\.[a-z_0-9]+$/.test(policyKey)) return badRequest("policyKey must be a policy key");
  if (typeof active !== "boolean") return badRequest("active must be true or false");
  if (typeof wasActive !== "boolean") return badRequest("wasActive must be the state the screen showed");

  let connection;
  try {
    connection = await createRequestConnection(auth.token);
    const conn = connection;
    const actor = await resolveLedgerActor(request, conn);
    if (!actor) return { jsonBody: { error: "Unauthorised" }, status: 401 };
    const result = await inTransaction(conn, async () => {
      const rows = await executeQuery(conn, `SELECT ${COLUMNS} FROM dbo.EscalationPolicies WITH (UPDLOCK, HOLDLOCK) WHERE PolicyKey = @Key`, [
        { name: "Key", type: TYPES.NVarChar, value: policyKey },
      ]);
      const row = rows[0];
      if (!row) return txFail(notFound("That policy isn't in Floorplan"));
      if (Boolean(row.Active) !== wasActive) return txFail(conflict("Someone else changed this policy. Reload to see its state."));
      if (wasActive === active) return txOk(toPolicyDto(row));
      await executeQuery(
        conn,
        "UPDATE dbo.EscalationPolicies SET Active = @Active, UpdatedAt = SYSUTCDATETIME(), UpdatedBy = @By WHERE PolicyKey = @Key",
        [
          { name: "Active", type: TYPES.Bit, value: active },
          { name: "By", type: TYPES.NVarChar, value: auth.caller.name },
          { name: "Key", type: TYPES.NVarChar, value: policyKey },
        ],
      );
      await record(conn, {
        action: "escalation.policy_switch",
        actor,
        after: { active },
        before: { active: wasActive },
        subject: { id: policyKey, type: "escalation_policy" },
      });
      return txOk(toPolicyDto({ ...row, Active: active, UpdatedAt: new Date(), UpdatedBy: auth.caller.name }));
    });
    if (!result.ok) return result.response;
    invalidatePolicyCache();
    return { jsonBody: { policy: result.value }, status: 200 };
  } catch (error) {
    context.error("setEscalationPolicy failed:", errorMessage(error));
    return { jsonBody: { error: "The switch couldn't be saved. Try again." }, status: 500 };
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("getEscalationPolicies", { authLevel: "anonymous", handler: getEscalationPolicies, methods: ["GET"] });
app.http("setEscalationPolicy", { authLevel: "anonymous", handler: setEscalationPolicy, methods: ["POST"] });
