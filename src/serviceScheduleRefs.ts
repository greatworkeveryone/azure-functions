// Checks a schedule's references before it is written (sprint F2): the
// building exists, the asset and location are in it (and the asset is live),
// the contractor exists. Also decides NextDue: the first occurrence from today
// on create, kept on edit unless the series changed (then the first occurrence
// on or after the earlier of the old due date and today, so an overdue service
// stays overdue rather than silently skipping).

import { TYPES, type Connection } from "tedious";
import { badRequest, txFail, txOk, type TxResult } from "./assetRegisterSupport";
import { executeQuery } from "./db";
import { firstDueOnOrAfter, type ServiceSeries } from "./facilitiesRules";
import type { ScheduleApi, ScheduleInput } from "./serviceSchedules";

const ddmmyyyy = (isoDay: string): string => isoDay.split("-").reverse().join("/");

export async function resolveScheduleReferences(connection: Connection, input: ScheduleInput): Promise<TxResult<ScheduleInput>> {
  const buildings = await executeQuery(connection, `SELECT BuildingID FROM dbo.Buildings WHERE BuildingID = @BuildingId`, [
    { name: "BuildingId", type: TYPES.Int, value: input.buildingId },
  ]);
  if (!buildings[0]) return txFail(badRequest("Building not found"));

  if (input.assetId !== null) {
    const assets = await executeQuery(connection, `SELECT AssetId, BuildingId, ArchivedAt FROM dbo.Assets WHERE AssetId = @AssetId`, [
      { name: "AssetId", type: TYPES.Int, value: input.assetId },
    ]);
    if (!assets[0] || Number(assets[0].BuildingId) !== input.buildingId) return txFail(badRequest("That asset isn't in this building"));
    if (assets[0].ArchivedAt) return txFail(badRequest("That asset is archived. Restore it or choose another."));
  }

  if (input.locationId !== null) {
    const locations = await executeQuery(connection, `SELECT LocationId, BuildingId FROM dbo.Locations WHERE LocationId = @LocationId`, [
      { name: "LocationId", type: TYPES.Int, value: input.locationId },
    ]);
    if (!locations[0] || Number(locations[0].BuildingId) !== input.buildingId) return txFail(badRequest("That location isn't in this building"));
  }

  if (input.contractorId !== null) {
    const contractors = await executeQuery(connection, `SELECT ContractorID FROM dbo.Contractors WHERE ContractorID = @ContractorId`, [
      { name: "ContractorId", type: TYPES.Int, value: input.contractorId },
    ]);
    if (!contractors[0]) return txFail(badRequest("Contractor not found"));
  }
  return txOk(input);
}

function seriesText(series: ServiceSeries): string {
  const unit = series.intervalCount === 1 ? series.intervalUnit.replace(/s$/, "") : `${series.intervalCount} ${series.intervalUnit}`;
  return `every ${unit} from ${ddmmyyyy(series.anchorDate)}`;
}

/** The NextDue to store, or a 400 when a given one is not on the series. */
export function planNextDue(input: ScheduleInput, before: ScheduleApi | null, today: string): TxResult<string> {
  const series: ServiceSeries = { anchorDate: input.anchorDate, intervalCount: input.intervalCount, intervalUnit: input.intervalUnit };
  if (input.nextDue !== null && (!before || input.nextDue !== before.nextDue)) {
    if (firstDueOnOrAfter(series, input.nextDue) !== input.nextDue) {
      return txFail(badRequest(`The next due date must be one of the schedule's dates (${seriesText(series)})`));
    }
    return txOk(input.nextDue);
  }
  if (!before) return txOk(firstDueOnOrAfter(series, today));
  const unchanged =
    before.anchorDate === input.anchorDate && before.intervalCount === input.intervalCount && before.intervalUnit === input.intervalUnit;
  if (unchanged) return txOk(before.nextDue);
  return txOk(firstDueOnOrAfter(series, before.nextDue < today ? before.nextDue : today));
}
