// Shared cap on Workflows posts: at most WORKFLOWS_CAP per rolling WORKFLOWS_WINDOW_MINUTES
// across every instance (Microsoft's own limit is 25 per 5 minutes per connection). The count
// is SQL (dbo.AlertSendLog, migration 159) because Flex Consumption is multi-instance.
//
// A slot is claimed BEFORE the post (an attempt counts, a 5xx may have landed). While the
// table doesn't exist yet no cap can be enforced, so no slot is given and the alert goes by
// email: fail-safe over fail-open.

import { TYPES, type Connection } from "tedious";
import { executeQuery } from "../db";

export const WORKFLOWS_CAP = 20;
export const WORKFLOWS_WINDOW_MINUTES = 5;
const CHANNEL = "workflows";

// Nothing deletes (database-safety rule 2); rows are tiny, and pruning would be its own reviewed job.
// UPDLOCK + HOLDLOCK serialise concurrent claims on the range, so two instances can't both take the last slot.
export const CLAIM_SLOT_SQL = `INSERT INTO dbo.AlertSendLog (Channel, SentAt)
SELECT @Channel, SYSUTCDATETIME()
WHERE (SELECT COUNT(*) FROM dbo.AlertSendLog WITH (UPDLOCK, HOLDLOCK)
       WHERE Channel = @Channel AND SentAt > DATEADD(MINUTE, -@WindowMinutes, SYSUTCDATETIME())) < @Cap;
SELECT @@ROWCOUNT AS Claimed;`;

let tableExists = false;

async function alertSendLogExists(connection: Connection): Promise<boolean> {
  if (tableExists) return true;
  const probe = await executeQuery(connection, "SELECT OBJECT_ID(N'dbo.AlertSendLog', N'U') AS Id");
  if (probe[0]?.Id == null) return false;
  tableExists = true;
  return true;
}

/** True when a post may go now (and is counted); false when over the cap or the table is absent. Never throws. */
export async function claimWorkflowsSlot(connection: Connection): Promise<boolean> {
  try {
    if (!(await alertSendLogExists(connection))) return false;
    const rows = await executeQuery(connection, CLAIM_SLOT_SQL, [
      { name: "Channel", type: TYPES.NVarChar, value: CHANNEL },
      { name: "WindowMinutes", type: TYPES.Int, value: WORKFLOWS_WINDOW_MINUTES },
      { name: "Cap", type: TYPES.Int, value: WORKFLOWS_CAP },
    ]);
    return Number(rows[0]?.Claimed) === 1;
  } catch {
    return false;
  }
}

/** Forget a positive table probe. For tests only. */
export function resetAlertSendLogProbe(): void {
  tableExists = false;
}
