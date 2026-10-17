// Tells myobRequest which MYOB records Floorplan created: a PUT is allowed only
// for a uid in MyobProposals from a verified create of the same kind, in the
// same company file (decision 11, as Connor reads it). Installed when the send
// pipeline loads, which is the only code that issues a PUT.

import { TYPES } from "tedious";
import { closeConnection, createServiceRequestConnection, executeQuery } from "../db";
import { setFloorplanRecordLookup, type FloorplanRecordQuery } from "../myob-request-guard";

const CREATED_BY: Record<string, string> = { "orders.update": "orders.create", "quotes.update": "quotes.create" };

export async function isFloorplanRecord(query: FloorplanRecordQuery): Promise<boolean> {
  const createOperation = CREATED_BY[query.operation];
  if (!createOperation) return false;
  const connection = await createServiceRequestConnection();
  try {
    const rows = await executeQuery(
      connection,
      `SELECT TOP 1 1 AS Ours FROM dbo.MyobProposals
        WHERE CompanyFileId = @CompanyFileId AND MyobUid = @MyobUid AND Operation = @Operation AND State = N'verified'`,
      [
        { name: "CompanyFileId", type: TYPES.NVarChar, value: query.companyFileId },
        { name: "MyobUid", type: TYPES.NVarChar, value: query.uid },
        { name: "Operation", type: TYPES.NVarChar, value: createOperation },
      ],
    );
    return rows.length === 1;
  } finally {
    closeConnection(connection);
  }
}

export function installFloorplanRecordLookup(): void {
  setFloorplanRecordLookup(isFloorplanRecord);
}
