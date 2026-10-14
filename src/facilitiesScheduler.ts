// The facilities scheduler (sprint F; LAUNCH-READINESS §5 behaviour 5, WP50):
// everything facilities needs to happen because a date arrived. Run daily by
// schedulerTimer at 22:00 UTC (07:30 in Darwin).
//
//   defects reminders   60 and 30 days before a defects liability period ends,
//                       a defects_period escalation to the facilities manager
//                       (digest, not urgent). Raised once per period per end
//                       date: a reminder someone already dealt with is not
//                       raised again unless the end date changes.
//
// Opt-in, because it writes: SCHEDULER_ENABLED must equal "true".
// SCHEDULER_DRY_RUN=true reads, logs with counts what it would do, and writes
// nothing (it wins over ENABLED). A failure on one record is collected and the
// run carries on; the timer reports the failures.

import { TYPES, type Connection } from "tedious";
import { addDaysIso, todayInDarwin } from "./darwinDate";
import { executeQuery } from "./db";
import { periodRowToApi, periodsEndingBetween, toCoveragePeriod } from "./defectsPeriods";
import { DEFECTS_POLICIES, DEFECTS_SUBJECT_TYPE, defectsPeriodLabel, defectsReminderHeadline } from "./escalation/adapters/defectsPeriod";
import { raise } from "./escalation/engine";
import { defectsReminderStage } from "./facilitiesRules";
import type { LedgerActor } from "./ledger";

export type SchedulerMode = "off" | "dry-run" | "live";

export function schedulerMode(env: NodeJS.ProcessEnv = process.env): SchedulerMode {
  if (env.SCHEDULER_DRY_RUN === "true") return "dry-run";
  return env.SCHEDULER_ENABLED === "true" ? "live" : "off";
}

export const SCHEDULER_ACTOR: LedgerActor = { kind: "system", name: "schedulerTimer" };

export interface SchedulerOptions {
  dryRun: boolean;
  log: (message: string) => void;
  now?: Date;
  warn: (message: string) => void;
}

export interface SchedulerReport {
  defects: { alreadyOpen: number; considered: number; raised: number; skippedAlreadySent: number; wouldRaise: number };
  errors: string[];
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Whether this reminder was ever raised for this period and end date. */
async function reminderAlreadySent(connection: Connection, subjectId: string, policyKey: string, endsOn: string): Promise<boolean> {
  const rows = await executeQuery(
    connection,
    `SELECT TOP 1 EscalationId FROM dbo.Escalations
      WHERE SubjectType = @SubjectType AND SubjectId = @SubjectId AND PolicyKey = @PolicyKey
        AND JSON_VALUE(Context, '$.endsOn') = @EndsOn`,
    [
      { name: "SubjectType", type: TYPES.NVarChar, value: DEFECTS_SUBJECT_TYPE },
      { name: "SubjectId", type: TYPES.NVarChar, value: subjectId },
      { name: "PolicyKey", type: TYPES.NVarChar, value: policyKey },
      { name: "EndsOn", type: TYPES.NVarChar, value: endsOn },
    ],
  );
  return rows.length > 0;
}

async function runDefectsReminders(connection: Connection, options: SchedulerOptions, report: SchedulerReport): Promise<void> {
  const now = options.now ?? new Date();
  const today = todayInDarwin(now);
  const rows = await periodsEndingBetween(connection, today, addDaysIso(today, 60));
  for (const row of rows) {
    const period = periodRowToApi(row, today);
    const stage = defectsReminderStage(toCoveragePeriod(period), today);
    if (stage === null) continue;
    report.defects.considered += 1;
    const policyKey = stage === 30 ? DEFECTS_POLICIES.endsIn30 : DEFECTS_POLICIES.endsIn60;
    const subjectId = String(period.defectsPeriodId);
    try {
      if (await reminderAlreadySent(connection, subjectId, policyKey, period.endsOn)) {
        report.defects.skippedAlreadySent += 1;
        continue;
      }
      if (options.dryRun) {
        report.defects.wouldRaise += 1;
        options.log(`schedulerTimer (dry run): would raise ${policyKey} for defects period ${subjectId} (${defectsPeriodLabel(period)})`);
        continue;
      }
      const result = await raise(connection, {
        actor: SCHEDULER_ACTOR,
        context: { endsOn: period.endsOn },
        headline: defectsReminderHeadline(period, today),
        notify: { attempts: 2 },
        now,
        policyKey,
        skipConditionCheck: true,
        subjectId,
        subjectType: DEFECTS_SUBJECT_TYPE,
      });
      if (result.created) report.defects.raised += 1;
      else report.defects.alreadyOpen += 1;
    } catch (error) {
      report.errors.push(`defects period ${subjectId}: ${errorText(error)}`);
    }
  }
  const d = report.defects;
  options.log(
    `schedulerTimer: defects reminders: ${d.considered} due, ${d.raised} raised, ${d.alreadyOpen} already open, ${d.skippedAlreadySent} already sent${options.dryRun ? `, ${d.wouldRaise} would be raised (dry run)` : ""}`,
  );
}

export async function runFacilitiesScheduler(connection: Connection, options: SchedulerOptions): Promise<SchedulerReport> {
  const report: SchedulerReport = {
    defects: { alreadyOpen: 0, considered: 0, raised: 0, skippedAlreadySent: 0, wouldRaise: 0 },
    errors: [],
  };
  try {
    await runDefectsReminders(connection, options, report);
  } catch (error) {
    report.errors.push(`defects reminders: ${errorText(error)}`);
  }
  return report;
}
