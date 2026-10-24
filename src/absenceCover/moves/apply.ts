// Carries out one decision of the cover engine, or of a manager, and writes its
// ledger row. A move that changes who has an item does both in ONE transaction
// (the domain's own write, the CoverActions row, and the notice to the cover), so
// there is no move without a ledger row and no ledger row for a move that did not
// happen. A suggestion or a "keep" is only the ledger row.
//
// The one exception is an escalation pushed up its own ladder: the escalation engine
// opens its own transaction for that (and writes its own ledger rows, naming
// "Floorplan" as who did it), so the CoverActions row follows it straight after.
//
// Nothing here approves, answers or decides: a move changes who holds the item.

import type { Connection } from "tedious";
import { escalateFurther } from "../../escalation/engine";
import { EscalationError } from "../../escalation/errors";
import { roleLabel } from "../../escalation/roles";
import { inTransaction } from "../../rentReview/store";
import { insertCoverAction } from "../coverActionStore";
import { neutralReason } from "../absence";
import { COVER_ACTOR_NAME, type AbsentPerson, type CoverActionKind, type CoverItem } from "../types";
import { MOVERS } from "./domain";
import { raiseCoverNotice } from "./notice";
import { MoveRefused, type MoveActor } from "./types";

export interface ApplyInput {
  absent: Pick<AbsentPerson, "kind" | "name" | "ref" | "returnDate" | "userId">;
  action: Exclude<CoverActionKind, "taken_back">;
  actor: MoveActor;
  cover: { name: string; userId: number } | null;
  dryRun?: boolean;
  item: CoverItem;
  reasonCode: string;
  reasonText: string;
  runId: string | null;
}

export type ApplyResult =
  | { announce: () => Promise<void>; coverActionId: number; status: "applied"; toUserId: number | null }
  | { reason: "changed" | "no_further_level"; status: "skipped" };

const nameOf = (actor: MoveActor): string => (actor.kind === "system" ? COVER_ACTOR_NAME : actor.name);
const NOTHING_TO_SEND = async (): Promise<void> => undefined;

export function ledgerRowFor(input: ApplyInput, toUserId: number | null) {
  const { absent, actor, item } = input;
  return {
    absenceKind: absent.kind,
    absenceRef: absent.ref,
    action: input.action,
    actor: actor.kind === "system" ? ({ kind: "system" } as const) : ({ kind: "user", userId: actor.userId } as const),
    actorName: nameOf(actor),
    dryRun: input.dryRun === true,
    dueAt: item.dueAt,
    fromUserId: absent.userId,
    importance: item.importance,
    itemId: item.id,
    itemLabel: item.label,
    itemType: item.type,
    reasonCode: input.reasonCode,
    reasonText: input.reasonText,
    returnDate: absent.returnDate,
    runId: input.runId,
    toUserId,
  };
}

async function pushUpTheLadder(connection: Connection, input: ApplyInput): Promise<ApplyResult> {
  let next;
  try {
    next = await escalateFurther(connection, {
      actor: { kind: "system", name: COVER_ACTOR_NAME },
      code: "escalated",
      escalationId: Number(input.item.id),
      expectedRowVersion: typeof input.item.detail.rowVersion === "string" ? input.item.detail.rowVersion : undefined,
      mode: "next_level",
      note: neutralReason(input.absent),
    });
  } catch (error) {
    if (error instanceof EscalationError && (error.code === "no_further_level" || error.code === "stale" || error.code === "not_live")) {
      return { reason: error.code === "no_further_level" ? "no_further_level" : "changed", status: "skipped" };
    }
    throw error;
  }
  const toUserId = next.next.targetUserId;
  const where = toUserId === null ? roleLabel(next.next.targetRole) : "";
  const text = where ? `${input.reasonText} It went up to ${where}.` : input.reasonText;
  const coverActionId = await inTransaction(connection, () => insertCoverAction(connection, ledgerRowFor({ ...input, reasonText: text }, toUserId)));
  return { announce: NOTHING_TO_SEND, coverActionId, status: "applied", toUserId };
}

export async function applyCoverAction(connection: Connection, input: ApplyInput): Promise<ApplyResult> {
  const { action, cover, item } = input;
  if (action === "suggested" || action === "kept") {
    const coverActionId = await inTransaction(connection, () => insertCoverAction(connection, ledgerRowFor(input, cover?.userId ?? null)));
    return { announce: NOTHING_TO_SEND, coverActionId, status: "applied", toUserId: cover?.userId ?? null };
  }
  if (!cover) throw new Error("A move needs a cover");
  if (action === "escalated" && item.type === "escalation") return pushUpTheLadder(connection, input);

  const mover = MOVERS[item.move];
  if (item.move !== "notice" && !mover) throw new Error(`Items of type ${item.type} cannot be moved from here`);
  let announce: () => Promise<void> = NOTHING_TO_SEND;
  const moved = await inTransaction(connection, async () => {
    if (mover) {
      const ok = await mover(connection, {
        actorName: nameOf(input.actor),
        detail: item.detail,
        from: { name: input.absent.name, userId: input.absent.userId },
        itemId: item.id,
        reason: neutralReason(input.absent),
        to: cover,
      });
      if (!ok) throw new MoveRefused();
    }
    const coverActionId = await insertCoverAction(connection, ledgerRowFor(input, cover.userId));
    announce = await raiseCoverNotice(connection, { coverActionId, deepLink: item.deepLink, toUserId: cover.userId });
    return coverActionId;
  }).catch((error: unknown) => {
    if (error instanceof MoveRefused) return null;
    throw error;
  });
  if (moved === null) return { reason: "changed", status: "skipped" };
  return { announce, coverActionId: moved, status: "applied", toUserId: cover.userId };
}

