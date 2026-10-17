// Checks a defects period's references against the database before it is
// written (sprint F1): the building exists, a level is one of the building's
// levels (Buildings.Levels or its Locations, spec §5), a tenancy is in the same
// building, the contractor exists. A level named without its Locations id is
// matched to one when the building has it.

import { TYPES, type Connection } from "tedious";
import { badRequest, txFail, txOk, type TxResult } from "./assetRegisterSupport";
import { executeQuery } from "./db";
import type { DefectsPeriodInput } from "./defectsPeriods";

const norm = (value: unknown): string => String(value ?? "").trim().toLowerCase();

function buildingLevels(levels: unknown): string[] {
  try {
    const parsed: unknown = JSON.parse(String(levels ?? "[]"));
    return Array.isArray(parsed) ? parsed.map((level) => String(level).trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

async function resolveLevel(connection: Connection, input: DefectsPeriodInput, levels: unknown): Promise<TxResult<DefectsPeriodInput>> {
  const locations = await executeQuery(
    connection,
    `SELECT LocationId, Name FROM dbo.Locations WHERE BuildingId = @BuildingId AND Kind = 'level' AND Active = 1`,
    [{ name: "BuildingId", type: TYPES.Int, value: input.buildingId }],
  );
  if (input.locationId !== null) {
    const location = locations.find((row) => Number(row.LocationId) === input.locationId);
    if (!location) return txFail(badRequest("That level isn't in this building"));
    return txOk({ ...input, levelName: String(location.Name) });
  }
  const wanted = norm(input.levelName);
  const location = locations.find((row) => norm(row.Name) === wanted);
  if (location) return txOk({ ...input, levelName: String(location.Name), locationId: Number(location.LocationId) });
  const listed = buildingLevels(levels).find((name) => norm(name) === wanted);
  if (!listed) return txFail(badRequest(`"${input.levelName}" isn't one of this building's levels`));
  return txOk({ ...input, levelName: listed });
}

export async function resolvePeriodReferences(connection: Connection, input: DefectsPeriodInput): Promise<TxResult<DefectsPeriodInput>> {
  const buildings = await executeQuery(
    connection,
    `SELECT BuildingID, Levels FROM dbo.Buildings WHERE BuildingID = @BuildingId`,
    [{ name: "BuildingId", type: TYPES.Int, value: input.buildingId }],
  );
  if (!buildings[0]) return txFail(badRequest("Building not found"));

  let resolved = input;
  if (input.scope === "level") {
    const level = await resolveLevel(connection, input, buildings[0].Levels);
    if (!level.ok) return level;
    resolved = level.value;
  }

  if (input.scope === "tenancy") {
    const tenants = await executeQuery(
      connection,
      `SELECT TenantID, BuildingID FROM dbo.Tenants WHERE TenantID = @TenantId`,
      [{ name: "TenantId", type: TYPES.Int, value: input.tenantId }],
    );
    if (!tenants[0] || Number(tenants[0].BuildingID) !== input.buildingId) {
      return txFail(badRequest("That tenancy isn't in this building"));
    }
  }

  if (input.contractorId !== null) {
    const contractors = await executeQuery(
      connection,
      `SELECT ContractorID FROM dbo.Contractors WHERE ContractorID = @ContractorId`,
      [{ name: "ContractorId", type: TYPES.Int, value: input.contractorId }],
    );
    if (!contractors[0]) return txFail(badRequest("Contractor not found"));
  }

  return txOk(resolved);
}
