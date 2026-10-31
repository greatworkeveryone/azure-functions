// What the send core reads from the environment (EB1, PLAN §13).
//
//   COMMS_SEND_ENABLED      "true" lets the queue timer send; anything else and it does nothing
//   COMMS_SEND_DRY_RUN      "true" logs and marks each recipient would-send without calling
//                           Graph (wins over COMMS_SEND_ENABLED)
//   COMMS_FROM_ADDRESS      the one sender (default notices@randazzo.properties)
//   COMMS_FROM_NAME         its display name (default Randazzo Properties)
//   COMMS_MAX_PER_MINUTE    most messages one minute may send (default 25; Exchange allows
//                           about 30 a minute per mailbox)
//   COMMS_APPROVAL_THRESHOLD  a job to more recipients than this waits for a manager (default 20)
//   TENANT_REPLY_TO         where tenants reply to link emails and status notices (default workrequests@randazzo.properties);
//                           the older TENANT_NOTICES_REPLY_TO / TENANT_LINK_REPLY_TO are still read if it is unset
//   COMMS_FOOTER_ADDRESS    postal address for the email footer; defaults to RP's (Connor, 24 Oct)
//
// DEV_EMAIL_OVERRIDE rewrites every recipient through resolveRecipient (src/email-recipient.ts).

export type CommsMode = "dry-run" | "live" | "off";

export const DEFAULT_FROM_ADDRESS = "notices@randazzo.properties";
export const DEFAULT_FROM_NAME = "Randazzo Properties";
export const DEFAULT_FOOTER_ADDRESS = "GPO Box 551, Darwin NT 0801";
export const DEFAULT_MAX_PER_MINUTE = 25;
export const DEFAULT_APPROVAL_THRESHOLD = 20;
/** Staff sign in with, and may reply from, an address on this domain. */
export const ORG_DOMAIN = "randazzo.properties";
export const MAX_ATTEMPTS = 3;
/** A recipient claimed this long ago with no outcome is treated as interrupted. */
export const STALE_SENDING_MINUTES = 10;
export const MAX_RECIPIENTS_PER_JOB = 2000;

export function commsMode(env: NodeJS.ProcessEnv = process.env): CommsMode {
  if (env.COMMS_SEND_DRY_RUN === "true") return "dry-run";
  return env.COMMS_SEND_ENABLED === "true" ? "live" : "off";
}

function wholeNumber(raw: string | undefined, fallback: number, min: number, max: number): number {
  const text = (raw ?? "").trim();
  if (!/^\d{1,7}$/.test(text)) return fallback;
  const value = Number(text);
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

export function maxPerMinute(env: NodeJS.ProcessEnv = process.env): number {
  return wholeNumber(env.COMMS_MAX_PER_MINUTE, DEFAULT_MAX_PER_MINUTE, 1, 120);
}

export function approvalThreshold(env: NodeJS.ProcessEnv = process.env): number {
  return wholeNumber(env.COMMS_APPROVAL_THRESHOLD, DEFAULT_APPROVAL_THRESHOLD, 0, MAX_RECIPIENTS_PER_JOB);
}

export function fromAddress(env: NodeJS.ProcessEnv = process.env): string {
  return env.COMMS_FROM_ADDRESS?.trim() || DEFAULT_FROM_ADDRESS;
}

export function fromName(env: NodeJS.ProcessEnv = process.env): string {
  return env.COMMS_FROM_NAME?.trim() || DEFAULT_FROM_NAME;
}

export const DEFAULT_TENANT_REPLY_TO = "workrequests@randazzo.properties";

/** The tenant-facing address (PLAN §15): tenants reply here. */
export function tenantReplyTo(env: NodeJS.ProcessEnv = process.env): string {
  return env.TENANT_REPLY_TO?.trim() || env.TENANT_NOTICES_REPLY_TO?.trim() || env.TENANT_LINK_REPLY_TO?.trim() || DEFAULT_TENANT_REPLY_TO;
}

export function footerAddress(env: NodeJS.ProcessEnv = process.env): string {
  return env.COMMS_FOOTER_ADDRESS?.trim() || DEFAULT_FOOTER_ADDRESS;
}
