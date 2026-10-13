// cpiIndexSync — writes fetched ABS CPI series into dbo.CpiIndex (WP22).
//
// Guarantees:
//   - Nothing is written unless the series are complete (cpiAbs's job) and this
//     module's own pre-flight passes: every value fits DECIMAL(10,3), and no
//     region's newest period is older than what is already stored.
//   - All regions go in ONE transaction. Any failure rolls back and leaves the
//     table exactly as it was.
//   - A reference base that differs from the stored one is a rebase: ABS has
//     restated every historical value, so every row of that region is rewritten
//     (not just the new quarter), and the change is logged and sent to Sentry.
//   - Rows that already match are not rewritten, only confirmed (FetchedAt).

import { Connection, TYPES } from "tedious";
import {
  beginTransaction,
  commitTransaction,
  executeQuery,
  rollbackTransaction,
} from "./db";
import { CpiObservation, CpiRegion, CpiSeries } from "./cpiAbs";
import { Sentry } from "./sentry";

// dbo.CpiIndex.IndexValue is DECIMAL(10,3). Tedious defaults a Decimal
// parameter to scale 0 and silently truncates, so the options are not optional.
const INDEX_VALUE_OPTIONS = { precision: 10, scale: 3 } as const;
const INDEX_VALUE_SCALE = 1000;
const INDEX_VALUE_LIMIT = 10_000_000;

export interface SyncLogger {
  log(message: string): void;
  warn(message: string): void;
}

export interface CpiSyncRegionResult {
  region: CpiRegion;
  referenceBase: string;
  /** Distinct non-null bases found in the table before this run. */
  previousBases: string[];
  baseChanged: boolean;
  fetched: number;
  inserted: number;
  /** Existing rows whose value, base or source changed (all of them on a rebase). */
  restated: number;
  unchanged: number;
  /** Periods newer than anything stored before; empty on the very first fill. */
  newPeriods: string[];
  latestPeriod: string;
}

export interface CpiSyncResult {
  regions: CpiSyncRegionResult[];
}

interface StoredRow {
  value: number;
  referenceBase: string | null;
  sourceKey: string | null;
  dataflow: string | null;
}

interface RegionPlan {
  series: CpiSeries;
  toWrite: CpiObservation[];
  result: CpiSyncRegionResult;
  orphanedPeriods: string[];
}

const UPSERT_SQL = `MERGE dbo.CpiIndex WITH (HOLDLOCK) AS target
  USING (SELECT @Region AS Region, @Period AS Period) AS src
    ON target.Region = src.Region AND target.Period = src.Period
  WHEN MATCHED THEN
    UPDATE SET IndexValue = @IndexValue,
               ReferenceBase = @ReferenceBase,
               SourceKey = @SourceKey,
               Dataflow = @Dataflow,
               FetchedAt = SYSUTCDATETIME()
  WHEN NOT MATCHED THEN
    INSERT (Region, Period, IndexValue, ReferenceBase, SourceKey, Dataflow)
    VALUES (@Region, @Period, @IndexValue, @ReferenceBase, @SourceKey, @Dataflow);`;

// The fetched series is contiguous, so this range is exactly the rows ABS just
// confirmed. Rows outside it (older than the start period) are not touched.
const CONFIRM_SQL = `UPDATE dbo.CpiIndex
  SET FetchedAt = SYSUTCDATETIME()
  WHERE Region = @Region AND Period >= @FirstPeriod AND Period <= @LastPeriod`;

function scaled(value: number): number {
  return Math.round(value * INDEX_VALUE_SCALE);
}

function assertRepresentable(series: CpiSeries): void {
  for (const o of series.observations) {
    const exact = o.value * INDEX_VALUE_SCALE;
    if (Math.abs(o.value) >= INDEX_VALUE_LIMIT || Math.abs(exact - Math.round(exact)) > 1e-6) {
      throw new Error(
        `${series.region} ${o.period}: ${o.value} does not fit dbo.CpiIndex.IndexValue DECIMAL(10,3); ` +
          `refusing to round an index value silently`,
      );
    }
  }
}

async function readStored(
  connection: Connection,
  region: CpiRegion,
): Promise<Map<string, StoredRow>> {
  const rows = await executeQuery(
    connection,
    `SELECT Period, IndexValue, ReferenceBase, SourceKey, Dataflow
     FROM dbo.CpiIndex
     WHERE Region = @Region`,
    [{ name: "Region", type: TYPES.NVarChar, value: region }],
  );
  const stored = new Map<string, StoredRow>();
  for (const row of rows) {
    stored.set(String(row.Period), {
      value: Number(row.IndexValue),
      referenceBase: row.ReferenceBase ?? null,
      sourceKey: row.SourceKey ?? null,
      dataflow: row.Dataflow ?? null,
    });
  }
  return stored;
}

function planRegion(series: CpiSeries, stored: Map<string, StoredRow>): RegionPlan {
  const first = series.observations[0].period;
  const last = series.observations[series.observations.length - 1].period;

  const storedPeriods = [...stored.keys()].sort();
  const storedLatest = storedPeriods.length > 0 ? storedPeriods[storedPeriods.length - 1] : null;
  if (storedLatest !== null && storedLatest > last) {
    throw new Error(
      `${series.region}: ABS latest period ${last} is older than stored ${storedLatest}; ` +
        `refusing to write a regression`,
    );
  }

  const previousBases = [
    ...new Set(
      [...stored.values()]
        .map((row) => row.referenceBase)
        .filter((base): base is string => base !== null),
    ),
  ].sort();
  const baseChanged = previousBases.some((base) => base !== series.referenceBase);

  const inserted: string[] = [];
  let restated = 0;
  let unchanged = 0;
  const toWrite: CpiObservation[] = [];
  for (const observation of series.observations) {
    const row = stored.get(observation.period);
    if (!row) {
      inserted.push(observation.period);
      toWrite.push(observation);
    } else if (
      scaled(row.value) === scaled(observation.value) &&
      row.referenceBase === series.referenceBase &&
      row.sourceKey === series.sourceKey &&
      row.dataflow === series.dataflow
    ) {
      unchanged++;
    } else {
      restated++;
      toWrite.push(observation);
    }
  }

  return {
    series,
    toWrite,
    orphanedPeriods: storedPeriods.filter((period) => period < first),
    result: {
      region: series.region,
      referenceBase: series.referenceBase,
      previousBases,
      baseChanged,
      fetched: series.observations.length,
      inserted: inserted.length,
      restated,
      unchanged,
      newPeriods: storedLatest === null ? [] : inserted.filter((p) => p > storedLatest),
      latestPeriod: last,
    },
  };
}

async function writePlans(connection: Connection, plans: RegionPlan[]): Promise<void> {
  for (const { series, toWrite } of plans) {
    for (const observation of toWrite) {
      await executeQuery(connection, UPSERT_SQL, [
        { name: "Region", type: TYPES.NVarChar, value: series.region },
        { name: "Period", type: TYPES.NVarChar, value: observation.period },
        {
          name: "IndexValue",
          type: TYPES.Decimal,
          value: observation.value,
          options: INDEX_VALUE_OPTIONS,
        },
        { name: "ReferenceBase", type: TYPES.NVarChar, value: series.referenceBase },
        { name: "SourceKey", type: TYPES.NVarChar, value: series.sourceKey },
        { name: "Dataflow", type: TYPES.NVarChar, value: series.dataflow },
      ]);
    }
    await executeQuery(connection, CONFIRM_SQL, [
      { name: "Region", type: TYPES.NVarChar, value: series.region },
      { name: "FirstPeriod", type: TYPES.NVarChar, value: series.observations[0].period },
      {
        name: "LastPeriod",
        type: TYPES.NVarChar,
        value: series.observations[series.observations.length - 1].period,
      },
    ]);
  }
}

function reportOutcome(plans: RegionPlan[], logger: SyncLogger): void {
  for (const { result, orphanedPeriods } of plans) {
    logger.log(
      `cpi sync ${result.region}: base "${result.referenceBase}", fetched ${result.fetched}, ` +
        `inserted ${result.inserted}, restated ${result.restated}, unchanged ${result.unchanged}, ` +
        `latest ${result.latestPeriod}`,
    );
    if (result.newPeriods.length > 0) {
      logger.log(`cpi sync ${result.region}: new period(s) ${result.newPeriods.join(", ")}`);
    }
    if (result.baseChanged) {
      const message =
        `cpi sync ${result.region}: ABS reference base changed from ` +
        `${result.previousBases.map((b) => `"${b}"`).join(" and ")} to "${result.referenceBase}"; ` +
        `restated ${result.restated} existing row(s)`;
      logger.warn(message);
      Sentry.captureMessage(message, {
        level: "warning",
        extra: {
          region: result.region,
          previousBases: result.previousBases,
          referenceBase: result.referenceBase,
          restated: result.restated,
        },
      });
    }
    if (orphanedPeriods.length > 0) {
      logger.warn(
        `cpi sync ${result.region}: ${orphanedPeriods.length} stored row(s) older than the fetched ` +
          `range were not refreshed (${orphanedPeriods[0]} to ${orphanedPeriods[orphanedPeriods.length - 1]})`,
      );
    }
  }
}

/**
 * Reconcile dbo.CpiIndex with freshly fetched series. Throws, having written
 * nothing, if pre-flight fails; rolls back and throws if a write fails.
 */
export async function syncCpiIndex(
  connection: Connection,
  seriesList: readonly CpiSeries[],
  logger: SyncLogger,
): Promise<CpiSyncResult> {
  for (const series of seriesList) assertRepresentable(series);

  const plans: RegionPlan[] = [];
  for (const series of seriesList) {
    plans.push(planRegion(series, await readStored(connection, series.region)));
  }

  await beginTransaction(connection);
  try {
    await writePlans(connection, plans);
    await commitTransaction(connection);
  } catch (err) {
    try {
      await rollbackTransaction(connection);
    } catch (rollbackErr) {
      logger.warn(
        `cpi sync: rollback failed: ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}`,
      );
    }
    throw err;
  }

  reportOutcome(plans, logger);
  return { regions: plans.map((plan) => plan.result) };
}
