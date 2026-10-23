// Whether dbo.Escalations has NotificationChannel (migration 156, applied by hand on
// live). recordNotification names it only when it exists, so deploying before the
// migration doesn't fail every send's bookkeeping.
//
// Only a positive answer is remembered (as quoteAttributionColumn.ts): a missing
// column is probed again on the next call, so applying 156 needs no restart.

import type { Connection } from "tedious";
import { executeQuery } from "../db";

let columnExists = false;

export async function escalationChannelColumnExists(connection: Connection): Promise<boolean> {
  if (columnExists) return true;
  const probe = await executeQuery(connection, "SELECT COL_LENGTH('dbo.Escalations', 'NotificationChannel') AS Len");
  if (probe[0]?.Len == null) return false;
  columnExists = true;
  return true;
}

/** Forget a positive answer. For tests only. */
export function resetEscalationChannelColumnProbe(): void {
  columnExists = false;
}
