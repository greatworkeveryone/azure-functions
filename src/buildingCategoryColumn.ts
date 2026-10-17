// Whether dbo.Buildings has the Category and OwnerName columns (migration 136,
// applied by hand on live). Until it is, the building list and the manual
// buildings screen must not name them: an unknown column fails the whole
// query, and every building picker would break.
//
// Only a positive answer is remembered. A missing column is probed again on
// the next call, so applying 136 takes effect without a restart.

import type { Connection } from "tedious";
import { executeQuery } from "./db";

let columnExists = false;

export async function buildingCategoryColumnExists(connection: Connection): Promise<boolean> {
  if (columnExists) return true;
  const probe = await executeQuery(connection, "SELECT COL_LENGTH('dbo.Buildings', 'Category') AS Len");
  if (probe[0]?.Len == null) return false;
  columnExists = true;
  return true;
}

/** Forget a positive answer. For tests only. */
export function resetBuildingCategoryColumnProbe(): void {
  columnExists = false;
}
