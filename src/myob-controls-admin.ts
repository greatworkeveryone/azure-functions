// Changing Johanne's MYOB controls (sprint M1). Only the myobController
// capability may: role cfo, never admin or director (requireRole's hierarchy
// would let them through, so handlers check isMyobController instead). Every
// change is a decision: the new values and a myob.control_change ledger row,
// with before, after and the CFO's note, commit together in the caller's
// transaction. Rows carry a ROWVERSION; a stale change is a 409.
//
// A file's seven control rows are created, all off, the first time the CFO
// sets one, and only for the configured file (MYOB_COMPANY_FILE_ID), the
// linked file, or a file already in MyobCompanyFiles (registering others is
// sprint M9's "Entities" step).

import type { Connection } from "tedious";
import { TYPES } from "tedious";
import { executeQuery } from "./db";
import { record, type LedgerActor } from "./ledger";
import {
  CONTROL_COLUMNS,
  CONTROL_OPERATIONS,
  INSERTED_CONTROL_COLUMNS,
  readControls,
  toControlRow,
  type ControlOperation,
  type ControlRow,
} from "./myob-controls-store";

export const MYOB_CONTROLLER_ROLE = "cfo";

export function isMyobController(roles: readonly string[]): boolean {
  return roles.includes(MYOB_CONTROLLER_ROLE);
}

export class MyobControlsError extends Error {
  readonly status: 400 | 404 | 409;
  constructor(status: 400 | 404 | 409, message: string) {
    super(message);
    this.name = "MyobControlsError";
    this.status = status;
  }
}

export interface ControlChanges {
  dailyCap?: number;
  dryRun?: boolean;
  enabled?: boolean;
  requireReview?: boolean;
}

export interface ControlChangeInput {
  changes: ControlChanges;
  companyFileId: string;
  /** base64 ROWVERSION the CFO was looking at; null only for a control not yet set up. */
  expectedRowVersion: string | null;
  note: string;
  operation: ControlOperation;
}

const param = (name: string, type: (typeof TYPES)[keyof typeof TYPES], value: unknown) => ({ name, type, value });

async function seedAllowed(tx: Connection, file: string): Promise<boolean> {
  if (process.env.MYOB_COMPANY_FILE_ID?.trim().toLowerCase() === file) return true;
  const rows = await executeQuery(tx, `SELECT BusinessId FROM dbo.MyobAuth WHERE Id = 1`);
  return String(rows[0]?.BusinessId ?? "").toLowerCase() === file;
}

/** Creates the file's missing control rows (all off). Returns the operations it created. */
async function ensureControls(tx: Connection, file: string, by: string): Promise<Set<ControlOperation>> {
  const existing = new Set((await readControls(tx, file)).map((r) => r.operation));
  const missing = CONTROL_OPERATIONS.filter((op) => !existing.has(op));
  if (missing.length === 0) return new Set();
  const registered = await executeQuery(tx, `SELECT 1 AS Registered FROM dbo.MyobCompanyFiles WHERE CompanyFileId = @CompanyFileId`, [
    param("CompanyFileId", TYPES.NVarChar, file),
  ]);
  if (registered.length === 0) {
    if (!(await seedAllowed(tx, file))) {
      throw new MyobControlsError(404, `Company file ${file} is not registered with Floorplan`);
    }
    await executeQuery(
      tx,
      `INSERT INTO dbo.MyobCompanyFiles (CompanyFileId, RegisteredBy, Note)
       VALUES (@CompanyFileId, @By, N'Registered when the CFO first set its controls')`,
      [param("CompanyFileId", TYPES.NVarChar, file), param("By", TYPES.NVarChar, by.slice(0, 200))],
    );
  }
  for (const operation of missing) {
    await executeQuery(
      tx,
      `INSERT INTO dbo.MyobControls (CompanyFileId, Operation, UpdatedBy)
       SELECT @CompanyFileId, @Operation, @By
        WHERE NOT EXISTS (SELECT 1 FROM dbo.MyobControls WHERE CompanyFileId = @CompanyFileId AND Operation = @Operation)`,
      [param("CompanyFileId", TYPES.NVarChar, file), param("Operation", TYPES.NVarChar, operation), param("By", TYPES.NVarChar, by.slice(0, 200))],
    );
  }
  return new Set(missing);
}

const snapshot = (row: ControlRow) => ({
  dailyCap: row.dailyCap,
  dryRun: row.dryRun,
  enabled: row.enabled,
  requireReview: row.requireReview,
});

export async function changeControl(
  tx: Connection,
  actor: LedgerActor,
  input: ControlChangeInput,
): Promise<{ changed: boolean; row: ControlRow; seeded: boolean }> {
  const file = input.companyFileId.toLowerCase();
  const created = await ensureControls(tx, file, actor.name);
  const locked = await executeQuery(
    tx,
    `SELECT ${CONTROL_COLUMNS} FROM dbo.MyobControls WITH (UPDLOCK, HOLDLOCK)
      WHERE CompanyFileId = @CompanyFileId AND Operation = @Operation`,
    [param("CompanyFileId", TYPES.NVarChar, file), param("Operation", TYPES.NVarChar, input.operation)],
  );
  if (!locked[0]) throw new MyobControlsError(404, `No ${input.operation} control for company file ${file}`);
  const current = toControlRow(locked[0]);
  if (!created.has(input.operation) && input.expectedRowVersion !== current.rowVersion) {
    throw new MyobControlsError(409, "Someone else changed this control since you loaded it. Reload and try again.");
  }

  const next = { ...snapshot(current), ...input.changes };
  if (JSON.stringify(next) === JSON.stringify(snapshot(current))) {
    return { changed: false, row: current, seeded: created.size > 0 };
  }
  const updated = await executeQuery(
    tx,
    `UPDATE dbo.MyobControls
        SET Enabled = @Enabled, DryRun = @DryRun, DailyCap = @DailyCap, RequireReview = @RequireReview,
            Note = @Note, UpdatedBy = @UpdatedBy, UpdatedAt = SYSUTCDATETIME()
     OUTPUT ${INSERTED_CONTROL_COLUMNS}
      WHERE CompanyFileId = @CompanyFileId AND Operation = @Operation AND RowVersion = @RowVersion`,
    [
      param("Enabled", TYPES.Bit, next.enabled),
      param("DryRun", TYPES.Bit, next.dryRun),
      param("DailyCap", TYPES.Int, next.dailyCap),
      param("RequireReview", TYPES.Bit, next.requireReview),
      param("Note", TYPES.NVarChar, input.note.trim().slice(0, 1000)),
      param("UpdatedBy", TYPES.NVarChar, actor.name.slice(0, 200)),
      param("CompanyFileId", TYPES.NVarChar, file),
      param("Operation", TYPES.NVarChar, input.operation),
      param("RowVersion", TYPES.Binary, Buffer.from(current.rowVersion, "base64")),
    ],
  );
  if (!updated[0]) throw new MyobControlsError(409, "Someone else changed this control since you loaded it. Reload and try again.");
  const row = toControlRow(updated[0]);

  await record(tx, {
    action: "myob.control_change",
    actor,
    after: snapshot(row),
    before: snapshot(current),
    computed: created.size > 0 ? { seeded: true } : undefined,
    reason: input.note,
    ruleApplied: "set",
    subject: { id: `${file}:${input.operation}`, type: "myob_control" },
  });
  return { changed: true, row, seeded: created.size > 0 };
}

/** Pauses (or resumes) one file, or every file when none is named. Returns the files it changed. */
export async function setPaused(
  tx: Connection,
  actor: LedgerActor,
  input: { companyFileId: string | null; note: string; paused: boolean },
): Promise<{ files: string[] }> {
  const common = [param("Paused", TYPES.Bit, input.paused), param("UpdatedBy", TYPES.NVarChar, actor.name.slice(0, 200))];
  const rows = input.companyFileId
    ? await executeQuery(
        tx,
        `UPDATE dbo.MyobControls SET PausedAll = @Paused, UpdatedBy = @UpdatedBy, UpdatedAt = SYSUTCDATETIME()
         OUTPUT inserted.CompanyFileId
          WHERE PausedAll <> @Paused AND CompanyFileId = @CompanyFileId`,
        [...common, param("CompanyFileId", TYPES.NVarChar, input.companyFileId.toLowerCase())],
      )
    : await executeQuery(
        tx,
        `UPDATE dbo.MyobControls SET PausedAll = @Paused, UpdatedBy = @UpdatedBy, UpdatedAt = SYSUTCDATETIME()
         OUTPUT inserted.CompanyFileId
          WHERE PausedAll <> @Paused`,
        common,
      );
  const files = [...new Set(rows.map((r) => String(r.CompanyFileId).toLowerCase()))];
  for (const file of files) {
    await record(tx, {
      action: "myob.control_change",
      actor,
      after: { pausedAll: input.paused },
      before: { pausedAll: !input.paused },
      reason: input.note,
      ruleApplied: input.paused ? "pause" : "resume",
      subject: { id: `${file}:*`, type: "myob_control" },
    });
  }
  return { files };
}
