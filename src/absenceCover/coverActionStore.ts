// dbo.CoverActions (migration 177): the append-only ledger of the cover engine.
// This file only ever reads and appends: there is no UPDATE or DELETE on the
// table anywhere, and src/__tests__/absence-cover-append-only.test.ts keeps it so.

import { TYPES, type Connection } from "tedious";
import { executeQuery, type SqlParam, type SqlRow } from "../db";
import type { AbsenceKind, CoverActionKind, Importance, ItemType } from "./types";

export interface CoverActionRow {
  absenceKind: AbsenceKind;
  absenceRef: string;
  action: CoverActionKind;
  actorKind: "system" | "user";
  actorName: string;
  actorUserId: number | null;
  coverActionId: number;
  createdAt: Date;
  dryRun: boolean;
  dueAt: Date | null;
  fromUserId: number;
  importance: Importance;
  itemId: string;
  itemLabel: string;
  itemType: ItemType;
  reasonCode: string;
  reasonText: string;
  relatedActionId: number | null;
  returnDate: string | null;
  runId: string | null;
  toUserId: number | null;
}

export interface NewCoverAction {
  absenceKind: AbsenceKind;
  absenceRef: string;
  action: CoverActionKind;
  actor: { kind: "system" } | { kind: "user"; userId: number | null };
  actorName: string;
  dryRun?: boolean;
  dueAt: Date | null;
  fromUserId: number;
  importance: Importance;
  itemId: string;
  itemLabel: string;
  itemType: ItemType;
  reasonCode: string;
  reasonText: string;
  relatedActionId?: number | null;
  returnDate: string | null;
  runId: string | null;
  toUserId: number | null;
}

const COLUMNS = `CoverActionId, CreatedAt, ItemType, ItemId, ItemLabel, FromUserId, ToUserId, Action, ReasonCode, ReasonText,
  AbsenceKind, AbsenceRef, CONVERT(VARCHAR(10), ReturnDate, 23) AS ReturnDate, DueAt, Importance, RunId, ActorKind,
  ActorUserId, ActorName, DryRun, RelatedActionId`;

const asNumber = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));

export function toCoverActionRow(raw: SqlRow): CoverActionRow {
  return {
    absenceKind: raw.AbsenceKind as AbsenceKind,
    absenceRef: String(raw.AbsenceRef),
    action: raw.Action as CoverActionKind,
    actorKind: raw.ActorKind === "user" ? "user" : "system",
    actorName: String(raw.ActorName),
    actorUserId: asNumber(raw.ActorUserId),
    coverActionId: Number(raw.CoverActionId),
    createdAt: raw.CreatedAt as Date,
    dryRun: raw.DryRun === true || raw.DryRun === 1,
    dueAt: raw.DueAt instanceof Date ? raw.DueAt : null,
    fromUserId: Number(raw.FromUserId),
    importance: raw.Importance as Importance,
    itemId: String(raw.ItemId),
    itemLabel: String(raw.ItemLabel),
    itemType: raw.ItemType as ItemType,
    reasonCode: String(raw.ReasonCode),
    reasonText: String(raw.ReasonText),
    relatedActionId: asNumber(raw.RelatedActionId),
    returnDate: typeof raw.ReturnDate === "string" ? raw.ReturnDate : null,
    runId: typeof raw.RunId === "string" ? raw.RunId : null,
    toUserId: asNumber(raw.ToUserId),
  };
}

export const itemKey = (type: string, id: string): string => `${type}:${id}`;

/** Appends one row and returns its id. Inside the caller's transaction, so it stands or falls with the change it records. */
export async function insertCoverAction(connection: Connection, row: NewCoverAction): Promise<number> {
  const params: SqlParam[] = [
    { name: "ItemType", type: TYPES.NVarChar, value: row.itemType },
    { name: "ItemId", type: TYPES.NVarChar, value: row.itemId },
    { name: "ItemLabel", type: TYPES.NVarChar, value: row.itemLabel.slice(0, 300) },
    { name: "FromUserId", type: TYPES.Int, value: row.fromUserId },
    { name: "ToUserId", type: TYPES.Int, value: row.toUserId },
    { name: "Action", type: TYPES.NVarChar, value: row.action },
    { name: "ReasonCode", type: TYPES.NVarChar, value: row.reasonCode },
    { name: "ReasonText", type: TYPES.NVarChar, value: row.reasonText.slice(0, 500) },
    { name: "AbsenceKind", type: TYPES.NVarChar, value: row.absenceKind },
    { name: "AbsenceRef", type: TYPES.NVarChar, value: row.absenceRef },
    { name: "ReturnDate", type: TYPES.Date, value: row.returnDate === null ? null : new Date(`${row.returnDate}T00:00:00Z`) },
    { name: "DueAt", type: TYPES.DateTime2, value: row.dueAt },
    { name: "Importance", type: TYPES.NVarChar, value: row.importance },
    { name: "RunId", type: TYPES.UniqueIdentifier, value: row.runId },
    { name: "ActorKind", type: TYPES.NVarChar, value: row.actor.kind },
    { name: "ActorUserId", type: TYPES.Int, value: row.actor.kind === "user" ? row.actor.userId : null },
    { name: "ActorName", type: TYPES.NVarChar, value: row.actorName },
    { name: "DryRun", type: TYPES.Bit, value: row.dryRun === true ? 1 : 0 },
    { name: "RelatedActionId", type: TYPES.BigInt, value: row.relatedActionId ?? null },
  ];
  const rows = await executeQuery(
    connection,
    `INSERT INTO dbo.CoverActions (ItemType, ItemId, ItemLabel, FromUserId, ToUserId, Action, ReasonCode, ReasonText, AbsenceKind,
       AbsenceRef, ReturnDate, DueAt, Importance, RunId, ActorKind, ActorUserId, ActorName, DryRun, RelatedActionId)
     OUTPUT INSERTED.CoverActionId
     VALUES (@ItemType, @ItemId, @ItemLabel, @FromUserId, @ToUserId, @Action, @ReasonCode, @ReasonText, @AbsenceKind,
       @AbsenceRef, @ReturnDate, @DueAt, @Importance, @RunId, @ActorKind, @ActorUserId, @ActorName, @DryRun, @RelatedActionId)`,
    params,
  );
  return Number(rows[0].CoverActionId);
}

export async function getCoverAction(connection: Connection, coverActionId: number): Promise<CoverActionRow | null> {
  const rows = await executeQuery(connection, `SELECT ${COLUMNS} FROM dbo.CoverActions WHERE CoverActionId = @Id`, [
    { name: "Id", type: TYPES.BigInt, value: coverActionId },
  ]);
  return rows.length === 0 ? null : toCoverActionRow(rows[0]);
}

/** The latest row for every item touched in the last `days` days, by item key. */
export async function latestActionsByItem(connection: Connection, days = 90): Promise<Map<string, CoverActionRow>> {
  const rows = await executeQuery(
    connection,
    `SELECT ${COLUMNS} FROM dbo.CoverActions
      WHERE CoverActionId IN (SELECT MAX(CoverActionId) FROM dbo.CoverActions
                               WHERE CreatedAt >= DATEADD(day, -@Days, SYSUTCDATETIME()) GROUP BY ItemType, ItemId)`,
    [{ name: "Days", type: TYPES.Int, value: days }],
  );
  return new Map(rows.map(toCoverActionRow).map((row) => [itemKey(row.itemType, row.itemId), row]));
}

/** Moves and suggestions of the last `days` days, newest first (the manager's screen and the handback). */
export async function listRecentActions(connection: Connection, days = 30, limit = 500): Promise<CoverActionRow[]> {
  const rows = await executeQuery(
    connection,
    `SELECT TOP (@Limit) ${COLUMNS} FROM dbo.CoverActions
      WHERE CreatedAt >= DATEADD(day, -@Days, SYSUTCDATETIME()) ORDER BY CoverActionId DESC`,
    [
      { name: "Days", type: TYPES.Int, value: days },
      { name: "Limit", type: TYPES.Int, value: limit },
    ],
  );
  return rows.map(toCoverActionRow);
}
