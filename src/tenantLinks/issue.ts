// Issue and reissue a personal link (TR2, PLAN §15).
//
// The email goes out through the EB1 send core's own pieces, not its queue: the queue stores each
// job's body and merge values, which would keep the plaintext token in the database, and the one
// promise about a token is that only its hash is ever stored. Everything else the core guarantees
// is applied here: COMMS_SEND_ENABLED off means nothing is issued; dry run composes and logs
// without calling Graph (and issues nothing usable); DEV_EMAIL_OVERRIDE rewrites the recipient;
// a test tenancy never gets mail (recipientRecords + assertMayLeave); the sender is notices@.
//
// Order: (1) in a transaction, check everything and store the NEW link, not yet usable;
// (2) send; (3) in a transaction, make it usable, revoke the contact's older links and ledger it.
// A send that fails revokes the new link and leaves the old one as it was; a crash between 2 and 3
// leaves an unusable link (the contact asks for another), never a usable link nobody was told of.

import { commsMode, fromAddress, fromName, type CommsMode } from "../comms/config";
import { composeForRecipient } from "../comms/compose";
import { createGraphSender, MailSendError, toSendError, type MailSender } from "../comms/graphSend";
import { resolveRecipientRecord } from "../comms/recipientRecords";
import { inTransaction, txFail, txOk, type TxResult } from "../assetRegisterSupport";
import { beginTransaction, commitTransaction, rollbackTransaction } from "../db";
import { resolveRecipient } from "../email-recipient";
import { record } from "../ledger";
import type { LedgerActor } from "../ledger/types";
import { assertMayLeave, TestDataEgressError } from "../test-data";
import type { Connection } from "tedious";
import { contactSnapshot } from "./contacts";
import { activateLink, insertPendingLink, liveLinkIds, readContact, readTenancy, revokeLink } from "./store";
import { LINK_SUBJECT, LINK_TEMPLATE_ID, LINK_TEMPLATE_VERSION, linkBody } from "./template";
import { addMonths, hashToken, linkUrl, newToken } from "./token";

export interface IssueInput {
  actor: LedgerActor;
  contactId: number;
  months: number;
  reissue: boolean;
  tenantId: number;
}

export interface IssueDeps {
  log?: (message: string) => void;
  mode?: CommsMode;
  now?: () => Date;
  sender?: MailSender;
}

export type IssueResult =
  | { delivery: "dry_run"; ok: true }
  | { delivery: "sent"; expiresAt: string; linkId: number; ok: true }
  | { error: string; ok: false; status: number };

const refuse = (status: number, error: string): { error: string; ok: false; status: number } => ({ error, ok: false, status });
const REPLY_TO_DEFAULT = "workrequests@randazzo.properties";

const darwinDay = (d: Date): string =>
  new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "long", timeZone: "Australia/Darwin", year: "numeric" }).format(d);

interface Stored {
  email: string;
  expiresAt: Date;
  linkId: number;
  name: string;
  token: string;
}

async function revokeQuietly(connection: Connection, linkId: number, reason: string, by: string): Promise<void> {
  await inTransaction(connection, async () => {
    await revokeLink(connection, linkId, by, reason);
    return txOk(true);
  }).catch(() => undefined);
}

export async function issueLink(connection: Connection, input: IssueInput, deps: IssueDeps = {}): Promise<IssueResult> {
  const mode = deps.mode ?? commsMode();
  const log = deps.log ?? (() => undefined);
  const now = (deps.now ?? (() => new Date()))();
  const by = input.actor.name;
  if (mode === "off") return refuse(409, "Email sending is switched off, so a link can't be sent. Nothing was issued.");
  try {
    linkUrl(newToken());
  } catch {
    return refuse(503, "The app address isn't configured, so a link can't be built. Nothing was issued.");
  }

  const stored = await inTransaction<Stored>(connection, async (): Promise<TxResult<Stored>> => {
    const tenancy = await readTenancy(connection, input.tenantId);
    if (!tenancy) return txFail({ jsonBody: { error: "Tenancy not found" }, status: 404 });
    if (tenancy.archivedAt !== null) return txFail({ jsonBody: { error: "This tenancy is archived" }, status: 409 });
    if (tenancy.emailOnly) return txFail({ jsonBody: { error: "This tenancy is email only: it is never sent a link" }, status: 409 });
    const contact = await readContact(connection, input.tenantId, input.contactId, true);
    if (!contact) return txFail({ jsonBody: { error: "Contact not found" }, status: 404 });
    if (contact.archivedAt !== null) return txFail({ jsonBody: { error: "This contact is archived" }, status: 409 });
    if (contact.email === null) return txFail({ jsonBody: { error: "This contact has no email address to send a link to" }, status: 400 });
    const live = await liveLinkIds(connection, input.contactId);
    const working = live.some((l) => l.expiresAt.getTime() > now.getTime());
    if (!input.reissue && working) return txFail({ jsonBody: { error: "This contact already has a working link: reissue it to replace it" }, status: 409 });
    if (input.reissue && live.length === 0) return txFail({ jsonBody: { error: "This contact has no link to reissue: issue one" }, status: 409 });
    const resolution = await resolveRecipientRecord(connection, { address: contact.email, recipientRefId: String(input.tenantId), recipientType: "tenancy" });
    if (!resolution.ok) return txFail({ jsonBody: { error: resolution.detail }, status: 409 });
    const token = newToken();
    const expiresAt = addMonths(now, input.months);
    const linkId = await insertPendingLink(connection, { contactId: input.contactId, expiresAt, hash: hashToken(token), issuedBy: by, tenantId: input.tenantId });
    return txOk({ email: contact.email, expiresAt, linkId, name: contact.name, token });
  });
  if (!stored.ok) return refuse(stored.response.status ?? 500, (stored.response.jsonBody as { error: string }).error);
  const link = stored.value;

  const composed = composeForRecipient(
    {
      bodyMarkdown: linkBody(linkUrl(link.token), darwinDay(link.expiresAt)),
      companyName: fromName(),
      createdByName: by,
      kind: "system",
      replyTo: { address: process.env.TENANT_LINK_REPLY_TO?.trim() || REPLY_TO_DEFAULT, name: fromName() },
      signature: { email: null, lines: [fromName()], phone: null },
      signatureMode: "role",
      subject: LINK_SUBJECT,
    },
    { mergeValues: {}, name: link.name, recipientType: "tenancy" },
    now,
  );
  if (!composed.ok) {
    await revokeQuietly(connection, link.linkId, "compose_failed", by);
    return refuse(500, "The link email couldn't be composed. Nothing was issued.");
  }
  try {
    assertMayLeave("email", { isTest: false });
  } catch (error) {
    if (!(error instanceof TestDataEgressError)) throw error;
    await revokeQuietly(connection, link.linkId, "blocked", by);
    return refuse(409, "Mail may not leave from here. Nothing was issued.");
  }
  const target = resolveRecipient(link.email);
  if (target.address === null) {
    await revokeQuietly(connection, link.linkId, "no_address", by);
    return refuse(400, "This contact has no usable email address");
  }
  const subject = target.overridden ? `[For ${link.email}] ${composed.email.subject}` : composed.email.subject;

  if (mode === "dry-run") {
    log(`tenantLinks: dry run, would send link ${link.linkId} (subject of ${subject.length} characters)`);
    await revokeQuietly(connection, link.linkId, "dry_run", by);
    return { delivery: "dry_run", ok: true };
  }

  try {
    const sender = deps.sender ?? createGraphSender();
    // The body is a live credential, so no copy may stay in notices@ Sent Items (sendWithoutCopy).
    await sender.sendWithoutCopy({
      from: { address: fromAddress(), name: fromName() },
      html: composed.email.html,
      replyTo: { address: process.env.TENANT_LINK_REPLY_TO?.trim() || REPLY_TO_DEFAULT, name: fromName() },
      subject,
      to: target.address,
    });
  } catch (error) {
    const failure = error instanceof MailSendError ? error : toSendError(error);
    log(`tenantLinks: link ${link.linkId} not sent (${failure.code})`);
    await revokeQuietly(connection, link.linkId, "send_failed", by);
    return refuse(502, "The email couldn't be sent, so no link was issued. The contact's earlier link, if any, still works.");
  }

  await beginTransaction(connection);
  try {
    await activateLink(connection, link.linkId);
    const replaced = await liveLinkIds(connection, input.contactId, link.linkId);
    for (const old of replaced) await revokeLink(connection, old.linkId, by, "reissued");
    const tenancy = await readTenancy(connection, input.tenantId);
    const contact = await readContact(connection, input.tenantId, input.contactId);
    await record(connection, {
      action: input.reissue ? "tenancy.link_reissue" : "tenancy.link_issue",
      actor: input.actor,
      after: {
        contact: contact ? contactSnapshot(contact) : { contactId: input.contactId },
        expiresAt: link.expiresAt.toISOString(),
        linkId: link.linkId,
        replacedLinkIds: replaced.map((r) => r.linkId),
        template: `${LINK_TEMPLATE_ID} v${LINK_TEMPLATE_VERSION}`,
      },
      buildingId: tenancy?.buildingId ?? null,
      subject: { id: input.tenantId, type: "tenancy" },
      tenantId: input.tenantId,
    });
    await commitTransaction(connection);
  } catch (error) {
    await rollbackTransaction(connection).catch(() => undefined);
    throw error;
  }
  return { delivery: "sent", expiresAt: link.expiresAt.toISOString(), linkId: link.linkId, ok: true };
}
