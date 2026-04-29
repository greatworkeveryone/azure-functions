// tenancyCpiSyncTimer — pulls Australian CPI index values from the ABS Data
// API and upserts them into dbo.CpiIndex. The "Apply CPI review" flow reads
// from this table to compute a tenant's percentage increase between their
// last review period and the current one.
//
// IMPORTANT — endpoint URL needs verification before going to prod. The ABS
// Data API has occasionally moved between subdomains. Run a manual `curl`
// against the URL below from the function-app environment first; if it
// 404s, the up-to-date base URL is documented at
// https://www.abs.gov.au/about/data-services/application-programming-interfaces-apis/data-api-user-guide
//
// SDMX-JSON dataflow IDs:
//   • All groups CPI, weighted average of 8 capital cities → "CPI"
//     dimensions: MEASURE.INDEX_NUMBER, INDEX.10001, TSEST.20, REGION.50
//   • Darwin all-groups CPI → REGION.7

import { app, InvocationContext, Timer } from "@azure/functions";
import { TYPES } from "tedious";
import { closeConnection, createServiceConnection, executeQuery } from "../db";

const ABS_BASE = "https://data.api.abs.gov.au/rest/data/CPI";

interface CpiObservation {
  indexValue: number;
  period: string;
  region: "AUS" | "DARWIN";
}

async function fetchAbsCpi(
  context: InvocationContext,
): Promise<CpiObservation[]> {
  const out: CpiObservation[] = [];
  // SDMX-JSON key: MEASURE.INDEX.TSEST.REGION ; query the latest 8 quarters.
  const queries: { key: string; region: "AUS" | "DARWIN" }[] = [
    { key: "1.10001.20.50", region: "AUS" }, // weighted 8-cap
    { key: "1.10001.20.7",  region: "DARWIN" },
  ];
  for (const q of queries) {
    const url = `${ABS_BASE}/${q.key}/all?startPeriod=${new Date().getFullYear() - 2}&format=jsondata`;
    try {
      const resp = await fetch(url, { headers: { Accept: "application/vnd.sdmx.data+json" } });
      if (!resp.ok) {
        context.error(`ABS CPI fetch failed for ${q.region}: ${resp.status} ${resp.statusText}`);
        continue;
      }
      const json = (await resp.json()) as any;
      // SDMX-JSON: dataSets[0].series → keyed by dimension index path; observations
      // are { "0": [value, ...], "1": [value, ...] } where each array index maps
      // to a period in dimensions.observation[0].values.
      const periods: { id: string }[] =
        json?.structure?.dimensions?.observation?.[0]?.values ?? [];
      const series = json?.dataSets?.[0]?.series ?? {};
      for (const seriesKey of Object.keys(series)) {
        const obs = series[seriesKey].observations ?? {};
        for (const periodIdx of Object.keys(obs)) {
          const value = obs[periodIdx]?.[0];
          const period = periods[Number(periodIdx)]?.id;
          if (period && typeof value === "number") {
            out.push({ indexValue: value, period, region: q.region });
          }
        }
      }
    } catch (err: any) {
      context.error(`ABS CPI fetch threw for ${q.region}:`, err.message);
    }
  }
  return out;
}

async function tenancyCpiSyncTimer(
  _timer: Timer,
  context: InvocationContext,
): Promise<void> {
  context.log("tenancyCpiSyncTimer: starting ABS CPI sync");
  const observations = await fetchAbsCpi(context);
  if (observations.length === 0) {
    context.log("tenancyCpiSyncTimer: no observations parsed — skipping write");
    return;
  }

  let connection;
  try {
    connection = await createServiceConnection();
    let upserts = 0;
    for (const o of observations) {
      try {
        await executeQuery(
          connection,
          `MERGE dbo.CpiIndex AS target
           USING (SELECT @Region AS Region, @Period AS Period) AS src
             ON target.Region = src.Region AND target.Period = src.Period
           WHEN MATCHED THEN
             UPDATE SET IndexValue = @IndexValue, FetchedAt = SYSUTCDATETIME()
           WHEN NOT MATCHED THEN
             INSERT (Region, Period, IndexValue) VALUES (@Region, @Period, @IndexValue);`,
          [
            { name: "Region", type: TYPES.NVarChar, value: o.region },
            { name: "Period", type: TYPES.NVarChar, value: o.period },
            { name: "IndexValue", type: TYPES.Decimal, value: o.indexValue },
          ],
        );
        upserts++;
      } catch (err: any) {
        context.error(
          `tenancyCpiSyncTimer upsert failed (${o.region} ${o.period}):`,
          err.message,
        );
      }
    }
    context.log(`tenancyCpiSyncTimer: ${upserts} CpiIndex rows upserted`);
  } catch (error: any) {
    context.error("tenancyCpiSyncTimer: fatal:", error.message);
    throw error;
  } finally {
    if (connection) closeConnection(connection);
  }
}

// Runs at 03:00 UTC on the 15th of each month — gives ABS time to publish
// the latest quarter (typically released late in the month following the
// reference quarter) and avoids contention with other midnight timers.
app.timer("tenancyCpiSyncTimer", {
  schedule: "0 0 3 15 * *",
  handler: tenancyCpiSyncTimer,
});
