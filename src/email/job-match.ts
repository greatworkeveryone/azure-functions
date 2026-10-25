// Deterministic email -> job match with a database step. jobIdFromText reads
// the job id out of legacy document numbers; Johanne-format PO numbers
// (66Sm261013) carry none, so those are looked up against PurchaseOrders.

import { Connection, TYPES } from "tedious";
import { executeQuery } from "../db";
import { jobIdFromText, poNumbersFromText } from "./job-ref";

// A reply quoting a dozen PO numbers is not worth a dozen round trips.
const MAX_PO_LOOKUPS = 5;

export async function matchJobId(
  connection: Connection,
  subject: string | null | undefined,
  body: string | null | undefined,
): Promise<number | null> {
  const direct = jobIdFromText(subject, body);
  if (direct !== null) return direct;

  for (const poNumber of poNumbersFromText(subject, body).slice(0, MAX_PO_LOOKUPS)) {
    const rows = await executeQuery(
      connection,
      "SELECT DISTINCT JobID FROM PurchaseOrders WHERE PONumber = @PONumber",
      [{ name: "PONumber", type: TYPES.NVarChar, value: poNumber }],
    );
    // Linking to the wrong job is worse than not linking: only a number that
    // belongs to exactly one job counts.
    if (rows.length === 1) return rows[0].JobID as number;
  }
  return null;
}
