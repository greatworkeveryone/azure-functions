// What the broadcast pickers offer (EB2): buildings with the levels that have an active tenancy, the trades
// contractors are set up for, the staff roles that have people, and who would approve a large send.
// Test tenancies never count towards a level.

import { TYPES, type Connection } from "tedious";
import { buildingCategoryColumnExists } from "../../buildingCategoryColumn";
import { executeQuery } from "../../db";
import { ACTION_ROLES } from "../../action-roles";
import { approvalThreshold, type CommsMode, commsMode, fromAddress } from "../config";
import { recentRecipientCount } from "../store";
import { STAFF_AUDIENCE_ROLES } from "./audienceInput";

const byName = (a: string, b: string): number => a.localeCompare(b, "en-AU", { numeric: true, sensitivity: "base" });

export interface BroadcastBuilding {
  buildingId: number;
  category: "commercial" | "residence";
  levels: string[];
  name: string;
}

export interface BroadcastOptions {
  approvalThreshold: number;
  approvers: { name: string; role: string }[];
  buildings: BroadcastBuilding[];
  /** The one address every email goes from (COMMS_FROM_ADDRESS). */
  fromAddress: string;
  /** This person's recipients over the last 24 hours (the count the queue adds a new send to), so the Review step can say beforehand. */
  recentRecipients: number;
  /** Whether the server sends at all right now: `off` and `dry-run` record a send and hold it back. */
  sending: CommsMode;
  staffRoles: { count: number; role: string }[];
  trades: string[];
}

function tradesOf(json: unknown, key: "trade" | "trades"): string[] {
  try {
    const value = JSON.parse(String(json)) as unknown;
    const list = key === "trades" ? (value as { trades?: unknown } | null)?.trades : value;
    if (!Array.isArray(list)) return [];
    return list.flatMap((entry) => (key === "trade" ? [(entry as { trade?: unknown } | null)?.trade] : [entry])).filter((trade): trade is string => typeof trade === "string" && trade.trim() !== "").map((trade) => trade.trim());
  } catch {
    return [];
  }
}

async function loadBuildings(connection: Connection): Promise<BroadcastBuilding[]> {
  const CATEGORY_COLUMN = (await buildingCategoryColumnExists(connection)) ? "Category" : "N'commercial'";
  const buildings = await executeQuery(connection, `SELECT BuildingID, BuildingName, ${CATEGORY_COLUMN} AS Category FROM dbo.Buildings WHERE Active = 1`);
  const levels = await executeQuery(
    connection,
    `SELECT DISTINCT o.BuildingId, o.Level
       FROM dbo.TenantOccupancies o JOIN dbo.Tenants t ON t.TenantId = o.TenantId
      WHERE o.ArchivedAt IS NULL AND t.ArchivedAt IS NULL AND t.IsTest = 0 AND t.Status IN ('current', 'holdover') AND o.Level <> ''`,
  );
  return buildings
    .map((row) => ({
      buildingId: Number(row.BuildingID),
      category: (row.Category === "residence" ? "residence" : "commercial") as BroadcastBuilding["category"],
      levels: levels.filter((level) => Number(level.BuildingId) === Number(row.BuildingID)).map((level) => String(level.Level)).sort(byName),
      name: String(row.BuildingName ?? `Building ${row.BuildingID}`),
    }))
    .sort((a, b) => byName(a.name, b.name));
}

async function loadTrades(connection: Connection): Promise<string[]> {
  const found = new Map<string, string>();
  const rows = [
    ...(await executeQuery(connection, `SELECT CoverageJson AS Json FROM dbo.ContractorCoverage`)).map((row) => tradesOf(row.Json, "trades")),
    ...(await executeQuery(connection, `SELECT PlanJson AS Json FROM dbo.MaintenanceCoverage`)).map((row) => tradesOf(row.Json, "trade")),
  ];
  for (const trade of rows.flat()) if (!found.has(trade.toLocaleLowerCase("en-AU"))) found.set(trade.toLocaleLowerCase("en-AU"), trade);
  return [...found.values()].sort(byName);
}

export async function loadBroadcastOptions(connection: Connection, callerOid: string): Promise<BroadcastOptions> {
  const buildings = await loadBuildings(connection);
  const trades = await loadTrades(connection);
  const roles = await executeQuery(connection, `SELECT LOWER(Role) AS Role, COUNT(*) AS N FROM dbo.AppUsers WHERE IsActive = 1 AND Role IS NOT NULL GROUP BY LOWER(Role)`);
  // Admin is refused approving (approveEmail.refused) and is not in this gate, so it is never offered.
  const approverRoles = ACTION_ROLES.approveEmail.gate;
  const approvers = await executeQuery(
    connection,
    `SELECT DisplayName, LOWER(Role) AS Role FROM dbo.AppUsers
      WHERE IsActive = 1 AND LOWER(Role) IN (SELECT [value] FROM OPENJSON(@Roles)) AND EntraOid <> @Oid ORDER BY DisplayName`,
    [
      { name: "Roles", type: TYPES.NVarChar, value: JSON.stringify(approverRoles) },
      { name: "Oid", type: TYPES.NVarChar, value: callerOid },
    ],
  );
  return {
    approvalThreshold: approvalThreshold(),
    approvers: approvers.map((row) => ({ name: String(row.DisplayName), role: String(row.Role) })),
    buildings,
    fromAddress: fromAddress(),
    recentRecipients: await recentRecipientCount(connection, callerOid, false),
    sending: commsMode(),
    staffRoles: roles.filter((row) => STAFF_AUDIENCE_ROLES.includes(String(row.Role))).map((row) => ({ count: Number(row.N), role: String(row.Role) })).sort((a, b) => byName(a.role, b.role)),
    trades,
  };
}
