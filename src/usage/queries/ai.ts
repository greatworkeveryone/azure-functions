import { TYPES, type Connection } from "tedious";
import { executeQuery } from "../../db";
import type { UsagePeriod } from "../period";

// AI (PLAN §14): calls from AiCallLog by purpose and outcome, and by day. Counts and timings only:
// no prompt, answer, person or record is read.

export interface UsageAiDto {
  byPurpose: { avgLatencyMs: number | null; failed: number; ok: number; purpose: string; refused: number; total: number }[];
  daily: { calls: number; day: string }[];
  period: { days: number; from: string; to: string };
  totals: { calls: number; failed: number; ok: number; refused: number };
}

const WINDOW = `CreatedAt >= @FromUtc AND CreatedAt < @ToUtc`;

export async function loadUsageAi(connection: Connection, period: UsagePeriod): Promise<UsageAiDto> {
  const params = [
    { name: "FromUtc", type: TYPES.DateTime2, value: period.fromUtc },
    { name: "ToUtc", type: TYPES.DateTime2, value: period.toUtc },
  ];
  const purposes = await executeQuery(
    connection,
    `SELECT Purpose, COUNT(*) AS Total, SUM(CASE WHEN Outcome = 'ok' THEN 1 ELSE 0 END) AS Ok,
            SUM(CASE WHEN Outcome = 'refused' THEN 1 ELSE 0 END) AS Refused, SUM(CASE WHEN Outcome = 'failed' THEN 1 ELSE 0 END) AS Failed,
            AVG(CAST(LatencyMs AS FLOAT)) AS AvgLatency
       FROM dbo.AiCallLog WHERE ${WINDOW} GROUP BY Purpose ORDER BY COUNT(*) DESC`,
    params,
  );
  const daily = await executeQuery(
    connection,
    `SELECT CONVERT(CHAR(10), CAST(DATEADD(MINUTE, 570, CreatedAt) AS DATE), 23) AS Day, COUNT(*) AS Calls
       FROM dbo.AiCallLog WHERE ${WINDOW} GROUP BY CAST(DATEADD(MINUTE, 570, CreatedAt) AS DATE) ORDER BY 1`,
    params,
  );
  const byPurpose = purposes.map((row) => ({
    avgLatencyMs: row.AvgLatency === null || row.AvgLatency === undefined ? null : Math.round(Number(row.AvgLatency)),
    failed: Number(row.Failed),
    ok: Number(row.Ok),
    purpose: String(row.Purpose),
    refused: Number(row.Refused),
    total: Number(row.Total),
  }));
  const sum = (pick: (row: (typeof byPurpose)[number]) => number) => byPurpose.reduce((total, row) => total + pick(row), 0);
  return {
    byPurpose,
    daily: daily.map((row) => ({ calls: Number(row.Calls), day: String(row.Day) })),
    period: { days: period.days, from: period.from, to: period.to },
    totals: { calls: sum((row) => row.total), failed: sum((row) => row.failed), ok: sum((row) => row.ok), refused: sum((row) => row.refused) },
  };
}
