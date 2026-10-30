// POST /api/archiveTenancyResponsibility  (TR7)
// Body: { tenantId, responsibilityId, rowVersion, archived? (default true) }. Archives an item (never deletes);
// archived:false restores it. A stale rowVersion is a 409. Response: { item }.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { authorizeWrite, inTransaction, txFail, txOk } from "../assetRegisterSupport";
import { record } from "../ledger";
import { positiveId } from "../tenantLinks/contacts";
import { refusal, runStaff } from "../tenantLinks/http";
import { readTenancy, versionBuffer } from "../tenantLinks/store";
import { EDIT_RESPONSIBILITIES_ROLES, RESPONSIBILITIES_FLAG } from "../tenancyResponsibilities/roles";
import { readResponsibility, setResponsibilityArchived } from "../tenancyResponsibilities/store";
import { responsibilitySnapshot } from "../tenancyResponsibilities/snapshot";

export async function archiveTenancyResponsibility(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const auth = await authorizeWrite(request, EDIT_RESPONSIBILITIES_ROLES);
  if (!auth.ok) return auth.response;
  return runStaff(request, context, "archiveTenancyResponsibility", auth.token, true, async ({ actor, body, connection }) => {
    const tenantId = positiveId(body.tenantId);
    const id = positiveId(body.responsibilityId);
    if (tenantId === null || id === null) return refusal(400, "tenantId and responsibilityId are required");
    const version = versionBuffer(body.rowVersion);
    if (version === null) return refusal(400, "rowVersion is required");
    if (body.archived !== undefined && typeof body.archived !== "boolean") return refusal(400, "archived must be true or false");
    const archived = body.archived !== false;

    const out = await inTransaction(connection, async () => {
      const tenancy = await readTenancy(connection, tenantId);
      if (!tenancy) return txFail(refusal(404, "Tenancy not found"));
      const current = await readResponsibility(connection, tenantId, id, true);
      if (!current) return txFail(refusal(404, "Item not found"));
      if (!(await setResponsibilityArchived(connection, tenantId, id, archived, version, actor.name))) {
        return txFail(refusal(409, "Someone else changed this item. Reload it and try again."));
      }
      const saved = (await readResponsibility(connection, tenantId, id)) ?? current;
      await record(connection, {
        action: archived ? "tenancy.responsibility_archive" : "tenancy.responsibility_restore",
        actor,
        after: responsibilitySnapshot(saved),
        before: responsibilitySnapshot(current),
        buildingId: tenancy.buildingId,
        subject: { id: tenantId, type: "tenancy" },
        tenantId,
      });
      return txOk(saved);
    });
    return out.ok ? { jsonBody: { item: out.value }, status: 200 } : out.response;
  }, RESPONSIBILITIES_FLAG);
}

app.http("archiveTenancyResponsibility", { authLevel: "anonymous", handler: archiveTenancyResponsibility, methods: ["POST"] });
