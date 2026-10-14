// The CFO's say over which MYOB company files Floorplan may touch (decision
// 14, sprint M9). Only the myobController capability (role cfo) calls these;
// each change and its myob.control_change ledger row commit together in the
// caller's transaction, with her note as the reason. Rows carry a ROWVERSION,
// so a stale change is a 409. Every new file starts off.

import type { Connection } from "tedious";
import { TYPES } from "tedious";
import { executeQuery } from "./db";
import { record, type LedgerActor } from "./ledger";
import {
  FILE_COLUMNS,
  INSERTED_FILE_COLUMNS,
  toCompanyFileRow,
  type CompanyFileRow,
  type MyobFileMode,
} from "./myob-company-files-store";
import { MyobControlsError } from "./myob-controls-admin";

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STALE = "Someone else changed this company file since you loaded it. Reload and try again.";

const param = (name: string, type: (typeof TYPES)[keyof typeof TYPES], value: unknown) => ({ name, type, value });
const subject = (file: string) => ({ id: `${file}:entity`, type: "myob_control" as const });

async function findFile(tx: Connection, file: string, lock = false): Promise<CompanyFileRow | null> {
  const rows = await executeQuery(
    tx,
    lock
      ? `SELECT ${FILE_COLUMNS} FROM dbo.MyobCompanyFiles WITH (UPDLOCK, HOLDLOCK) WHERE CompanyFileId = @CompanyFileId`
      : `SELECT ${FILE_COLUMNS} FROM dbo.MyobCompanyFiles WHERE CompanyFileId = @CompanyFileId`,
    [param("CompanyFileId", TYPES.NVarChar, file)],
  );
  return rows[0] ? toCompanyFileRow(rows[0]) : null;
}

async function insertFile(
  tx: Connection,
  actor: LedgerActor,
  file: { companyFileId: string; discovered: boolean; name: string | null; note: string; uri?: string | null },
): Promise<CompanyFileRow> {
  const rows = await executeQuery(
    tx,
    `INSERT INTO dbo.MyobCompanyFiles (CompanyFileId, Name, Uri, Mode, DiscoveredAt, RegisteredBy, Note, UpdatedBy)
     OUTPUT ${INSERTED_FILE_COLUMNS}
     VALUES (@CompanyFileId, @Name, @Uri, N'off', CASE WHEN @Discovered = 1 THEN SYSUTCDATETIME() END, @By, @Note, @By)`,
    [
      param("CompanyFileId", TYPES.NVarChar, file.companyFileId),
      param("Name", TYPES.NVarChar, file.name?.slice(0, 200) ?? null),
      param("Uri", TYPES.NVarChar, file.uri?.slice(0, 500) ?? null),
      param("Discovered", TYPES.Bit, file.discovered),
      param("By", TYPES.NVarChar, actor.name.slice(0, 200)),
      param("Note", TYPES.NVarChar, file.note.slice(0, 1000)),
    ],
  );
  return toCompanyFileRow(rows[0]);
}

/** Registers a file by id (MYOB may not list cloud files): it starts off. */
export async function registerCompanyFile(
  tx: Connection,
  actor: LedgerActor,
  input: { companyFileId: string; name: string | null; note: string },
): Promise<CompanyFileRow> {
  const file = input.companyFileId.toLowerCase();
  if (await findFile(tx, file, true)) throw new MyobControlsError(409, `Company file ${file} is already registered`);
  const row = await insertFile(tx, actor, { companyFileId: file, discovered: false, name: input.name, note: input.note });
  await record(tx, {
    action: "myob.control_change",
    actor,
    after: { mode: "off", name: input.name },
    reason: input.note,
    ruleApplied: "register",
    subject: subject(file),
  });
  return row;
}

export interface FileSettingsChange {
  changes: { isDemonstration?: boolean; mode?: MyobFileMode };
  companyFileId: string;
  expectedRowVersion: string | null;
  note: string;
}

const settings = (row: CompanyFileRow) => ({ isDemonstration: row.isDemonstration, mode: row.mode });

/** Sets a file's mode and whether it is the demonstration file. */
export async function changeFileSettings(
  tx: Connection,
  actor: LedgerActor,
  input: FileSettingsChange,
): Promise<{ changed: boolean; row: CompanyFileRow }> {
  const file = input.companyFileId.toLowerCase();
  const current = await findFile(tx, file, true);
  if (!current) throw new MyobControlsError(404, `Company file ${file} is not registered with Floorplan`);
  if (input.expectedRowVersion !== current.rowVersion) throw new MyobControlsError(409, STALE);

  const next = { ...settings(current), ...input.changes };
  if (next.mode === current.mode && next.isDemonstration === current.isDemonstration) return { changed: false, row: current };
  const updated = await executeQuery(
    tx,
    `UPDATE dbo.MyobCompanyFiles
        SET Mode = @Mode, IsDemonstration = @IsDemonstration, Note = @Note, UpdatedBy = @UpdatedBy, UpdatedAt = SYSUTCDATETIME()
     OUTPUT ${INSERTED_FILE_COLUMNS}
      WHERE CompanyFileId = @CompanyFileId AND RowVersion = @RowVersion`,
    [
      param("Mode", TYPES.NVarChar, next.mode),
      param("IsDemonstration", TYPES.Bit, next.isDemonstration),
      param("Note", TYPES.NVarChar, input.note.slice(0, 1000)),
      param("UpdatedBy", TYPES.NVarChar, actor.name.slice(0, 200)),
      param("CompanyFileId", TYPES.NVarChar, file),
      param("RowVersion", TYPES.Binary, Buffer.from(current.rowVersion, "base64")),
    ],
  );
  if (!updated[0]) throw new MyobControlsError(409, STALE);
  const row = toCompanyFileRow(updated[0]);
  await record(tx, {
    action: "myob.control_change",
    actor,
    after: settings(row),
    before: settings(current),
    reason: input.note,
    ruleApplied: "mode",
    subject: subject(file),
  });
  return { changed: true, row };
}

export interface ListedFile {
  Id?: unknown;
  Name?: unknown;
  Uri?: unknown;
}

/** Records what MYOB's file list returned: unknown files are registered, off; known ones get their date. */
export async function recordDiscoveredFiles(
  tx: Connection,
  actor: LedgerActor,
  listed: readonly ListedFile[],
): Promise<{ added: string[]; seen: number }> {
  const added: string[] = [];
  let seen = 0;
  for (const entry of listed) {
    if (typeof entry.Id !== "string" || !GUID.test(entry.Id)) continue;
    seen += 1;
    const file = entry.Id.toLowerCase();
    const name = typeof entry.Name === "string" ? entry.Name : null;
    if (await findFile(tx, file, true)) {
      await executeQuery(
        tx,
        `UPDATE dbo.MyobCompanyFiles SET DiscoveredAt = SYSUTCDATETIME(), Name = COALESCE(Name, @Name) WHERE CompanyFileId = @CompanyFileId`,
        [param("Name", TYPES.NVarChar, name?.slice(0, 200) ?? null), param("CompanyFileId", TYPES.NVarChar, file)],
      );
      continue;
    }
    const uri = typeof entry.Uri === "string" ? entry.Uri : null;
    await insertFile(tx, actor, { companyFileId: file, discovered: true, name, note: "Listed by MYOB", uri });
    await record(tx, { action: "myob.control_change", actor, after: { mode: "off", name }, reason: "Listed by MYOB", ruleApplied: "discover", subject: subject(file) });
    added.push(file);
  }
  return { added, seen };
}
