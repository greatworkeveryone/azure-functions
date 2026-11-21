// POST /api/confirmContractorContact — a second person confirms a changed contractor email or ABN
// (SECA-04). Body: { contractorId }. An accounts manager, the CFO or a director who is not the person
// who made the change. It ends the hold on sending purchase orders to that contractor; ledgered.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { TYPES } from "tedious";
import { ACTION_ROLES } from "../action-roles";
import { AppRole, rolesForRequest } from "../auth";
import { authorizeWrite, badRequest, conflict, inTransaction, notFound, readJsonBody, txFail, txOk } from "../assetRegisterSupport";
import { closeConnection, createRequestConnection, executeQuery } from "../db";
import { record } from "../ledger";
import { resolveLedgerActor } from "../ledger/actor";

export async function confirmContractorContact(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const auth = await authorizeWrite(request, ACTION_ROLES.confirmContractorContact.gate);
  if (!auth.ok) return auth.response;
  // Admin passes the gate by hierarchy but approves nothing real (decision 4).
  const roles = await rolesForRequest(request);
  if (roles.every((role) => role === AppRole.ADMIN)) return { jsonBody: { code: "admin_cannot_confirm", error: "An accounts manager, the CFO or a director has to confirm this." }, status: 403 };
  const body = await readJsonBody(request);
  const contractorId = body?.contractorId;
  if (typeof contractorId !== "number" || !Number.isInteger(contractorId) || contractorId <= 0) return badRequest("contractorId must be a positive integer");

  let connection;
  try {
    connection = await createRequestConnection(auth.token);
    const conn = connection;
    const actor = await resolveLedgerActor(request, conn);
    if (!actor) return { jsonBody: { error: "Unauthorised" }, status: 401 };
    const result = await inTransaction(conn, async () => {
      const rows = await executeQuery(
        conn,
        `SELECT ContractorName, ContactChangedAt, ContactChangedBy, ContactChangedByOid, ContactConfirmedAt
           FROM dbo.Contractors WITH (UPDLOCK, HOLDLOCK) WHERE ContractorID = @Id`,
        [{ name: "Id", type: TYPES.Int, value: contractorId }],
      );
      const row = rows[0];
      if (!row) return txFail(notFound("That contractor isn't in Floorplan"));
      if (!row.ContactChangedAt) return txFail(conflict("Nothing has changed on this contractor that needs confirming."));
      if (row.ContactConfirmedAt) return txFail(conflict("This change has already been confirmed."));
      if (row.ContactChangedByOid && row.ContactChangedByOid === auth.caller.oid) {
        return txFail({ jsonBody: { code: "contact_confirm_by_editor", error: "A second person has to confirm this: you made the change." }, status: 403 });
      }
      await executeQuery(
        conn,
        "UPDATE dbo.Contractors SET ContactConfirmedAt = SYSUTCDATETIME(), ContactConfirmedBy = @By WHERE ContractorID = @Id",
        [
          { name: "Id", type: TYPES.Int, value: contractorId },
          { name: "By", type: TYPES.NVarChar, value: auth.caller.name },
        ],
      );
      await record(conn, {
        action: "contractor.contact_confirm",
        actor,
        after: { confirmed: true, contractorName: row.ContractorName ?? null },
        before: { changedBy: row.ContactChangedBy ?? null, confirmed: false },
        subject: { id: contractorId, type: "contractor" },
      });
      return txOk({ confirmed: true });
    });
    return result.ok ? { jsonBody: result.value, status: 200 } : result.response;
  } catch (error) {
    context.error("confirmContractorContact failed:", (error as Error).message);
    return { jsonBody: { error: "The confirmation couldn't be saved. Try again." }, status: 500 };
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("confirmContractorContact", { authLevel: "anonymous", handler: confirmContractorContact, methods: ["POST"] });
