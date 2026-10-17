// One run of the read-back sync (plan M10), for the timer and the on-demand
// refresh. Each record is read and recorded on its own: one failure never
// stops the others. A dry run reads MYOB and logs what it would record, and
// writes nothing.
//
// Env (both default off):
//   MYOB_READBACK_ENABLED=true   the timer reads back and records
//   MYOB_READBACK_DRY_RUN=true   reads and logs only (wins over ENABLED)

import type { Connection } from "tedious";
import { beginTransaction, commitTransaction, rollbackTransaction } from "../db";
import type { LedgerActor } from "../ledger";
import type { MyobActor } from "../myob-api-log";
import { MyobRequestRefusedError, MyobWritesDisabledError } from "../myob-errors";
import type { ProposalRow } from "./proposalRow";
import { readBackProposal, recordReadback, selectForReadback } from "./readback";

export type ReadbackMode = "dry-run" | "live" | "off";

export function readbackMode(env: NodeJS.ProcessEnv = process.env): ReadbackMode {
  if (env.MYOB_READBACK_DRY_RUN === "true") return "dry-run";
  return env.MYOB_READBACK_ENABLED === "true" ? "live" : "off";
}

export interface ReadbackCounts {
  discrepanciesChanged: number;
  dryRun: boolean;
  errors: number;
  matched: number;
  missing: number;
  /** A first 404: noted, and called missing only if the next read misses too. */
  notFoundOnce: number;
  read: number;
  refused: number;
  selected: number;
  versionsAdvanced: number;
  withDifferences: number;
}

export interface ReadbackDeps {
  read: typeof readBackProposal;
  record: typeof recordReadback;
  select: typeof selectForReadback;
}

export const READBACK_DEPS: ReadbackDeps = { read: readBackProposal, record: recordReadback, select: selectForReadback };

export interface ReadbackActors {
  ledger: LedgerActor;
  myob: MyobActor;
}

async function inTx<T>(connection: Connection, work: () => Promise<T>): Promise<T> {
  await beginTransaction(connection);
  try {
    const result = await work();
    await commitTransaction(connection);
    return result;
  } catch (error) {
    await rollbackTransaction(connection).catch(() => undefined);
    throw error;
  }
}

export async function readBackRows(
  connection: Connection,
  rows: readonly ProposalRow[],
  options: { actors: ReadbackActors; dryRun: boolean; log: (message: string) => void; now: Date },
  deps: ReadbackDeps = READBACK_DEPS,
): Promise<ReadbackCounts> {
  const counts: ReadbackCounts = {
    discrepanciesChanged: 0, dryRun: options.dryRun, errors: 0, matched: 0, missing: 0, notFoundOnce: 0, read: 0, refused: 0, selected: rows.length,
    versionsAdvanced: 0, withDifferences: 0,
  };
  for (const row of rows) {
    try {
      const outcome = await deps.read(connection, row, options.actors.myob, options.now);
      counts.read += 1;
      const { discrepancy, notFoundOnce } = outcome.verdict;
      if (notFoundOnce) counts.notFoundOnce += 1;
      else if (!discrepancy) counts.matched += 1;
      else if (discrepancy.missing) counts.missing += 1;
      else counts.withDifferences += 1;
      if (options.dryRun) {
        const found = notFoundOnce ? "not found (once)" : discrepancy ? (discrepancy.missing ? "missing in MYOB" : `differs: ${discrepancy.fields.map((f) => f.label).join(", ")}`) : "matches";
        options.log(`myob read-back (dry run): proposal #${row.proposalId} ${found}`);
        continue;
      }
      const result = await inTx(connection, () => deps.record(connection, row.proposalId, outcome, options.actors.ledger, options.now));
      if (result.discrepancyChanged) counts.discrepanciesChanged += 1;
      if (result.versionAdvanced) counts.versionsAdvanced += 1;
    } catch (error) {
      if (error instanceof MyobRequestRefusedError || error instanceof MyobWritesDisabledError) {
        counts.refused += 1;
        options.log(`myob read-back: proposal #${row.proposalId} not read: ${error.message}`);
        continue;
      }
      counts.errors += 1;
      options.log(`myob read-back: proposal #${row.proposalId} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return counts;
}

export async function runReadback(
  connection: Connection,
  options: { actors: ReadbackActors; dryRun: boolean; limit: number; log: (message: string) => void; now: Date },
  deps: ReadbackDeps = READBACK_DEPS,
): Promise<ReadbackCounts> {
  const rows = await deps.select(connection, options.limit, options.now);
  return readBackRows(connection, rows, options, deps);
}
