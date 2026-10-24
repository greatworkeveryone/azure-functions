// A manager's one-tap decision on an item that is waiting on someone who is away:
// move it to the cover (the proposed one, or one they choose), or keep it where it
// is. The picture is read again here and the item looked up in it: what was on the
// screen is not trusted, and an item that has moved or is no longer at risk is a
// conflict. Live only (requireLive); never admin; a manager acts for their own team.
// Nothing is approved: a move changes who has the item.

import type { Connection } from "tedious";
import { inTeamOf, isAdminOnly, requireLive, type CoverCaller } from "./access";
import { type CoverMode } from "./config";
import { ineligibleReason, INELIGIBLE_TEXT } from "./eligibility";
import { coverError } from "./errors";
import { isMovable } from "./moves/domain";
import { applyCoverAction } from "./moves/apply";
import { ITEM_TYPES, type ItemType } from "./types";
import { loadLiveView } from "./view";

export interface DecideInput {
  coverUserId: number | null;
  decision: "keep" | "move";
  itemId: string;
  itemType: ItemType;
}

export function parseDecision(body: Record<string, unknown>): DecideInput {
  const { itemId, itemType, decision, coverUserId } = body;
  if (typeof itemType !== "string" || !(ITEM_TYPES as readonly string[]).includes(itemType)) throw coverError.badRequest("Say which kind of item this is.");
  if (typeof itemId !== "string" || !/^\d{1,15}$/.test(itemId)) throw coverError.badRequest("Say which item this is.");
  if (decision !== "move" && decision !== "keep") throw coverError.badRequest("Choose move or keep.");
  if (coverUserId !== undefined && coverUserId !== null && (typeof coverUserId !== "number" || !Number.isSafeInteger(coverUserId) || coverUserId < 1)) {
    throw coverError.badRequest("Choose who takes it from the list.");
  }
  return { coverUserId: (coverUserId as number | null | undefined) ?? null, decision, itemId, itemType: itemType as ItemType };
}

export async function decideCoverItem(
  connection: Connection,
  caller: CoverCaller,
  input: DecideInput,
  mode: CoverMode,
): Promise<{ coverActionId: number; decision: "keep" | "move"; toUserId: number | null }> {
  requireLive(mode);
  if (isAdminOnly(caller)) throw coverError.forbidden("Admin looks after Floorplan and does not arrange anyone's work.");
  const view = await loadLiveView(connection);
  const entry = view.plan.entries.find((candidate) => candidate.item.type === input.itemType && candidate.item.id === input.itemId);
  if (!entry) throw coverError.changed("This is no longer waiting on someone who is away.");
  if (!inTeamOf(caller, entry.absent.role)) throw coverError.forbidden("This belongs to another team's manager.");
  const actor = { kind: "user", name: caller.name, userId: caller.userId } as const;
  const base = { absent: entry.absent, actor, item: entry.item, runId: null };

  if (input.decision === "keep") {
    const done = await applyCoverAction(connection, {
      ...base,
      action: "kept",
      cover: null,
      reasonCode: "kept_by_manager",
      reasonText: `${caller.name} chose to leave this with ${entry.absent.name}.`,
    });
    if (done.status !== "applied") throw coverError.changed();
    return { coverActionId: done.coverActionId, decision: "keep", toUserId: null };
  }

  if (!isMovable(entry.item.move)) throw coverError.refused("not_movable", "This cannot be moved from here. Leave approvals follow the reporting line, which the CFO or a director changes.");
  let cover = entry.resolution.found ? entry.resolution : null;
  let action: "escalated" | "reassigned" = cover?.action ?? "reassigned";
  if (input.coverUserId !== null) {
    const person = view.context.directory.find((user) => user.userId === input.coverUserId);
    if (!person) throw coverError.refused("cover_not_active", "That person is not an active user.");
    const why = ineligibleReason(entry.item, person, view.context);
    if (why) throw coverError.refused("cover_not_eligible", `${person.name} ${INELIGIBLE_TEXT[why]}, so they cannot take this.`);
    cover = { action: "reassigned", found: true, name: person.name, role: person.role, skipped: [], source: "delegate", userId: person.userId };
    action = "reassigned";
  }
  if (!cover) throw coverError.refused("no_cover", "Nobody who may take it is available. Choose someone from the list.");
  const done = await applyCoverAction(connection, {
    ...base,
    action,
    cover,
    reasonCode: "moved_by_manager",
    reasonText: `${caller.name} moved this to ${cover.name}. ${entry.reasonText}`.slice(0, 500),
  });
  if (done.status !== "applied") throw coverError.changed();
  await done.announce().catch(() => undefined);
  return { coverActionId: done.coverActionId, decision: "move", toUserId: done.toUserId };
}
