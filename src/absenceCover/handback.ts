// The handback: when someone is back, what moved while they were away, what is still
// with the cover, and a one-tap take-back. Taking back is the person's own act, logged
// as `taken_back` (a row that runs from the cover to the person and names the move it
// undoes). Only a move that changed who holds the item can be taken back; an item
// pushed up its escalation ladder, or a notice about a quote, cannot, and says so.

import { TYPES, type Connection } from "tedious";
import { executeQuery } from "../db";
import { inTransaction } from "../rentReview/store";
import type { CoverCaller } from "./access";
import { getCoverAction, insertCoverAction, listRecentActions, type CoverActionRow } from "./coverActionStore";
import { coverError } from "./errors";
import { probeEmailColumns } from "./inventory/emails";
import { canTakeBack, MOVE_KIND_OF, MOVERS } from "./moves/domain";
import { MoveRefused } from "./moves/types";
import { loadAbsences } from "./view";
import type { AbsenceKind, ItemType } from "./types";

const HANDBACK_DAYS = 30;

export interface HandbackItemDto {
  absenceKind: AbsenceKind;
  action: "escalated" | "reassigned";
  at: string;
  canTakeBack: boolean;
  coverActionId: number;
  coverName: string;
  itemId: string;
  itemType: ItemType;
  label: string;
  reason: string;
  /** with_cover: still with them. done: finished, or moved on since (nothing to take back). */
  status: "done" | "with_cover";
}

export interface HandbackDto {
  items: HandbackItemDto[];
  /** False while they are still away: the summary is for when they are back. */
  returned: boolean;
}

const IDS = (rows: readonly CoverActionRow[]): { params: { name: string; type: typeof TYPES.Int; value: number }[]; placeholders: string } => ({
  placeholders: rows.map((_, index) => `@I${index}`).join(", ") || "NULL",
  params: rows.map((row, index) => ({ name: `I${index}`, type: TYPES.Int, value: Number(row.itemId) })),
});

/** The ids (as text) of the rows whose item is still with the person it was moved to. */
async function stillWithCover(connection: Connection, rows: readonly CoverActionRow[]): Promise<Set<string>> {
  const still = new Set<string>();
  const byType = (type: ItemType) => rows.filter((row) => row.itemType === type);
  const check = async (type: ItemType, sql: (placeholders: string) => string, key: string, toKey: string): Promise<void> => {
    const group = byType(type);
    if (group.length === 0) return;
    const { placeholders, params } = IDS(group);
    const found = await executeQuery(connection, sql(placeholders), params);
    for (const row of found) {
      const match = group.find((candidate) => candidate.itemId === String(row[key]) && Number(candidate.toUserId) === Number(row[toKey]));
      if (match) still.add(`${match.itemType}:${match.itemId}`);
    }
  };
  await check("job", (placeholders) => `SELECT JobID AS Id, AssignedToUserID AS Holder FROM dbo.Jobs WHERE JobID IN (${placeholders}) AND Status <> N'Done' AND IsArchived = 0`, "Id", "Holder");
  await check("escalation", (placeholders) => `SELECT EscalationId AS Id, TargetUserId AS Holder FROM dbo.Escalations WHERE EscalationId IN (${placeholders}) AND Status IN (N'open', N'acknowledged')`, "Id", "Holder");
  const decisions = byType("decision_request");
  if (decisions.length > 0) {
    const { placeholders, params } = IDS(decisions);
    const found = await executeQuery(connection, `SELECT RequestId AS Id FROM dbo.JobDecisionRequests WHERE RequestId IN (${placeholders}) AND State = N'pending'`, params);
    for (const row of found) still.add(`decision_request:${row.Id}`);
  }
  const emails = byType("email");
  if (emails.length > 0 && (await probeEmailColumns(connection)).assignedToUserId) {
    const { placeholders, params } = IDS(emails);
    const found = await executeQuery(
      connection,
      `SELECT EmailID AS Id, AssignedToUserId AS Holder FROM dbo.Emails WHERE EmailID IN (${placeholders}) AND Status NOT IN (N'promoted', N'archived')`,
      params,
    );
    for (const row of found) {
      const match = emails.find((candidate) => candidate.itemId === String(row.Id) && Number(candidate.toUserId) === Number(row.Holder));
      if (match) still.add(`email:${match.itemId}`);
    }
  }
  const approvals = byType("approval");
  if (approvals.length > 0) {
    const { placeholders, params } = IDS(approvals);
    const found = await executeQuery(connection, `SELECT QuoteID AS Id FROM dbo.Quotes WHERE QuoteID IN (${placeholders}) AND Status IN (N'awaiting_approval', N'awaiting_director')`, params);
    for (const row of found) still.add(`approval:${row.Id}`);
  }
  return still;
}

export async function buildHandback(connection: Connection, caller: CoverCaller): Promise<HandbackDto> {
  const absences = await loadAbsences(connection);
  const returned = !absences.absent.some((person) => person.userId === caller.userId);
  const recent = await listRecentActions(connection, HANDBACK_DAYS);
  const takenBack = new Set(recent.filter((row) => row.action === "taken_back" && row.relatedActionId !== null).map((row) => row.relatedActionId as number));
  const mine = recent.filter((row) => row.fromUserId === caller.userId && (row.action === "reassigned" || row.action === "escalated") && !row.dryRun && !takenBack.has(row.coverActionId));
  const names = new Map(absences.state.directory.map((user) => [user.userId, user.name]));
  const still = await stillWithCover(connection, mine);
  return {
    items: mine.map((row): HandbackItemDto => {
      const withCover = still.has(`${row.itemType}:${row.itemId}`);
      return {
        absenceKind: row.absenceKind,
        action: row.action as "escalated" | "reassigned",
        at: row.createdAt.toISOString(),
        canTakeBack: withCover && row.action === "reassigned" && canTakeBack(MOVE_KIND_OF[row.itemType]),
        coverActionId: row.coverActionId,
        coverName: row.toUserId === null ? "the next person up" : (names.get(row.toUserId) ?? "a colleague"),
        itemId: row.itemId,
        itemType: row.itemType,
        label: row.itemLabel,
        reason: row.reasonText,
        status: withCover ? "with_cover" : "done",
      };
    }),
    returned,
  };
}

export async function takeBackItem(connection: Connection, caller: CoverCaller, coverActionId: number): Promise<{ coverActionId: number }> {
  const row = await getCoverAction(connection, coverActionId);
  if (!row || row.fromUserId !== caller.userId || row.dryRun) throw coverError.notFound("That move is not one of yours.");
  if (row.action !== "reassigned") throw coverError.refused("cannot_take_back", "This was pushed up to the next person rather than handed to a cover, so it cannot be taken back here.");
  const mover = MOVERS[MOVE_KIND_OF[row.itemType]];
  if (!mover || row.toUserId === null) throw coverError.refused("cannot_take_back", "This only told someone, so there is nothing to take back.");
  const already = await executeQuery(connection, `SELECT 1 AS Found FROM dbo.CoverActions WHERE RelatedActionId = @Id AND Action = N'taken_back'`, [
    { name: "Id", type: TYPES.BigInt, value: coverActionId },
  ]);
  if (already.length > 0) throw coverError.changed("You have already taken this back.");
  const coverName = (await executeQuery(connection, `SELECT DisplayName FROM dbo.AppUsers WHERE UserID = @Id`, [{ name: "Id", type: TYPES.Int, value: row.toUserId }]))[0]?.DisplayName;
  const reason = `${caller.name} is back and took this back`;
  const id = await inTransaction(connection, async () => {
    const moved = await mover(connection, {
      actorName: caller.name,
      detail: {},
      from: { name: String(coverName ?? "the cover"), userId: row.toUserId as number },
      itemId: row.itemId,
      reason,
      takeBack: true,
      to: { name: caller.name, userId: caller.userId },
    });
    if (!moved) throw new MoveRefused();
    return insertCoverAction(connection, {
      absenceKind: row.absenceKind,
      absenceRef: row.absenceRef,
      action: "taken_back",
      actor: { kind: "user", userId: caller.userId },
      actorName: caller.name,
      dueAt: row.dueAt,
      fromUserId: row.toUserId as number,
      importance: row.importance,
      itemId: row.itemId,
      itemLabel: row.itemLabel,
      itemType: row.itemType,
      reasonCode: "taken_back",
      reasonText: `${reason}.`,
      relatedActionId: coverActionId,
      returnDate: row.returnDate,
      runId: null,
      toUserId: caller.userId,
    });
  }).catch((error: unknown) => {
    if (error instanceof MoveRefused) return null;
    throw error;
  });
  if (id === null) throw coverError.changed(`This is no longer with ${coverName ?? "the cover"} (it may be finished), so there is nothing to take back.`);
  return { coverActionId: id };
}
