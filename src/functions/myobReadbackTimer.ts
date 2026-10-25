import { app, InvocationContext, Timer } from "@azure/functions";
import { closeConnection, createServiceRequestConnection } from "../db";
import { darwinDateKey, darwinMinuteOfDay, isBusinessDay } from "../escalation/businessTime";
import { readbackMode, runReadback } from "../myob/readbackRun";
import { runTimer, type TimerCounts } from "../timerRuns";

// ── Timer trigger: every 30 minutes ──────────────────────────────────────────
// The MYOB read-back sync (plan M10): reads back the records Floorplan created
// in MYOB and records where MYOB now differs, is missing the record, or shows
// it paid. Every half hour in Darwin business hours (07:00 to 18:00, business
// days), on the hour otherwise. At most READBACK_LIMIT records a run, oldest
// check first.
//
// Off unless asked (both default off; dry run wins):
//   MYOB_READBACK_DRY_RUN=true   reads MYOB and logs what it would record; writes nothing
//   MYOB_READBACK_ENABLED=true   reads and records
// It also needs the company file in read or write mode and the CFO's
// purchases.read switch on: myobRequest refuses otherwise, and the run counts
// those as refused, not as failures.

export const READBACK_LIMIT = 50;
export const READBACK_CRON = "0 0,30 * * * *";
const ACTOR = "myobReadbackTimer";

export function readbackDue(now: Date): boolean {
  const minute = darwinMinuteOfDay(now);
  const inHours = isBusinessDay(darwinDateKey(now)) && minute >= 7 * 60 && minute < 18 * 60;
  return inHours || minute % 60 < 15;
}

export async function myobReadbackTimer(_timer: Timer, context: InvocationContext): Promise<TimerCounts | void> {
  const mode = readbackMode();
  if (mode === "off") {
    context.log(`${ACTOR}: off. Set MYOB_READBACK_DRY_RUN=true to see what it would record, then MYOB_READBACK_ENABLED=true.`);
    return;
  }
  const now = new Date();
  if (!readbackDue(now)) {
    context.log(`${ACTOR}: outside business hours, runs on the hour only`);
    return;
  }
  let connection;
  try {
    connection = await createServiceRequestConnection();
    const counts = await runReadback(connection, {
      actors: { ledger: { kind: "system", name: ACTOR }, myob: { kind: "system", name: ACTOR } },
      dryRun: mode === "dry-run",
      limit: READBACK_LIMIT,
      log: (message) => context.log(message),
      now,
    });
    context.log(`${ACTOR}: ${JSON.stringify(counts)}`);
    // Every record failing is a broken run, not a quiet one: runTimer records and rethrows.
    if (counts.errors > 0 && counts.read + counts.refused === 0) throw new Error(`MYOB read-back: all ${counts.errors} reads failed`);
    return { ...counts };
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.timer("myobReadbackTimer", {
  handler: runTimer("myobReadbackTimer", myobReadbackTimer),
  schedule: READBACK_CRON,
});
