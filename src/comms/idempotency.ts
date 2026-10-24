// Double-click guard for queueing a send (EB2). The compose screen makes one key per session and sends it
// with the queue request; a repeated submit with the same key from the same person returns the job already
// made instead of making a second.
//
// There is no column for the key (this package adds no migration), so it rides on the job's first event,
// whose detail ends " key=<key>"; the screen never sees it (readEvents strips it). The lookup narrows by
// the creator's index first. An application lock on the creator and key, held for the transaction, makes two
// requests racing in different instances take turns, so the second finds the first's committed job.

import { createHash } from "crypto";
import { TYPES, type Connection } from "tedious";
import { executeQuery } from "../db";

export const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{16,64}$/;
const WINDOW_DAYS = 7;
const MARKER = " key=";
const MARKER_AT_END = /\skey=[A-Za-z0-9_-]{16,64}$/;

/** The detail of a job's first event with the key on its end. */
export const withKeyMarker = (detail: string, key: string | null): string => (key === null ? detail : `${detail}${MARKER}${key}`);

/** The detail as a person should read it: the key is bookkeeping. */
export const stripKeyMarker = (detail: string | null): string | null => (detail === null ? null : detail.replace(MARKER_AT_END, ""));

const resourceFor = (oid: string, key: string): string => `queueCorrespondence:${createHash("sha256").update(`${oid}\n${key}`).digest("hex")}`;

/** Waits (up to 10 seconds) for any other request with this key; true once this one holds the lock. Released when the transaction ends. */
export async function takeKeyLock(connection: Connection, oid: string, key: string): Promise<boolean> {
  const [row] = await executeQuery(
    connection,
    `DECLARE @Result INT;
     EXEC @Result = sp_getapplock @Resource = @Resource, @LockMode = 'Exclusive', @LockOwner = 'Transaction', @LockTimeout = 10000;
     SELECT @Result AS Result;`,
    [{ name: "Resource", type: TYPES.NVarChar, value: resourceFor(oid, key) }],
  );
  return Number(row?.Result) >= 0;
}

/** The id of this person's job made with this key in the last week, or null. */
export async function findJobByKey(connection: Connection, oid: string, key: string): Promise<number | null> {
  const tail = `${MARKER}${key}`;
  const [row] = await executeQuery(
    connection,
    `SELECT TOP (1) c.CorrespondenceId
       FROM dbo.Correspondence c
       JOIN dbo.CorrespondenceEvents e ON e.CorrespondenceId = c.CorrespondenceId AND e.EventType = 'job' AND e.FromStatus IS NULL
      WHERE c.CreatedByOid = @Oid AND c.CreatedAt >= DATEADD(day, -@Days, SYSUTCDATETIME())
        AND RIGHT(e.Detail, @Length) = @Tail COLLATE Latin1_General_100_BIN2
      ORDER BY c.CorrespondenceId`,
    [
      { name: "Oid", type: TYPES.NVarChar, value: oid },
      { name: "Days", type: TYPES.Int, value: WINDOW_DAYS },
      { name: "Length", type: TYPES.Int, value: tail.length },
      { name: "Tail", type: TYPES.NVarChar, value: tail },
    ],
  );
  return row ? Number(row.CorrespondenceId) : null;
}
