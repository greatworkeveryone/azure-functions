// Johanne's MYOB controls (dbo.MyobControls, migration 124). For now, the
// client's boot guard (sprint M7): no request reaches a company file whose
// controls have never been set up, and a table that can't be read refuses
// too. Sprint M1 extends this to the per-operation switches, caps and pause.

import { TYPES } from "tedious";
import { closeConnection, createServiceRequestConnection, executeQuery } from "./db";
import { MyobRequestRefusedError } from "./myob-errors";

/** `companyFileId` is the file in the URL; null (the file list) checks the configured file. */
export async function assertMyobControlsPresent(companyFileId: string | null): Promise<void> {
  const file = (companyFileId ?? process.env.MYOB_COMPANY_FILE_ID?.trim() ?? "").toLowerCase();
  if (!file) {
    throw new MyobRequestRefusedError("controls", "MYOB is off: no company file is configured (MYOB_COMPANY_FILE_ID)");
  }
  let present: boolean;
  try {
    const connection = await createServiceRequestConnection();
    try {
      const rows = await executeQuery(
        connection,
        `SELECT TOP 1 1 AS Present FROM dbo.MyobControls WHERE CompanyFileId = @CompanyFileId`,
        [{ name: "CompanyFileId", type: TYPES.NVarChar, value: file }],
      );
      present = rows.length > 0;
    } finally {
      closeConnection(connection);
    }
  } catch (error) {
    throw new MyobRequestRefusedError(
      "controls",
      `MYOB is off: its controls could not be read (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  if (!present) {
    throw new MyobRequestRefusedError(
      "controls",
      `MYOB is off for company file ${file}: the CFO's controls for it have not been set up`,
    );
  }
}
