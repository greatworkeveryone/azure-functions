import type { Connection } from "tedious";
import { TYPES } from "tedious";
import { executeQuery } from "./db";
import type { LedgerActor, LedgerAttribution } from "./ledger/types";
import { raiseWithin } from "./escalation/engine";
import "./escalation/adapters";

export async function declineDirector(connection: Connection, actor: LedgerActor, required: boolean, userId: unknown): Promise<LedgerAttribution | null> {
  if (!required || (actor.kind === "user" && actor.role === "director")) return null;
  if (typeof userId !== "number" || !Number.isInteger(userId) || userId < 1) return null;
  const rows = await executeQuery(connection,
    "SELECT UserID, DisplayName FROM dbo.AppUsers WITH (HOLDLOCK) WHERE UserID=@UserId AND IsActive=1 AND Role='director'", [
      { name: "UserId", type: TYPES.Int, value: userId },
    ]);
  return rows[0] ? { userId: Number(rows[0].UserID), name: String(rows[0].DisplayName), role: "director" } : null;
}
export function needsDeclineDirector(actor: LedgerActor, required: boolean): boolean {
  return required && !(actor.kind === "user" && actor.role === "director");
}
export const DIRECTOR_ATTRIBUTION_REQUIRED = { status: 422, jsonBody: { code: "decline_director_required", error: "Name the active director who verbally decided to decline this item. Directors will be notified in Floorplan." } };

export async function notifyProxyDecline(connection: Connection, input: { actor: LedgerActor; director: LedgerAttribution; kind: "quote" | "invoice"; id: number; jobId: number; reason: string | null }): Promise<void> {
  await raiseWithin(connection, {
    actor: input.actor, policyKey: "job.director_proxy_decline", subjectType: "review_notice",
    subjectId: `${input.kind}:${input.id}@${input.jobId}`,
    summary: `${input.actor.name} recorded a verbal decline by ${input.director.name} for ${input.kind} #${input.id}`,
    note: input.reason, skipConditionCheck: true,
  });
}
