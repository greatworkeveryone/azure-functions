// What the CFO's Entities tab shows: every MYOB company file Floorplan knows
// (registered, configured or linked), its mode, whether it is the
// demonstration file, who last changed it, and which of its controls are on.

import type { Connection } from "tedious";
import { executeQuery } from "./db";
import { readCompanyFiles, type CompanyFileRow } from "./myob-company-files-store";
import { readControls } from "./myob-controls-store";

export interface CompanyFileView extends CompanyFileRow {
  configured: boolean;
  enabledOperations: string[];
  linked: boolean;
  paused: boolean;
  registered: boolean;
}

export interface CompanyFilesView {
  files: CompanyFileView[];
}

const unregistered = (companyFileId: string): CompanyFileRow => ({
  companyFileId,
  discoveredAt: null,
  isDemonstration: false,
  mode: "off",
  name: null,
  note: null,
  registeredAt: null,
  registeredBy: null,
  rowVersion: "",
  updatedAt: null,
  updatedBy: null,
  uri: null,
});

export async function loadCompanyFilesView(connection: Connection): Promise<CompanyFilesView> {
  const files = await readCompanyFiles(connection);
  const controls = await readControls(connection);
  const auth = await executeQuery(connection, `SELECT BusinessId FROM dbo.MyobAuth WHERE Id = 1`);
  const configured = process.env.MYOB_COMPANY_FILE_ID?.trim().toLowerCase() || null;
  const linked = auth[0]?.BusinessId ? String(auth[0].BusinessId).toLowerCase() : null;

  const registeredIds = new Set(files.map((file) => file.companyFileId));
  const byId = new Map(files.map((file) => [file.companyFileId, file]));
  for (const id of [configured, linked]) if (id && !byId.has(id)) byId.set(id, unregistered(id));

  return {
    files: [...byId.values()].map((file) => {
      const own = controls.filter((control) => control.companyFileId === file.companyFileId);
      return {
        ...file,
        configured: file.companyFileId === configured,
        enabledOperations: own.filter((control) => control.enabled).map((control) => control.operation),
        linked: file.companyFileId === linked,
        paused: own.some((control) => control.pausedAll),
        registered: registeredIds.has(file.companyFileId),
      };
    }),
  };
}
