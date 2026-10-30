// What actually happened to a request's acknowledgement email (TR1, PLAN §15). "Told them by email" is not the same
// as "an email went": a dry run or a switched-off send queue sends nothing. Derived from the comms job it queued, so
// it follows the real outcome and needs no extra column. The frontend mirrors the codes in src/helpers/intakeState.ts.

import type { CommsMode } from "../comms/config";

export const ACK_DELIVERIES = ["none", "waiting_approval", "queued", "sent", "dry_run", "off", "failed"] as const;
export type AckDelivery = (typeof ACK_DELIVERIES)[number];

/**
 * `via` is the stored AcknowledgedVia; `recipient` and `job` are the statuses of the queued email's recipient row and
 * job (null when there is no job). A queued email under a switched-off or dry-run queue is reported as such, since
 * that is what will happen to it.
 */
export function ackDelivery(via: unknown, recipient: unknown, job: unknown, mode: CommsMode): AckDelivery | null {
  if (via !== "email") return via === "other" ? "none" : null;
  if (recipient === "sent") return "sent";
  if (recipient === "would_send") return "dry_run";
  if (recipient === "failed" || recipient === "blocked" || recipient === "cancelled" || job === "cancelled" || job === "failed") return "failed";
  if (job === "awaiting_approval") return "waiting_approval";
  if (mode === "dry-run") return "dry_run";
  if (mode === "off") return "off";
  return "queued";
}
