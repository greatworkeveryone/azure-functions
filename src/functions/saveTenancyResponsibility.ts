// POST /api/saveTenancyResponsibility  (TR7)
// Body: { tenantId, responsibilityId?, rowVersion? (required with responsibilityId), item, category?, location?,
//         maintainedBy, assetId?, projectEventId?, drawingRef?, note? }. Adds an item, or edits one: a stale
// rowVersion is a 409. Response: { item }.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { authorizeWrite, inTransaction, txFail, txOk } from "../assetRegisterSupport";
import { record } from "../ledger";
import { positiveId } from "../tenantLinks/contacts";
import { refusal, runStaff } from "../tenantLinks/http";
import { readTenancy, versionBuffer } from "../tenantLinks/store";
import { parseResponsibilityFields } from "../tenancyResponsibilities/parse";
import { EDIT_RESPONSIBILITIES_ROLES, RESPONSIBILITIES_FLAG } from "../tenancyResponsibilities/roles";
import { insertResponsibility, linkProblem, readResponsibility, updateResponsibility } from "../tenancyResponsibilities/store";
import { responsibilitySnapshot } from "../tenancyResponsibilities/snapshot";

export async function saveTenancyResponsibility(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const auth = await authorizeWrite(request, EDIT_RESPONSIBILITIES_ROLES);
  if (!auth.ok) return auth.response;
  return runStaff(request, context, "saveTenancyResponsibility", auth.token, true, async ({ actor, body, connection }) => {
    const tenantId = positiveId(body.tenantId);
    if (tenantId === null) return refusal(400, "tenantId is required");
    const fields = parseResponsibilityFields(body);
    if (!fields.ok) return refusal(400, fields.error);
    const editing = body.responsibilityId !== undefined && body.responsibilityId !== null;
    const id = editing ? positiveId(body.responsibilityId) : null;
    if (editing && id === null) return refusal(400, "responsibilityId must be a whole number");
    const version = editing ? versionBuffer(body.rowVersion) : null;
    if (editing && version === null) return refusal(400, "rowVersion is required to edit an item");

    const out = await inTransaction(connection, async () => {
      const tenancy = await readTenancy(connection, tenantId);
      if (!tenancy) return txFail(refusal(404, "Tenancy not found"));
      if (tenancy.archivedAt !== null) return txFail(refusal(409, "This tenancy is archived"));
      const problem = await linkProblem(connection, tenancy.buildingId, fields.value);
      if (problem) return txFail(refusal(400, problem));
      let savedId: number;
      let before = null;
      if (id === null) {
        savedId = await insertResponsibility(connection, tenantId, fields.value, actor.name);
      } else {
        const current = await readResponsibility(connection, tenantId, id, true);
        if (!current) return txFail(refusal(404, "Item not found"));
        if (current.archivedAt !== null) return txFail(refusal(409, "This item is archived: restore it first"));
        if (!(await updateResponsibility(connection, tenantId, id, fields.value, version as Buffer, actor.name))) {
          return txFail(refusal(409, "Someone else changed this item. Reload it and try again."));
        }
        savedId = id;
        before = responsibilitySnapshot(current);
      }
      const saved = await readResponsibility(connection, tenantId, savedId);
      if (!saved) return txFail(refusal(500, "Could not read the item back"));
      await record(connection, {
        action: id === null ? "tenancy.responsibility_add" : "tenancy.responsibility_update",
        actor,
        after: responsibilitySnapshot(saved),
        before,
        buildingId: tenancy.buildingId,
        subject: { id: tenantId, type: "tenancy" },
        tenantId,
      });
      return txOk(saved);
    });
    return out.ok ? { jsonBody: { item: out.value }, status: id === null ? 201 : 200 } : out.response;
  }, RESPONSIBILITIES_FLAG);
}

app.http("saveTenancyResponsibility", { authLevel: "anonymous", handler: saveTenancyResponsibility, methods: ["POST"] });
