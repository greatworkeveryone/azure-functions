// Whether the lab may run (plan M5; the M9 review's carry): exactly one
// registered company file is flagged as the demonstration file; it isn't RP's
// own file (MYOB_RP_COMPANY_FILE_ID, rpCompanyFile.ts, which the lab needs so
// it can always tell the two apart; send.ts refuses RP's file too); it is set
// to read and create, and no other file is; and Floorplan is linked to the
// demonstration file with exactly the agreed scopes. Every problem is said in
// plain words; the lab records nothing until there are none.

import type { Connection } from "tedious";
import { executeQuery } from "../../db";
import { MYOB_SCOPE_STRING } from "../../myob-endpoints";
import { rpCompanyFileId } from "../rpCompanyFile";

export interface LabStatus {
  demoFile: { id: string; mode: string; name: string } | null;
  link: { businessId: string | null; scope: string | null; username: string | null } | null;
  problems: string[];
  ready: boolean;
  /** RP's own file, which the lab never touches, with its registered name (null when not registered). */
  rpFile: { id: string; name: string | null } | null;
}

const text = (value: unknown) => (typeof value === "string" && value ? value : null);

export async function loadLabStatus(connection: Connection, env: NodeJS.ProcessEnv = process.env): Promise<LabStatus> {
  const files = await executeQuery(connection, `SELECT CompanyFileId, Name, Mode, IsDemonstration FROM dbo.MyobCompanyFiles`);
  const auth = await executeQuery(connection, `SELECT BusinessId, MyobUsername, Scope FROM dbo.MyobAuth WHERE Id = 1`);
  const rp = rpCompanyFileId(env);
  const problems: string[] = [];
  if (!rp) problems.push("Set MYOB_RP_COMPANY_FILE_ID to RP's own company file id, so the lab can never touch it");

  const all = files.map((row) => ({ demo: row.IsDemonstration === true, id: String(row.CompanyFileId).toLowerCase(), mode: String(row.Mode), name: text(row.Name) ?? String(row.CompanyFileId) }));
  const demos = all.filter((file) => file.demo);
  if (demos.length === 0) problems.push("No company file is flagged as the demonstration file (Admin → MYOB → Entities)");
  if (demos.length > 1) problems.push(`More than one file is flagged as the demonstration file: ${demos.map((file) => file.name).join(", ")}`);
  const demo = demos.length === 1 ? demos[0] : null;
  if (demo && rp && demo.id === rp) problems.push(`${demo.name} is RP's own file: the lab runs only on a demonstration file that isn't RP's`);
  if (demo && demo.mode !== "write") problems.push(`${demo.name} isn't set to read and create (Admin → MYOB → Entities)`);
  for (const other of all.filter((file) => file.mode === "write" && file.id !== demo?.id)) problems.push(`${other.name} is also set to read and create: only the demonstration file may be`);

  const link = auth[0] ? { businessId: text(auth[0].BusinessId)?.toLowerCase() ?? null, scope: text(auth[0].Scope), username: text(auth[0].MyobUsername) } : null;
  if (!link?.businessId) problems.push("Floorplan is not linked to MYOB yet (Admin → MYOB → Connection)");
  else if (link.scope !== MYOB_SCOPE_STRING) problems.push(`The MYOB link's scope is "${link.scope ?? "none"}", not exactly ${MYOB_SCOPE_STRING}`);
  if (link?.businessId && demo && link.businessId !== demo.id) {
    const linked = all.find((file) => file.id === link.businessId)?.name ?? link.businessId;
    problems.push(`Floorplan's MYOB link is to ${linked}, not ${demo.name}: link it to the demonstration file as your restricted MYOB user (Admin → MYOB → Connection)`);
  }

  const rpFile = rp ? { id: rp, name: all.find((file) => file.id === rp)?.name ?? null } : null;
  return { demoFile: demo ? { id: demo.id, mode: demo.mode, name: demo.name } : null, link, problems, ready: problems.length === 0, rpFile };
}
