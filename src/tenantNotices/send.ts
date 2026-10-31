// Queues one tenant notice through the comms core (EB1): the template, the recipients the tenancy's own records
// allow, and the egress guard (a test tenancy's contact is refused; DEV_EMAIL_OVERRIDE rewrites the address at send).

import type { Connection } from "tedious";
import { AppRole } from "../auth";
import type { CommsActor } from "../comms/actor";
import { fromAddress, fromName, tenantReplyTo } from "../comms/config";
import { queueTemplatedLetter } from "../comms/templated";
import { loadTemplateBySlug } from "../intake/template";
import type { NoticeContext } from "./context";
import { LINK_BLOCK_SUFFIX, NOTICE_ACTOR_NAME, NOTICE_ACTOR_OID, NOTICE_TEMPLATES, type NoticeEvent } from "./config";
import type { NoticeContact } from "./recipients";

export type SendOutcome = { correspondenceId: number; ok: true; recipients: string } | { detail: string; ok: false };

export const noticeKey = (jobId: number, event: NoticeEvent): string => `tenant-notice-${jobId}-${event}`;

// Facilities' protocol sends these, so the comms core's record of the creator carries the facilities role.
const actor = (): CommsActor => ({ email: fromAddress(), name: NOTICE_ACTOR_NAME, oid: NOTICE_ACTOR_OID, role: AppRole.FACILITIES, roles: [AppRole.FACILITIES] });

export async function queueNotice(
  connection: Connection,
  input: { commsLive: boolean; context: NoticeContext; contacts: readonly NoticeContact[]; event: NoticeEvent; jobId: number; tenantId: number },
): Promise<SendOutcome> {
  const { commsLive, context, contacts, event, jobId, tenantId } = input;
  const spec = NOTICE_TEMPLATES[event];
  // An email-only tenancy gets the same plain-text notice without the paragraph that points at a personal link.
  const template = await loadTemplateBySlug(connection, spec.slug, context.emailOnly ? { omitBlockIdSuffix: LINK_BLOCK_SUFFIX } : {});
  if (!template) return { detail: `The ${spec.id} template isn't in the library`, ok: false };
  const result = await queueTemplatedLetter(connection, {
    actor: actor(),
    commsLive,
    key: noticeKey(jobId, event),
    kind: "system",
    recipients: contacts.map((contact) => ({
      address: contact.email.toLowerCase(),
      mergeValues: {
        "building.name": context.buildingName,
        "request.reference": context.reference,
        "request.summary": context.summary,
        "tenant.addressee": contact.name || context.tenantName,
        "tenant.name": context.tenantName,
      },
      name: contact.name || null,
      recipientRefId: String(tenantId),
      recipientType: "tenancy" as const,
    })),
    replyTo: { address: tenantReplyTo(), identityId: null, name: null },
    signature: { email: tenantReplyTo(), lines: ["Facilities team", fromName()], phone: null },
    signatureMode: "role",
    template,
    templateId: spec.id,
    userId: null,
  });
  if (!result.ok) return { detail: (result.code === "blocked" ? `Can't be sent: ${result.detail}` : result.detail).slice(0, 300), ok: false };
  return { correspondenceId: result.correspondenceId, ok: true, recipients: result.recipients };
}
