// Whether dbo.Quotes has the attribution columns (migration 117, applied by
// hand on live). Every quote approve, deselect and amount reset clears them
// (CLEAR_ATTRIBUTION in functions/quotes.ts); until 117 is applied, naming
// them would fail the whole write and every quote approval would 500.
//
// Only a positive answer is remembered (U8's buildingCategoryColumn.ts): a
// missing column is probed again on the next call, so applying 117 takes
// effect without a restart.

import type { Connection } from "tedious";
import { executeQuery } from "./db";

let columnExists = false;

export async function quoteAttributionColumnExists(connection: Connection): Promise<boolean> {
  if (columnExists) return true;
  const probe = await executeQuery(connection, "SELECT COL_LENGTH('dbo.Quotes', 'ApprovalAttributedToUserID') AS Len");
  if (probe[0]?.Len == null) return false;
  columnExists = true;
  return true;
}

/** Forget a positive answer. For tests only. */
export function resetQuoteAttributionColumnProbe(): void {
  columnExists = false;
}
