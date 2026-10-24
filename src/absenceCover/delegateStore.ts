// dbo.CoverDelegates (migration 177): "who covers for me". A nomination is ended,
// never deleted (ArchivedAt, ArchivedBy, ArchivedReason).

import { TYPES, type Connection } from "tedious";
import { executeQuery, type SqlRow } from "../db";
import { rowVersionToBuffer, rowVersionToText } from "../escalation/store";
import type { CoverDelegate } from "./types";

export interface DelegateRow extends CoverDelegate {
  archivedAt: Date | null;
  createdAt: Date;
  createdBy: string;
  delegateName: string;
  rowVersion: string;
  userName: string;
}

const COLUMNS = `d.CoverDelegateId, d.UserId, d.DelegateUserId, CONVERT(VARCHAR(10), d.FromDate, 23) AS FromDate,
  CONVERT(VARCHAR(10), d.ToDate, 23) AS ToDate, d.LeaveRequestId, d.CreatedBy, d.CreatedAt, d.ArchivedAt, d.RowVersion,
  u.DisplayName AS UserName, p.DisplayName AS DelegateName`;
const FROM = `FROM dbo.CoverDelegates d
  INNER JOIN dbo.AppUsers u ON u.UserID = d.UserId
  INNER JOIN dbo.AppUsers p ON p.UserID = d.DelegateUserId`;

export function toDelegateRow(raw: SqlRow): DelegateRow {
  return {
    archivedAt: raw.ArchivedAt instanceof Date ? raw.ArchivedAt : null,
    coverDelegateId: Number(raw.CoverDelegateId),
    createdAt: raw.CreatedAt as Date,
    createdBy: String(raw.CreatedBy),
    delegateName: String(raw.DelegateName ?? ""),
    delegateUserId: Number(raw.DelegateUserId),
    fromDate: String(raw.FromDate),
    leaveRequestId: raw.LeaveRequestId === null || raw.LeaveRequestId === undefined ? null : Number(raw.LeaveRequestId),
    rowVersion: rowVersionToText(raw.RowVersion),
    toDate: String(raw.ToDate),
    userId: Number(raw.UserId),
    userName: String(raw.UserName ?? ""),
  };
}

/** Nominations in force on a Darwin date: the engine's cover choice reads these. */
export async function listDelegatesOn(connection: Connection, date: string): Promise<DelegateRow[]> {
  const rows = await executeQuery(
    connection,
    `SELECT ${COLUMNS} ${FROM} WHERE d.ArchivedAt IS NULL AND d.FromDate <= @Date AND d.ToDate >= @Date`,
    [{ name: "Date", type: TYPES.Date, value: new Date(`${date}T00:00:00Z`) }],
  );
  return rows.map(toDelegateRow);
}

/** Live nominations that have not ended yet, for one person or for everyone. */
export async function listUpcomingDelegates(connection: Connection, today: string, userId: number | null): Promise<DelegateRow[]> {
  const rows = await executeQuery(
    connection,
    `SELECT ${COLUMNS} ${FROM}
      WHERE d.ArchivedAt IS NULL AND d.ToDate >= @Today AND (@UserId IS NULL OR d.UserId = @UserId OR d.DelegateUserId = @UserId)
      ORDER BY d.FromDate, d.CoverDelegateId`,
    [
      { name: "Today", type: TYPES.Date, value: new Date(`${today}T00:00:00Z`) },
      { name: "UserId", type: TYPES.Int, value: userId },
    ],
  );
  return rows.map(toDelegateRow);
}

export async function getDelegate(connection: Connection, id: number, forUpdate = false): Promise<DelegateRow | null> {
  const LOCK_HINT = forUpdate ? "WITH (UPDLOCK, ROWLOCK)" : "";
  const rows = await executeQuery(
    connection,
    `SELECT ${COLUMNS} FROM dbo.CoverDelegates d ${LOCK_HINT}
       INNER JOIN dbo.AppUsers u ON u.UserID = d.UserId
       INNER JOIN dbo.AppUsers p ON p.UserID = d.DelegateUserId
      WHERE d.CoverDelegateId = @Id`,
    [{ name: "Id", type: TYPES.Int, value: id }],
  );
  return rows.length === 0 ? null : toDelegateRow(rows[0]);
}

export interface NewDelegate {
  createdBy: string;
  createdByUserId: number | null;
  delegateUserId: number;
  fromDate: string;
  leaveRequestId: number | null;
  toDate: string;
  userId: number;
}

export async function insertDelegate(connection: Connection, row: NewDelegate): Promise<number> {
  const rows = await executeQuery(
    connection,
    `INSERT INTO dbo.CoverDelegates (UserId, DelegateUserId, FromDate, ToDate, LeaveRequestId, CreatedBy, CreatedByUserId)
     OUTPUT INSERTED.CoverDelegateId
     VALUES (@UserId, @DelegateUserId, @FromDate, @ToDate, @LeaveRequestId, @CreatedBy, @CreatedByUserId)`,
    [
      { name: "UserId", type: TYPES.Int, value: row.userId },
      { name: "DelegateUserId", type: TYPES.Int, value: row.delegateUserId },
      { name: "FromDate", type: TYPES.Date, value: new Date(`${row.fromDate}T00:00:00Z`) },
      { name: "ToDate", type: TYPES.Date, value: new Date(`${row.toDate}T00:00:00Z`) },
      { name: "LeaveRequestId", type: TYPES.Int, value: row.leaveRequestId },
      { name: "CreatedBy", type: TYPES.NVarChar, value: row.createdBy },
      { name: "CreatedByUserId", type: TYPES.Int, value: row.createdByUserId },
    ],
  );
  return Number(rows[0].CoverDelegateId);
}

/** Ends a nomination if its version is still the one read. Returns false when someone else changed it first. */
export async function archiveDelegateRow(
  connection: Connection,
  id: number,
  rowVersion: string,
  by: { name: string; userId: number | null },
  reason: string,
): Promise<boolean> {
  const rows = await executeQuery(
    connection,
    `UPDATE dbo.CoverDelegates
        SET ArchivedAt = SYSUTCDATETIME(), ArchivedBy = @By, ArchivedByUserId = @ByUserId, ArchivedReason = @Reason
     OUTPUT INSERTED.CoverDelegateId
      WHERE CoverDelegateId = @Id AND ArchivedAt IS NULL AND RowVersion = @RowVersion`,
    [
      { name: "Id", type: TYPES.Int, value: id },
      { name: "RowVersion", type: TYPES.Binary, value: rowVersionToBuffer(rowVersion) },
      { name: "By", type: TYPES.NVarChar, value: by.name },
      { name: "ByUserId", type: TYPES.Int, value: by.userId },
      { name: "Reason", type: TYPES.NVarChar, value: reason.slice(0, 200) },
    ],
  );
  return rows.length > 0;
}
