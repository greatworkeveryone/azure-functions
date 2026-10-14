// What the CFO's MYOB Controls panel shows: every company file Floorplan knows
// (registered, configured or linked), all seven controls for each (defaults,
// marked not set up, where no row exists yet), today's writes against each
// allowance, and Will's master switch (read-only here).

import type { Connection } from "tedious";
import { executeQuery } from "./db";
import { CONTROL_OPERATIONS, readControls, writeKey, writesToday, type ControlRow } from "./myob-controls-store";

export interface ControlView extends ControlRow {
  setUp: boolean;
  usedToday: number;
}

export interface FileView {
  companyFileId: string;
  controls: ControlView[];
  isDemonstration: boolean;
  mode: string;
  name: string | null;
  paused: boolean;
  registered: boolean;
}

export interface ControlsView {
  configuredFileId: string | null;
  files: FileView[];
  linkedFileId: string | null;
  masterWritesEnabled: boolean;
}

const defaultRow = (companyFileId: string, operation: ControlRow["operation"]): ControlRow => ({
  companyFileId,
  dailyCap: 0,
  dryRun: true,
  enabled: false,
  note: null,
  operation,
  pausedAll: false,
  requireReview: true,
  rowVersion: "",
  updatedAt: null,
  updatedBy: null,
});

export async function loadControlsView(connection: Connection, now: Date = new Date()): Promise<ControlsView> {
  const registered = await executeQuery(connection, `SELECT CompanyFileId, Name, Mode, IsDemonstration FROM dbo.MyobCompanyFiles`);
  const auth = await executeQuery(connection, `SELECT BusinessId FROM dbo.MyobAuth WHERE Id = 1`);
  const controls = await readControls(connection);
  const used = await writesToday(connection, now);

  const configuredFileId = process.env.MYOB_COMPANY_FILE_ID?.trim().toLowerCase() || null;
  const linkedFileId = auth[0]?.BusinessId ? String(auth[0].BusinessId).toLowerCase() : null;
  const byId = new Map(registered.map((r) => [String(r.CompanyFileId).toLowerCase(), r]));
  const ids = [...new Set([...byId.keys(), configuredFileId, linkedFileId].filter((id): id is string => Boolean(id)))];

  const files = ids.map((id): FileView => {
    const meta = byId.get(id);
    const rows = controls.filter((c) => c.companyFileId === id);
    return {
      companyFileId: id,
      controls: CONTROL_OPERATIONS.map((operation) => {
        const row = rows.find((c) => c.operation === operation);
        return { ...(row ?? defaultRow(id, operation)), setUp: Boolean(row), usedToday: used.get(writeKey(id, operation)) ?? 0 };
      }),
      isDemonstration: Boolean(meta?.IsDemonstration),
      mode: meta ? String(meta.Mode) : "off",
      name: (meta?.Name as string | null | undefined) ?? null,
      paused: rows.some((c) => c.pausedAll),
      registered: Boolean(meta),
    };
  });
  return { configuredFileId, files, linkedFileId, masterWritesEnabled: process.env.MYOB_WRITES_ENABLED === "true" };
}
