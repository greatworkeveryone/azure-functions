// The email that carries a personal link: template `tenant_link_issue`, seeded as a DRAFT
// (PLAN §15: Facilities approve the wording before the first live send; sending is off until
// COMMS_SEND_ENABLED is "true" anyway). The URL is placed in the body here, after the merge,
// because the comms merge catalogue is closed and the token must never be stored in a queued
// job (which keeps its body and merge values): see issue.ts.

export const LINK_TEMPLATE_ID = "tenant_link_issue";
export const LINK_TEMPLATE_VERSION = 1;
export const LINK_TEMPLATE_STATUS = "draft";

export const LINK_SUBJECT = "Your Randazzo Properties link for reporting a problem";

export function linkBody(url: string, expiresOn: string): string {
  return [
    "Hello {{recipient.name}},",
    "",
    "This is your personal link for reporting a maintenance problem at your tenancy and checking on your requests.",
    "",
    `[Open your link](${url})`,
    "",
    `The link is just for you, so please do not forward it. It works until ${expiresOn}. If you lose it, or think someone else has it, reply to this email and we will issue a new one.`,
  ].join("\n");
}
