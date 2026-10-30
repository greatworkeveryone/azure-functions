// POST /api/saveTenancyContact  (TR2)
// Body: { tenantId, contactId?, rowVersion? (required with contactId), name, email?, phone?, reportsIssues?,
//         authorisedForCosts?, escalation? }. Adds a contact, or edits one: a stale rowVersion is a 409.
// Response: { contact }.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { inTransaction, txFail, txOk } from "../assetRegisterSupport";
import { record } from "../ledger";
import { contactSnapshot, parseContactFields, positiveId } from "../tenantLinks/contacts";
import { refusal, runStaff } from "../tenantLinks/http";
import { MANAGE_TENANT_LINKS_ROLES } from "../tenantLinks/roles";
import { insertContact, readContact, readTenancy, updateContact, versionBuffer } from "../tenantLinks/store";

export async function saveTenancyContact(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  return runStaff(request, context, "saveTenancyContact", MANAGE_TENANT_LINKS_ROLES, true, async ({ actor, body, connection }) => {
    const tenantId = positiveId(body.tenantId);
    if (tenantId === null) return refusal(400, "tenantId is required");
    const fields = parseContactFields(body);
    if (!fields.ok) return refusal(400, fields.error);
    const editing = body.contactId !== undefined && body.contactId !== null;
    const contactId = editing ? positiveId(body.contactId) : null;
    if (editing && contactId === null) return refusal(400, "contactId must be a whole number");
    const version = editing ? versionBuffer(body.rowVersion) : null;
    if (editing && version === null) return refusal(400, "rowVersion is required to edit a contact");

    const out = await inTransaction(connection, async () => {
      const tenancy = await readTenancy(connection, tenantId);
      if (!tenancy) return txFail(refusal(404, "Tenancy not found"));
      if (tenancy.archivedAt !== null) return txFail(refusal(409, "This tenancy is archived"));
      let id: number;
      let before = null;
      if (contactId === null) {
        id = await insertContact(connection, tenantId, fields.value, actor.name);
      } else {
        const current = await readContact(connection, tenantId, contactId, true);
        if (!current) return txFail(refusal(404, "Contact not found"));
        if (current.archivedAt !== null) return txFail(refusal(409, "This contact is archived: restore it first"));
        if (!(await updateContact(connection, tenantId, contactId, fields.value, version as Buffer, actor.name))) {
          return txFail(refusal(409, "Someone else changed this contact. Reload it and try again."));
        }
        id = contactId;
        before = contactSnapshot(current);
      }
      const saved = await readContact(connection, tenantId, id);
      if (!saved) return txFail(refusal(500, "Could not read the contact back"));
      await record(connection, {
        action: contactId === null ? "tenancy.contact_add" : "tenancy.contact_update",
        actor,
        after: contactSnapshot(saved),
        before,
        buildingId: tenancy.buildingId,
        subject: { id: tenantId, type: "tenancy" },
        tenantId,
      });
      return txOk(saved);
    });
    return out.ok ? { jsonBody: { contact: out.value }, status: contactId === null ? 201 : 200 } : out.response;
  });
}

app.http("saveTenancyContact", { authLevel: "anonymous", handler: saveTenancyContact, methods: ["POST"] });
