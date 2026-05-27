// keyPlannerSync — eager + idempotent reconciler for the lost-key Planner task.
//
//   • lost_key_reported  — Keys.Status = 'lost' AND NOT IsDeleted
//
// Call syncKeyLostReportedStandalone(keyId) after reportKeyLost / restoreKey /
// deleteKey commits to keep MS Planner in sync. The standalone wrapper opens
// its own service connection + loads facilities group members and swallows
// errors so the caller's HTTP response never fails because Planner is down.

import { TYPES } from "tedious";
import type { Connection } from "tedious";
import { closeConnection, createServiceConnection, executeQuery } from "./db";
import { reconcileTask } from "./jobPlannerSync";
import { graphGetGroupMembers } from "./planner";
import { Sentry } from "./sentry";
import {
  addDaysUTC,
  buildLostKeyTaskDescription,
  buildTaskTitle,
  toIsoDateString,
  type PlannerLostKeyRow,
} from "./plannerHelpers";

type LogFn = (msg: string) => void;

export interface KeysSyncDeps {
  connection: Connection;
  facilitiesMembers: string[];
  appBaseUrl: string;
  log?: LogFn;
}

interface KeyRow {
  Id: number;
  KeyNumber: string;
  BuildingName: string;
  Status: string;
  IsDeleted: boolean | number;
  LostAt: Date | null;
  LostByName: string | null;
  LostComment: string | null;
  TenancyName: string | null;
}

export async function syncKeyLostReported(
  keyId: number,
  deps: KeysSyncDeps,
): Promise<void> {
  const { connection, facilitiesMembers, appBaseUrl, log } = deps;

  // Mirror the column/join pattern from src/functions/keys.ts KEY_COLUMNS:
  //   k.BuildingId → b.BuildingID, k.TenancyId → t.TenantID (LegalName AS TenancyName).
  const rows = (await executeQuery(
    connection,
    `SELECT k.Id, k.KeyNumber, b.BuildingName,
            t.LegalName AS TenancyName,
            k.Status, k.IsDeleted,
            k.LostAt, k.LostByName, k.LostComment
     FROM dbo.Keys k
     JOIN dbo.Buildings b ON b.BuildingID = k.BuildingId
     LEFT JOIN dbo.Tenants t ON t.TenantID = k.TenancyId
     WHERE k.Id = @Id`,
    [{ name: "Id", type: TYPES.Int, value: keyId }],
  )) as unknown as KeyRow[];

  const row = rows[0];
  if (!row) {
    log?.(`syncKeyLostReported: key ${keyId} not found — skipping`);
    return;
  }

  const isDeleted = row.IsDeleted === true || row.IsDeleted === 1;
  const shouldHaveTask = row.Status === "lost" && !isDeleted;

  const taskRow: PlannerLostKeyRow = {
    KeyId: row.Id,
    KeyNumber: row.KeyNumber,
    BuildingName: row.BuildingName,
    LostAt: row.LostAt,
    LostByName: row.LostByName,
    LostComment: row.LostComment,
    TenancyName: row.TenancyName,
  };

  const dueDate = toIsoDateString(addDaysUTC(new Date(), 3));
  const displayName = `${row.KeyNumber} at ${row.BuildingName}`;

  await reconcileTask({
    connection,
    entityType: "key",
    entityId: keyId,
    triggerType: "lost_key_reported",
    shouldHaveTask,
    planType: "facilities",
    title: buildTaskTitle(displayName, "lost_key_reported", 0),
    description: buildLostKeyTaskDescription(taskRow, appBaseUrl),
    dueDate,
    assigneeIds: facilitiesMembers,
    log,
  });
}

// ── Standalone wrapper ────────────────────────────────────────────────────────
// Opens its own service connection, loads the facilities group members, and
// swallows all errors so the caller's HTTP response is never affected by
// Planner being unavailable. Mirrors syncJobActionTriggersStandalone.

export async function syncKeyLostReportedStandalone(
  keyId: number,
  log?: LogFn,
): Promise<void> {
  const { PLANNER_FACILITIES_GROUP_ID, APP_BASE_URL } = process.env;

  if (!PLANNER_FACILITIES_GROUP_ID || !APP_BASE_URL) {
    log?.(
      "syncKeyLostReportedStandalone: missing required env (facilities group or APP_BASE_URL) — skipping",
    );
    return;
  }

  let connection: Connection | undefined;
  try {
    const facilitiesMembers = await graphGetGroupMembers(PLANNER_FACILITIES_GROUP_ID);
    connection = await createServiceConnection();
    await syncKeyLostReported(keyId, {
      connection,
      facilitiesMembers,
      appBaseUrl: APP_BASE_URL,
      log,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log?.(`syncKeyLostReportedStandalone failed for key ${keyId}: ${message}`);
    Sentry.captureException(err, {
      tags: {
        source: "key_planner_sync_eager",
        trigger: "lost_key_reported",
        keyId: String(keyId),
      },
    });
  } finally {
    if (connection) closeConnection(connection);
  }
}
