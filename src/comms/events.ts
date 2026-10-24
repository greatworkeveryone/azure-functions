// CorrespondenceEvents: the append-only record of every status change (migration 108).
// This file only ever INSERTs and SELECTs on the table; a guard test
// (comms-events-append-only.test.ts) fails if any code anywhere updates or deletes it,
// and the table refuses it itself through a trigger.

import { TYPES, type Connection } from "tedious";
import { executeQuery } from "../db";

export type EventActor = { kind: "system"; name: string } | { kind: "user"; name: string; oid: string };

export interface CommsEvent {
  actor: EventActor;
  correspondenceId: number;
  /** An error CODE (never provider text). */
  errorCode?: string | null;
  detail?: string | null;
  fromStatus: string | null;
  recipientId?: number | null;
  toStatus: string;
  type: "job" | "recipient";
}

export interface StoredEvent {
  actorName: string;
  createdAt: string;
  detail: string | null;
  errorCode: string | null;
  fromStatus: string | null;
  recipientId: number | null;
  toStatus: string;
  type: "job" | "recipient";
}

const INSERT_EVENT = `INSERT INTO dbo.CorrespondenceEvents
    (CorrespondenceId, RecipientId, EventType, FromStatus, ToStatus, ActorKind, ActorName, ActorOid, ErrorCode, Detail)
  VALUES (@CorrespondenceId, @RecipientId, @EventType, @FromStatus, @ToStatus, @ActorKind, @ActorName, @ActorOid, @ErrorCode, @Detail)`;

const SELECT_EVENTS = `SELECT TOP (@Limit) RecipientId, EventType, FromStatus, ToStatus, ActorName, ErrorCode, Detail, CreatedAt
  FROM dbo.CorrespondenceEvents WHERE CorrespondenceId = @CorrespondenceId ORDER BY EventId`;

export async function appendEvent(connection: Connection, event: CommsEvent): Promise<void> {
  await executeQuery(connection, INSERT_EVENT, [
    { name: "CorrespondenceId", type: TYPES.Int, value: event.correspondenceId },
    { name: "RecipientId", type: TYPES.Int, value: event.recipientId ?? null },
    { name: "EventType", type: TYPES.VarChar, value: event.type },
    { name: "FromStatus", type: TYPES.VarChar, value: event.fromStatus },
    { name: "ToStatus", type: TYPES.VarChar, value: event.toStatus },
    { name: "ActorKind", type: TYPES.VarChar, value: event.actor.kind },
    { name: "ActorName", type: TYPES.NVarChar, value: event.actor.name.slice(0, 200) },
    { name: "ActorOid", type: TYPES.NVarChar, value: event.actor.kind === "user" ? event.actor.oid : null },
    { name: "ErrorCode", type: TYPES.VarChar, value: event.errorCode ?? null },
    { name: "Detail", type: TYPES.NVarChar, value: event.detail ? event.detail.slice(0, 500) : null },
  ]);
}

export async function readEvents(connection: Connection, correspondenceId: number, limit = 500): Promise<StoredEvent[]> {
  const rows = await executeQuery(connection, SELECT_EVENTS, [
    { name: "CorrespondenceId", type: TYPES.Int, value: correspondenceId },
    { name: "Limit", type: TYPES.Int, value: limit },
  ]);
  return rows.map((row) => ({
    actorName: String(row.ActorName),
    createdAt: new Date(row.CreatedAt as Date).toISOString(),
    detail: (row.Detail as string | null) ?? null,
    errorCode: (row.ErrorCode as string | null) ?? null,
    fromStatus: (row.FromStatus as string | null) ?? null,
    recipientId: row.RecipientId === null || row.RecipientId === undefined ? null : Number(row.RecipientId),
    toStatus: String(row.ToStatus),
    type: row.EventType as "job" | "recipient",
  }));
}
