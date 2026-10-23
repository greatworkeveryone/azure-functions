// The one-off option backfill (PLAN WP32, §12): Tenants.OptionsTotal,
// OptionsRemaining and OptionTermMonths (migration 106) filled from the
// free-text OptionPeriods with WP19's parser (leaseOptions.ts parseOptionPeriods).
// Run by hand: scripts/backfill-lease-options.cjs, a dry run unless --apply.
// It is not a migration.
//
//   fill         the text parses ("2 x 5 years"): total = remaining = the count,
//                term = the months. Remaining is the count the text gives today:
//                where the old Accept options dialog rewrote the text after an
//                exercise, the text already says what is left.
//   none         blank, or plainly no options ("Nil", "None", "N/A", "No"):
//                nothing is written; the app reads it as no options either way
//   unparseable  anything else ("Option to renew at landlord's discretion"):
//                nothing is written, and the row is listed for accounts to fix
//                the text, after which a re-run fills it
//   recorded     any of the three columns already set: never touched, so a
//                re-run (or a run after an exercise) changes nothing
//
// Writes fill only columns that are still NULL (the UPDATE says so too), in
// batches of BATCH_SIZE, each batch one transaction with one
// schedule.terms_edit ledger row per tenancy (system actor), and logs counts.
// Test tenancies are included: the columns are facts about the lease, not a send.

import type { Connection } from "tedious";
import { TYPES } from "tedious";
import { beginTransaction, commitTransaction, executeQuery, type SqlRow } from "../db";
import * as ledger from "../ledger";
import type { LedgerActor } from "../ledger";
import { parseOptionPeriods } from "../leaseOptions";
import { rollbackQuietly } from "../tenancyScheduleWrite";

export const BACKFILL_ACTOR: LedgerActor = { kind: "system", name: "backfill-lease-options" };
export const BATCH_SIZE = 50;

const NONE_WORDS = /^(?:nil|none|no|n\/?a|-+|no options?)$/i;

export interface BackfillTenancy {
  buildingId: number | null;
  buildingName: string | null;
  name: string;
  optionPeriods: string | null;
  recorded: boolean;
  tenantId: number;
}

export interface BackfillPlan {
  fill: Array<BackfillTenancy & { count: number; termMonths: number }>;
  none: number;
  recorded: number;
  unparseable: BackfillTenancy[];
}

export function planOptionBackfill(tenancies: readonly BackfillTenancy[]): BackfillPlan {
  const plan: BackfillPlan = { fill: [], none: 0, recorded: 0, unparseable: [] };
  for (const tenancy of tenancies) {
    if (tenancy.recorded) {
      plan.recorded += 1;
      continue;
    }
    const text = (tenancy.optionPeriods ?? "").trim();
    if (text === "" || NONE_WORDS.test(text)) {
      plan.none += 1;
      continue;
    }
    const parsed = parseOptionPeriods(text);
    if (parsed) plan.fill.push({ ...tenancy, count: parsed.count, termMonths: parsed.termMonths });
    else plan.unparseable.push(tenancy);
  }
  return plan;
}

const SELECT_SQL = `SELECT t.TenantId, t.BuildingId, t.LegalName, t.TradingName, t.OptionPeriods,
    t.OptionsTotal, t.OptionsRemaining, t.OptionTermMonths, b.BuildingName
  FROM dbo.Tenants t
  LEFT JOIN dbo.Buildings b ON b.BuildingID = t.BuildingId
  WHERE t.ArchivedAt IS NULL AND t.Status <> 'vacated'
  ORDER BY t.TenantId`;

function toBackfillTenancy(row: SqlRow): BackfillTenancy {
  const text = (value: unknown) => (typeof value === "string" && value.trim() !== "" ? value.trim() : null);
  return {
    buildingId: row.BuildingId === null || row.BuildingId === undefined ? null : Number(row.BuildingId),
    buildingName: text(row.BuildingName),
    name: text(row.TradingName) ?? text(row.LegalName) ?? `Tenancy ${row.TenantId}`,
    optionPeriods: text(row.OptionPeriods),
    recorded: [row.OptionsTotal, row.OptionsRemaining, row.OptionTermMonths].some((value) => value !== null && value !== undefined),
    tenantId: Number(row.TenantId),
  };
}

export interface BackfillReport {
  failed: number;
  filled: number;
  plan: BackfillPlan;
  skippedRaced: number;
}

/** Reads, plans and (with `apply`) writes. A dry run reads only. */
export async function runOptionBackfill(connection: Connection, options: { apply: boolean; log: (line: string) => void }): Promise<BackfillReport> {
  const plan = planOptionBackfill((await executeQuery(connection, SELECT_SQL)).map(toBackfillTenancy));
  const report: BackfillReport = { failed: 0, filled: 0, plan, skippedRaced: 0 };
  const { log } = options;
  log(`Live tenancies: ${plan.fill.length + plan.none + plan.recorded + plan.unparseable.length}`);
  log(`  ${options.apply ? "to fill" : "would fill"}: ${plan.fill.length}`);
  for (const row of plan.fill) log(`    ${row.tenantId}  ${row.name}: "${row.optionPeriods}" -> ${row.count} x ${row.termMonths} months`);
  log(`  already recorded (left alone): ${plan.recorded}`);
  log(`  no options stated (blank or "Nil"; nothing written): ${plan.none}`);
  log(`  unparseable, for accounts to fix (nothing written): ${plan.unparseable.length}`);
  for (const row of plan.unparseable) log(`    ${row.tenantId}  ${row.name}${row.buildingName ? ` (${row.buildingName})` : ""}: "${row.optionPeriods}"`);
  if (!options.apply) return report;

  const correlationId = ledger.newCorrelationId();
  for (let start = 0; start < plan.fill.length; start += BATCH_SIZE) {
    const batch = plan.fill.slice(start, start + BATCH_SIZE);
    await beginTransaction(connection);
    try {
      let filled = 0;
      for (const row of batch) {
        const updated = await executeQuery(
          connection,
          `UPDATE dbo.Tenants
             SET OptionsTotal = @Count, OptionsRemaining = @Count, OptionTermMonths = @TermMonths
           OUTPUT INSERTED.TenantId
           WHERE TenantId = @TenantId AND OptionsTotal IS NULL AND OptionsRemaining IS NULL AND OptionTermMonths IS NULL`,
          [
            { name: "Count", type: TYPES.Int, value: row.count },
            { name: "TermMonths", type: TYPES.Int, value: row.termMonths },
            { name: "TenantId", type: TYPES.Int, value: row.tenantId },
          ],
        );
        if (updated.length === 0) {
          report.skippedRaced += 1;
          continue;
        }
        await ledger.record(connection, {
          action: "schedule.terms_edit",
          actor: BACKFILL_ACTOR,
          after: { optionsRemaining: row.count, optionsTotal: row.count, optionTermMonths: row.termMonths },
          before: { optionPeriods: row.optionPeriods, optionsRemaining: null, optionsTotal: null, optionTermMonths: null },
          buildingId: row.buildingId,
          correlationId,
          ruleApplied: "option_backfill_from_text",
          subject: { id: row.tenantId, type: "tenancy" },
          tenantId: row.tenantId,
        });
        filled += 1;
      }
      await commitTransaction(connection);
      report.filled += filled;
      log(`  batch ${start / BATCH_SIZE + 1}: ${filled} filled`);
    } catch (error) {
      await rollbackQuietly(connection);
      report.failed += batch.length;
      log(`  batch ${start / BATCH_SIZE + 1} failed and was rolled back: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  log(`Filled ${report.filled}, ${report.skippedRaced} already filled by someone else, ${report.failed} failed.`);
  return report;
}
