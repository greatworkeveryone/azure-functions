// POST /api/archiveTenancyContact  (TR2)
// Body: { tenantId, contactId, rowVersion, archived? (default true) }. Archives a contact (never deletes):
// its working links are revoked in the same step. archived:false restores it (links are not restored).
// A stale rowVersion is a 409. Response: { contact }.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { inTransaction, txFail, txOk } from "../assetRegisterSupport";
import { record } from "../ledger";
import { contactSnapshot, positiveId } from "../tenantLinks/contacts";
import { refusal, runStaff } from "../tenantLinks/http";
import { MANAGE_TENANT_LINKS_ROLES } from "../tenantLinks/roles";
import { liveLinkIds, readContact, readTenancy, revokeLink, setContactArchived, versionBuffer } from "../tenantLinks/store";

export async function archiveTenancyContact(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  return runStaff(request, context, "archiveTenancyContact", MANAGE_TENANT_LINKS_ROLES, true, async ({ actor, body, connection }) => {
    const tenantId = positiveId(body.tenantId);
    const contactId = positiveId(body.contactId);
    if (tenantId === null || contactId === null) return refusal(400, "tenantId and contactId are required");
    const version = versionBuffer(body.rowVersion);
    if (version === null) return refusal(400, "rowVersion is required");
    if (body.archived !== undefined && typeof body.archived !== "boolean") return refusal(400, "archived must be true or false");
    const archived = body.archived !== false;

    const out = await inTransaction(connection, async () => {
      const tenancy = await readTenancy(connection, tenantId);
      if (!tenancy) return txFail(refusal(404, "Tenancy not found"));
      const current = await readContact(connection, tenantId, contactId, true);
      if (!current) return txFail(refusal(404, "Contact not found"));
      if (!(await setContactArchived(connection, tenantId, contactId, archived, version, actor.name))) {
        return txFail(refusal(409, "Someone else changed this contact. Reload it and try again."));
      }
      const revoked = archived ? await liveLinkIds(connection, contactId) : [];
      for (const link of revoked) await revokeLink(connection, link.linkId, actor.name, "contact_archived");
      const saved = (await readContact(connection, tenantId, contactId)) ?? current;
      await record(connection, {
        action: archived ? "tenancy.contact_archive" : "tenancy.contact_restore",
        actor,
        after: { ...contactSnapshot(saved), revokedLinkIds: revoked.map((l) => l.linkId) },
        before: contactSnapshot(current),
        buildingId: tenancy.buildingId,
        subject: { id: tenantId, type: "tenancy" },
        tenantId,
      });
      return txOk(saved);
    });
    return out.ok ? { jsonBody: { contact: out.value }, status: 200 } : out.response;
  });
}

app.http("archiveTenancyContact", { authLevel: "anonymous", handler: archiveTenancyContact, methods: ["POST"] });
