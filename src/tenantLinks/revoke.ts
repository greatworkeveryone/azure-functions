// Revoke a contact's links, and the email-only switch (which revokes them all). Both ledgered.

import type { Connection } from "tedious";
import { inTransaction, txFail, txOk } from "../assetRegisterSupport";
import { record } from "../ledger";
import type { LedgerActor } from "../ledger/types";
import { liveLinkIds, liveLinksOfTenancy, readContact, readTenancy, revokeLink, setEmailOnlyFlag, versionBuffer } from "./store";

export type Outcome = { ok: true; revoked: number } | { error: string; ok: false; status: number };
const refuse = (status: number, error: string): { error: string; ok: false; status: number } => ({ error, ok: false, status });

export async function revokeContactLink(connection: Connection, input: { actor: LedgerActor; contactId: number; tenantId: number }): Promise<Outcome> {
  const out = await inTransaction<number>(connection, async () => {
    const tenancy = await readTenancy(connection, input.tenantId);
    if (!tenancy) return txFail({ jsonBody: { error: "Tenancy not found" }, status: 404 });
    const contact = await readContact(connection, input.tenantId, input.contactId, true);
    if (!contact) return txFail({ jsonBody: { error: "Contact not found" }, status: 404 });
    const live = await liveLinkIds(connection, input.contactId);
    if (live.length === 0) return txFail({ jsonBody: { error: "This contact has no link to revoke" }, status: 409 });
    for (const link of live) await revokeLink(connection, link.linkId, input.actor.name, "revoked");
    await record(connection, {
      action: "tenancy.link_revoke",
      actor: input.actor,
      after: { contactId: input.contactId, linkIds: live.map((l) => l.linkId) },
      buildingId: tenancy.buildingId,
      subject: { id: input.tenantId, type: "tenancy" },
      tenantId: input.tenantId,
    });
    return txOk(live.length);
  });
  return out.ok ? { ok: true, revoked: out.value } : refuse(out.response.status ?? 500, (out.response.jsonBody as { error: string }).error);
}

export async function setEmailOnly(
  connection: Connection,
  input: { actor: LedgerActor; emailOnly: boolean; rowVersion: unknown; tenantId: number },
): Promise<Outcome> {
  const version = versionBuffer(input.rowVersion);
  if (!version) return refuse(400, "rowVersion is required");
  const out = await inTransaction<number>(connection, async () => {
    const tenancy = await readTenancy(connection, input.tenantId);
    if (!tenancy) return txFail({ jsonBody: { error: "Tenancy not found" }, status: 404 });
    if (!(await setEmailOnlyFlag(connection, input.tenantId, input.emailOnly, version))) {
      return txFail({ jsonBody: { error: "Someone else changed this tenancy. Reload it and try again." }, status: 409 });
    }
    // Email only means no working link: any that exist stop at once.
    const live = input.emailOnly ? await liveLinksOfTenancy(connection, input.tenantId) : [];
    for (const link of live) await revokeLink(connection, link.linkId, input.actor.name, "email_only");
    await record(connection, {
      action: "tenancy.email_only_set",
      actor: input.actor,
      after: { emailOnly: input.emailOnly, revokedLinkIds: live.map((l) => l.linkId) },
      before: { emailOnly: tenancy.emailOnly },
      buildingId: tenancy.buildingId,
      subject: { id: input.tenantId, type: "tenancy" },
      tenantId: input.tenantId,
    });
    return txOk(live.length);
  });
  return out.ok ? { ok: true, revoked: out.value } : refuse(out.response.status ?? 500, (out.response.jsonBody as { error: string }).error);
}
