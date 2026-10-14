// Whether a record is test data. Beta sprint decision 4 (13 Oct 2026): admin
// may approve, pay or mark money records only when they are test records.
//
// The flag is Jobs.IsTest, added by migration 127 (D9). Until that column
// exists every job is real, and this never names a column that isn't there.
// A quote, invoice or PO is test data when its job is.

import { TYPES, type Connection } from "tedious";
import { executeQuery } from "./db";

let flagColumnExists = false;

export async function isTestJob(connection: Connection, jobId: number): Promise<boolean> {
  if (!flagColumnExists) {
    const probe = await executeQuery(connection, "SELECT COL_LENGTH('dbo.Jobs', 'IsTest') AS Len");
    if (probe[0]?.Len == null) return false;
    flagColumnExists = true;
  }
  const rows = await executeQuery(connection, "SELECT IsTest FROM Jobs WHERE JobID = @JobID", [
    { name: "JobID", type: TYPES.Int, value: jobId },
  ]);
  const flag = rows[0]?.IsTest;
  return flag === true || flag === 1;
}
