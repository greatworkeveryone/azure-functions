// Johanne's MYOB controls, enforced inside myobRequest (decisions 7 and 14;
// sprints M1, M7, M9). First the company file's mode (MyobCompanyFiles):
//   - off, missing from the table, or unreadable → refused, reads included
//   - read → every write refused
//   - write → on to the controls
// Then every request maps to one control row of its file: reads to
// purchases.read, each write to its own operation. In order:
//   - no rows for the file (or the table can't be read) → refused: MYOB is off
//   - the file is paused → everything refused, reads included
//   - the operation is switched off → refused
//   - a write in dry run → refused as dry_run (the payload is logged, nothing sent)
//   - a write past today's allowance (DailyCap, Darwin day) → refused
// MYOB_WRITES_ENABLED, Will's master switch, is checked before this, in the guard.

import { closeConnection, createServiceRequestConnection } from "./db";
import { readFileMode, type MyobFileMode } from "./myob-company-files-store";
import { readControls, writeKey, writesToday, type ControlOperation, type ControlRow } from "./myob-controls-store";
import type { MyobOperation } from "./myob-endpoints";
import { MyobRequestRefusedError } from "./myob-errors";

const READS: ReadonlySet<MyobOperation> = new Set(["files.list", "company_file.read", "purchases.read"]);

export function controlFor(operation: MyobOperation): ControlOperation {
  return READS.has(operation) ? "purchases.read" : (operation as ControlOperation);
}

function refuse(message: string): never {
  throw new MyobRequestRefusedError("controls", message);
}

/** `companyFileId` is the file in the URL; null (the file list) means the configured file. */
export async function assertMyobControlsAllow(
  request: { companyFileId: string | null; operation: MyobOperation },
  now: Date = new Date(),
): Promise<void> {
  const file = (request.companyFileId ?? process.env.MYOB_COMPANY_FILE_ID?.trim() ?? "").toLowerCase();
  if (!file) refuse("MYOB is off: no company file is configured (MYOB_COMPANY_FILE_ID)");
  const operation = controlFor(request.operation);
  const isWrite = operation !== "purchases.read";

  let mode: MyobFileMode;
  let controls: ControlRow[];
  let used = 0;
  try {
    const connection = await createServiceRequestConnection();
    try {
      mode = await readFileMode(connection, file);
      controls = await readControls(connection, file);
      if (isWrite) used = (await writesToday(connection, now)).get(writeKey(file, operation)) ?? 0;
    } finally {
      closeConnection(connection);
    }
  } catch (error) {
    refuse(`MYOB is off for company file ${file}: its mode and controls could not be read (${error instanceof Error ? error.message : String(error)})`);
  }

  if (mode === "off") refuse(`MYOB is off for company file ${file}: the CFO has not switched this file on (Entities)`);
  if (mode === "read" && isWrite) refuse(`Company file ${file} is read only: the CFO allows reads, not writes (Entities)`);
  if (controls.length === 0) refuse(`MYOB is off for company file ${file}: the CFO's controls for it have not been set up`);
  if (controls.some((row) => row.pausedAll)) refuse(`MYOB is paused for company file ${file} by the CFO`);
  const row = controls.find((r) => r.operation === operation);
  if (!row?.enabled) refuse(`Refused by the CFO's controls: ${operation} is switched off for company file ${file}`);
  if (!isWrite) return;
  if (row.dryRun) {
    throw new MyobRequestRefusedError("dry_run", `Dry run (CFO control): ${operation} was not sent to MYOB; the payload is logged`);
  }
  if (used >= row.dailyCap) {
    refuse(`Refused by the CFO's controls: today's ${operation} allowance for company file ${file} is used (${used} of ${row.dailyCap})`);
  }
}
