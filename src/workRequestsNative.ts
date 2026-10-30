// Floorplan-native work requests: the writes used while pushing to myBuildings
// is switched off (config/mybuildingsSwitches.ts, TR6). A native request has a
// negative WorkRequestID (the same convention manual buildings use), so it can
// never collide with, or be overwritten by, a myBuildings id, and SourceHost
// says "floorplan". Nothing here deletes.

import type { Connection } from "tedious";
import { TYPES } from "tedious";
import { executeQuery } from "./db";
import type { CreateWorkRequestPayload } from "./mybuildings-client";

export const NATIVE_SOURCE_HOST = "floorplan";

export const isNativeWorkRequestId = (id: number): boolean => id < 0;

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;

/** Inserts a native request and returns its new WorkRequestID. */
export async function insertNativeWorkRequest(connection: Connection, body: CreateWorkRequestPayload): Promise<number> {
  const buildingId = typeof body.BuildingID === "number" ? body.BuildingID : Number.isFinite(Number(body.BuildingID)) && body.BuildingID !== undefined && body.BuildingID !== "" ? Number(body.BuildingID) : null;
  // One statement: the id is taken and used under the same lock, and the
  // UNIQUE constraint on WorkRequestID refuses a duplicate if two ever race.
  const rows = await executeQuery(
    connection,
    `INSERT INTO WorkRequests
       (WorkRequestID, BuildingID, BuildingName, LevelName, TenantName, Category, Type, SubType,
        StatusID, Status, Priority, Details, ExactLocation, ContactName, ContactPhone, ContactEmail,
        PersonAffected, LastModifiedDate, SourceHost, LastSyncedAt, CreatedAt, UpdatedAt)
     OUTPUT INSERTED.WorkRequestID
     SELECT
       (SELECT ISNULL(MIN(CASE WHEN WorkRequestID < 0 THEN WorkRequestID END), 0) - 1 FROM WorkRequests WITH (UPDLOCK, HOLDLOCK)),
       COALESCE(@BuildingID, (SELECT TOP 1 BuildingID FROM Buildings WHERE BuildingName = @BuildingName)),
       COALESCE(@BuildingName, (SELECT TOP 1 BuildingName FROM Buildings WHERE BuildingID = @BuildingID)),
       @LevelName, @TenantName, @Category, @Type, @SubType,
       (SELECT TOP 1 StatusID FROM WorkRequests WHERE Status = N'New' AND StatusID IS NOT NULL), N'New',
       @Priority, @Details, @ExactLocation, @ContactName, @ContactPhone, @ContactEmail,
       @PersonAffected, @Now, @SourceHost, NULL, GETUTCDATE(), GETUTCDATE()`,
    [
      { name: "BuildingID", type: TYPES.Int, value: buildingId },
      { name: "BuildingName", type: TYPES.NVarChar, value: text(body.BuildingName) },
      { name: "LevelName", type: TYPES.NVarChar, value: text(body.LevelName) },
      { name: "TenantName", type: TYPES.NVarChar, value: text(body.TenantName) },
      { name: "Category", type: TYPES.NVarChar, value: text(body.Category) },
      { name: "Type", type: TYPES.NVarChar, value: text(body.Type) },
      { name: "SubType", type: TYPES.NVarChar, value: text(body.SubType) },
      { name: "Priority", type: TYPES.NVarChar, value: text(body.Priority) },
      { name: "Details", type: TYPES.NVarChar, value: text(body.Details) },
      { name: "ExactLocation", type: TYPES.NVarChar, value: text(body.ExactLocation) },
      { name: "ContactName", type: TYPES.NVarChar, value: text(body.ContactName) },
      { name: "ContactPhone", type: TYPES.NVarChar, value: text(body.ContactPhone) },
      { name: "ContactEmail", type: TYPES.NVarChar, value: text(body.ContactEmail) },
      { name: "PersonAffected", type: TYPES.NVarChar, value: text(body.PersonAffected) },
      { name: "Now", type: TYPES.NVarChar, value: new Date().toISOString() },
      { name: "SourceHost", type: TYPES.NVarChar, value: NATIVE_SOURCE_HOST },
    ],
  );
  return rows[0].WorkRequestID as number;
}

export interface NativeUpdate {
  note: string | null;
  statusId: number | null;
  totalCost: number | null;
  workRequestId: number;
}

/** Local status/note/cost change; the note is appended, never replaces earlier notes. */
export async function updateWorkRequestLocally(connection: Connection, update: NativeUpdate, who: string): Promise<void> {
  const stamped = update.note ? `[${new Date().toISOString().slice(0, 16).replace("T", " ")} ${who}] ${update.note}` : null;
  await executeQuery(
    connection,
    `UPDATE WorkRequests SET
       StatusID = COALESCE(@StatusID, StatusID),
       Status = CASE WHEN @StatusID IS NULL THEN Status
                     ELSE COALESCE((SELECT TOP 1 Status FROM WorkRequests WHERE StatusID = @StatusID AND Status IS NOT NULL), Status) END,
       TotalCost = COALESCE(@TotalCost, TotalCost),
       WorkNotes = CASE WHEN @Note IS NULL THEN WorkNotes
                        ELSE CONCAT(CASE WHEN WorkNotes IS NULL OR WorkNotes = N'' THEN N'' ELSE CONCAT(WorkNotes, CHAR(10)) END, @Note) END,
       LastModifiedDate = @Now, UpdatedAt = GETUTCDATE()
     WHERE WorkRequestID = @WorkRequestID`,
    [
      { name: "WorkRequestID", type: TYPES.Int, value: update.workRequestId },
      { name: "StatusID", type: TYPES.Int, value: update.statusId },
      { name: "TotalCost", type: TYPES.Decimal, value: update.totalCost },
      { name: "Note", type: TYPES.NVarChar, value: stamped },
      { name: "Now", type: TYPES.NVarChar, value: new Date().toISOString() },
    ],
  );
}
