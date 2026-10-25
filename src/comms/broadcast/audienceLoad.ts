// The reads behind an audience. Every statement is parameterised and names its columns; none writes.
// Archived and test records are marked, never hidden here: the resolver says why a record was left out.

import { TYPES, type Connection } from "tedious";
import { buildingCategoryColumnExists } from "../../buildingCategoryColumn";
import { executeQuery, type SqlRow } from "../../db";
import type { BuildingCategory, ContractorRow, OccupancyRow, StaffRow, TenancyRow } from "./types";

const jsonParam = (name: string, value: unknown) => ({ name, type: TYPES.NVarChar, value: JSON.stringify(value) });
const text = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value : null);
const flag = (value: unknown): boolean => value === true || value === 1;

/** DATE columns come back as a Date at UTC midnight; the register holds plain dates. */
function isoDate(value: unknown): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null;
}

/** Active tenancies only: current or holdover, not archived. Pending and vacated ones are not tenants to notify. */
export async function loadTenancies(connection: Connection, buildingIds: readonly number[]): Promise<TenancyRow[]> {
  // Migration 136 is applied by hand: until it is, every building reads as commercial.
  const CATEGORY_COLUMN = (await buildingCategoryColumnExists(connection)) ? "b.Category" : "N'commercial'";
  const rows = await executeQuery(
    connection,
    `SELECT t.TenantId, t.BuildingId, t.LegalName, t.AccountsEmail, t.PrimaryContactName, t.PrimaryContactEmail,
            t.Commencement, t.Expiry, t.NextReviewDate, t.IsTest, b.BuildingName, b.BuildingAddress,
            ${CATEGORY_COLUMN} AS Category
       FROM dbo.Tenants t
       JOIN dbo.Buildings b ON b.BuildingID = t.BuildingId
      WHERE t.ArchivedAt IS NULL AND t.Status IN ('current', 'holdover')
        AND t.BuildingId IN (SELECT CAST([value] AS INT) FROM OPENJSON(@BuildingIds))
      ORDER BY t.LegalName, t.TenantId`,
    [jsonParam("BuildingIds", buildingIds)],
  );
  return rows.map((row: SqlRow) => ({
    accountsEmail: text(row.AccountsEmail),
    buildingAddress: text(row.BuildingAddress),
    buildingCategory: (row.Category === "residence" ? "residence" : "commercial") as BuildingCategory,
    buildingId: Number(row.BuildingId),
    buildingName: text(row.BuildingName),
    commencement: isoDate(row.Commencement),
    expiry: isoDate(row.Expiry),
    isTest: flag(row.IsTest),
    legalName: String(row.LegalName),
    nextReviewDate: isoDate(row.NextReviewDate),
    primaryContactEmail: text(row.PrimaryContactEmail),
    primaryContactName: text(row.PrimaryContactName),
    tenantId: Number(row.TenantId),
  }));
}

/** The areas still let (not archived) for these buildings. */
export async function loadOccupancies(connection: Connection, buildingIds: readonly number[]): Promise<OccupancyRow[]> {
  const rows = await executeQuery(
    connection,
    `SELECT o.TenantId, o.BuildingId, o.Level, o.Area
       FROM dbo.TenantOccupancies o
      WHERE o.ArchivedAt IS NULL AND o.BuildingId IN (SELECT CAST([value] AS INT) FROM OPENJSON(@BuildingIds))
      ORDER BY o.TenantId, o.Level, o.Area`,
    [jsonParam("BuildingIds", buildingIds)],
  );
  return rows.map((row) => ({ area: String(row.Area ?? ""), buildingId: Number(row.BuildingId), level: String(row.Level ?? ""), tenantId: Number(row.TenantId) }));
}

/** Contractors who may be asked for work: active and not suspended. */
export async function loadContractors(connection: Connection): Promise<ContractorRow[]> {
  const rows = await executeQuery(
    connection,
    `SELECT ContractorID, ContractorName, EmailAddress, ContactFirstName, ContactLastName
       FROM dbo.Contractors WHERE Active = 1 AND Suspended = 0 ORDER BY ContractorName, ContractorID`,
  );
  return rows.map((row) => {
    const contact = [text(row.ContactFirstName), text(row.ContactLastName)].filter((part): part is string => part !== null).join(" ");
    return {
      contactName: contact === "" ? null : contact,
      contractorId: Number(row.ContractorID),
      email: text(row.EmailAddress),
      name: text(row.ContractorName)?.trim() ?? `Contractor #${row.ContractorID}`,
    };
  });
}

function parseJson(value: unknown): unknown {
  try {
    return typeof value === "string" ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}

/** Each contractor's own list of trades (migration 156). A contractor with no row has none. */
export async function loadContractorTrades(connection: Connection): Promise<Map<number, string[]>> {
  const map = new Map<number, string[]>();
  for (const row of await executeQuery(connection, `SELECT ContractorId, CoverageJson FROM dbo.ContractorCoverage`)) {
    const trades = (parseJson(row.CoverageJson) as { trades?: unknown } | null)?.trades;
    map.set(Number(row.ContractorId), Array.isArray(trades) ? trades.filter((trade): trade is string => typeof trade === "string") : []);
  }
  return map;
}

/** Contractor ids the buildings' coverage plans (migration 155) name, for the given trades or for any trade when none are given. */
export async function loadAssignedContractors(connection: Connection, buildingIds: readonly number[], trades: readonly string[]): Promise<Set<number>> {
  const ids = new Set<number>();
  if (buildingIds.length === 0) return ids;
  const wanted = trades.map((trade) => trade.trim().toLocaleLowerCase("en-AU"));
  const rows = await executeQuery(connection, `SELECT PlanJson FROM dbo.MaintenanceCoverage WHERE BuildingId IN (SELECT CAST([value] AS INT) FROM OPENJSON(@BuildingIds))`, [jsonParam("BuildingIds", buildingIds)]);
  for (const row of rows) {
    const plan = parseJson(row.PlanJson);
    if (!Array.isArray(plan)) continue;
    for (const entry of plan) {
      const trade = (entry as { trade?: unknown } | null)?.trade;
      if (typeof trade !== "string" || (wanted.length > 0 && !wanted.includes(trade.trim().toLocaleLowerCase("en-AU")))) continue;
      const list = (entry as { contractorIds?: unknown }).contractorIds;
      if (Array.isArray(list)) for (const id of list) if (Number.isInteger(id)) ids.add(id as number);
    }
  }
  return ids;
}

/** Active staff in the roles. Roles are stored lower case. */
export async function loadStaff(connection: Connection, roles: readonly string[]): Promise<StaffRow[]> {
  const rows = await executeQuery(
    connection,
    `SELECT UserID, DisplayName, Email, Role FROM dbo.AppUsers
      WHERE IsActive = 1 AND LOWER(Role) IN (SELECT LOWER([value]) FROM OPENJSON(@Roles)) ORDER BY DisplayName, UserID`,
    [jsonParam("Roles", roles)],
  );
  return rows.map((row) => ({ email: String(row.Email ?? ""), name: String(row.DisplayName), role: String(row.Role).toLowerCase(), userId: Number(row.UserID) }));
}

/** The contact addresses (primary and accounts, lower case) of every test tenancy, so a typed address that is one can be refused. */
export async function loadTestContactAddresses(connection: Connection): Promise<Set<string>> {
  const rows = await executeQuery(
    connection,
    `SELECT LOWER(LTRIM(RTRIM(PrimaryContactEmail))) AS Address FROM dbo.Tenants WHERE IsTest = 1 AND PrimaryContactEmail IS NOT NULL
     UNION
     SELECT LOWER(LTRIM(RTRIM(AccountsEmail))) FROM dbo.Tenants WHERE IsTest = 1 AND AccountsEmail IS NOT NULL`,
  );
  return new Set(rows.map((row) => String(row.Address)).filter((address) => address !== ""));
}
