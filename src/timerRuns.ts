import type { InvocationContext, Timer } from "@azure/functions";
import { TYPES } from "tedious";
import { closeConnection, createServiceRequestConnection, executeQuery, type SqlParam, type SqlRow } from "./db";
import { Sentry } from "./sentry";

// Timers fail loudly (DL-12). Every app.timer registration hands its handler
// to runTimer, which writes a dbo.TimerRuns row (migration 128), and when the
// body throws: logs, tells Sentry, marks the row 'error' and rethrows, so
// Azure records a failed invocation. It never swallows. Recording is
// best-effort: a run that can't be recorded still runs, and still fails.
// /api/health?deep=true reads the last row per timer.

/** Every timer the app registers; a guard test keeps this and src in step. */
export const TIMER_NAMES = [
  "accessReportTimer",
  "commsSendTimer",
  "digestTimer",
  "schedulerTimer",
  "escalationSweepTimer",
  "leaseEventsGeneratorTimer",
  "ledgerVerifyTimer",
  "myobDailyEmailTimer",
  "myobReadbackTimer",
  "parseEmailsDailyRetry",
  "parseEmailsTimer",
  "plannerSyncTimer",
  "renewGraphSubscription",
  "syncAllWorkRequestsTimer",
  "tenancyCpiSyncTimer",
  "tenancyReviewScheduleTimer",
  "timesheetSyncTimer",
] as const;
export type TimerName = (typeof TIMER_NAMES)[number];

export type TimerCounts = Record<string, number | string | boolean | null>;
export type TimerBody = (timer: Timer, context: InvocationContext) => Promise<TimerCounts | void>;

const ERROR_MAX = 4000;
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

// A fresh connection per write, never the shared singleton (DL-28).
async function write(sql: string, params: SqlParam[], context: InvocationContext): Promise<SqlRow[] | null> {
  let connection;
  try {
    connection = await createServiceRequestConnection();
    return await executeQuery(connection, sql, params);
  } catch (err) {
    context.warn(`timerRuns: could not record the run: ${message(err)}`);
    return null;
  } finally {
    if (connection) closeConnection(connection);
  }
}

async function finish(
  context: InvocationContext,
  run: { id: number | null; name: string; startedAt: Date },
  outcome: "error" | "ok",
  error: string | null,
  counts: TimerCounts | null,
): Promise<void> {
  const params: SqlParam[] = [
    { name: "Outcome", type: TYPES.NVarChar, value: outcome },
    { name: "Error", type: TYPES.NVarChar, value: error === null ? null : error.slice(0, ERROR_MAX) },
    { name: "Counts", type: TYPES.NVarChar, value: counts === null ? null : JSON.stringify(counts).slice(0, ERROR_MAX) },
  ];
  if (run.id !== null) {
    await write(
      `UPDATE dbo.TimerRuns SET FinishedAt = SYSUTCDATETIME(), Outcome = @Outcome, Error = @Error, Counts = @Counts
        WHERE TimerRunId = @Id`,
      [...params, { name: "Id", type: TYPES.Int, value: run.id }],
      context,
    );
    return;
  }
  await write(
    `INSERT INTO dbo.TimerRuns (Name, StartedAt, FinishedAt, Outcome, Error, Counts)
     VALUES (@Name, @StartedAt, SYSUTCDATETIME(), @Outcome, @Error, @Counts)`,
    [
      ...params,
      { name: "Name", type: TYPES.NVarChar, value: run.name },
      { name: "StartedAt", type: TYPES.DateTime2, value: run.startedAt },
    ],
    context,
  );
}

/** Wraps a timer handler: `handler: runTimer("myTimer", myTimer)`. A body may
 *  return counts ({ scanned, deleted, … }); they are stored as JSON. */
export function runTimer(name: TimerName, body: TimerBody) {
  return async (timer: Timer, context: InvocationContext): Promise<void> => {
    const startedAt = new Date();
    const started = await write(
      `INSERT INTO dbo.TimerRuns (Name, StartedAt, Outcome)
       OUTPUT INSERTED.TimerRunId
       VALUES (@Name, SYSUTCDATETIME(), 'running')`,
      [{ name: "Name", type: TYPES.NVarChar, value: name }],
      context,
    );
    const run = { id: (started?.[0]?.TimerRunId as number | undefined) ?? null, name, startedAt };

    let counts: TimerCounts | void;
    try {
      counts = await body(timer, context);
    } catch (err) {
      context.error(`${name} failed: ${message(err)}`);
      Sentry.captureException(err, { tags: { timer: name } });
      await finish(context, run, "error", message(err), null);
      await Sentry.flush(2000);
      throw err;
    }
    await finish(context, run, "ok", null, counts ?? null);
  };
}
