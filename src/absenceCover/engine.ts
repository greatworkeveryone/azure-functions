// The cover engine (PLAN §13, AW1). Every 30 minutes on a business day it finds who is
// away (absence.ts), what is waiting on them (inventory/), decides for each item
// whether it moves now or is only suggested (policy.ts), picks the cover
// (resolveCover.ts) and carries the moves out (moves/apply.ts).
//
// Selection is positive: exactly the people who are away and exactly their items. It is
// idempotent: a moved item is no longer theirs, a suggestion is not written twice for
// one absence, and a manager's "keep" holds for that absence. At most
// ABSENCE_COVER_MAX_ACTIONS ledger rows a run, most urgent first; the rest wait for the
// next run (the report counts them). Nothing is approved, answered or decided.
//
// Dry run: `suggested` rows only, nothing moved; a would-move says so in its reason.

import { randomUUID } from "node:crypto";
import type { Connection } from "tedious";
import { todayInDarwin } from "../darwinDate";
import { holidaysFromEnv, isBusinessDay } from "../escalation/businessTime";
import { MAX_INACTIVE_SHARE, type CoverMode } from "./config";
import { applyCoverAction } from "./moves/apply";
import type { PlanEntry } from "./plan";
import { loadLiveView } from "./view";

export interface RunOptions {
  accessLoggingOn: boolean;
  connection: Connection;
  inactivityDays: number;
  log?: (message: string) => void;
  maxActions: number;
  mode: Exclude<CoverMode, "off">;
  now?: Date;
  onError?: (error: unknown, entry: PlanEntry) => void;
}

export interface RunReport {
  /** Why the run did nothing: too many people looked absent from their sign-ins to trust. Null for a normal run. */
  aborted: string | null;
  absent: number;
  alreadyHandled: number;
  businessDay: boolean;
  deferred: number;
  dryRun: boolean;
  errors: { item: string; message: string }[];
  escalated: number;
  inactivityAvailable: boolean;
  items: number;
  moved: number;
  notStranded: number;
  raced: number;
  stayed: number;
  suggested: number;
  wouldMove: number;
}

const EMPTY: Omit<RunReport, "businessDay" | "dryRun"> = {
  aborted: null, absent: 0, alreadyHandled: 0, deferred: 0, errors: [], escalated: 0, inactivityAvailable: false, items: 0, moved: 0, notStranded: 0, raced: 0, stayed: 0, suggested: 0, wouldMove: 0,
};

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Whether a dry run or a suggestion run has already written this suggestion for this absence. */
function alreadySuggested(entry: PlanEntry): boolean {
  const { last } = entry;
  return last !== null && last.action === "suggested" && last.fromUserId === entry.absent.userId && last.absenceRef === entry.absent.ref;
}

export async function runAbsenceCover(options: RunOptions): Promise<RunReport> {
  const { connection, mode } = options;
  const log = options.log ?? (() => undefined);
  const now = options.now ?? new Date();
  const today = todayInDarwin(now);
  const holidays = holidaysFromEnv();
  const report: RunReport = { ...EMPTY, businessDay: isBusinessDay(today, holidays), dryRun: mode === "dry-run", errors: [] };
  if (!report.businessDay) {
    log(`absenceCover: ${today} is not a business day; nothing to do`);
    return report;
  }

  const view = await loadLiveView(connection, {
    accessLoggingOn: options.accessLoggingOn,
    inactivityDays: options.inactivityDays,
    now,
  });
  const { plan } = view;
  report.absent = view.absent.length;
  report.inactivityAvailable = view.inactivityAvailable;
  report.items = view.items.length;
  report.alreadyHandled = plan.alreadyHandled;
  report.notStranded = plan.notStranded;
  report.stayed = plan.stayed;

  const inactive = view.absent.filter((person) => person.kind === "inactive").length;
  const active = view.context.directory.length;
  if (active > 0 && inactive / active > MAX_INACTIVE_SHARE) {
    report.aborted = `${inactive} of ${active} active staff look absent from their sign-ins, which is too many to trust (limit ${MAX_INACTIVE_SHARE * 100}%); check that access logging is working`;
    log(`absenceCover: aborted: ${report.aborted}`);
    return report;
  }

  const runId = randomUUID();
  let written = 0;
  for (const entry of plan.entries) {
    const live = mode === "live";
    const writes = live ? entry.action : "suggested";
    if (writes === "suggested" && alreadySuggested(entry)) continue;
    if (written >= options.maxActions) {
      report.deferred += 1;
      continue;
    }
    written += 1;
    try {
      const wouldMove = !live && entry.action !== "suggested" && entry.resolution.found;
      const result = await applyCoverAction(connection, {
        absent: entry.absent,
        action: writes,
        actor: { kind: "system" },
        cover: entry.resolution.found ? entry.resolution : null,
        dryRun: !live,
        item: entry.item,
        reasonCode: wouldMove ? "dry_run_would_move" : entry.reasonCode,
        reasonText: wouldMove ? `Dry run: would have moved this. ${entry.reasonText}` : entry.reasonText,
        runId,
      });
      if (result.status === "skipped") {
        report.raced += 1;
        continue;
      }
      await result.announce().catch(() => undefined);
      if (wouldMove) report.wouldMove += 1;
      else if (writes === "reassigned") report.moved += 1;
      else if (writes === "escalated") report.escalated += 1;
      else report.suggested += 1;
    } catch (error) {
      report.errors.push({ item: `${entry.item.type}:${entry.item.id}`, message: message(error) });
      options.onError?.(error, entry);
    }
  }
  log(`absenceCover: ${mode}; ${report.absent} away, ${report.items} items, ${report.moved} moved, ${report.escalated} escalated, ${report.suggested} suggested, ${report.wouldMove} would move, ${report.deferred} deferred`);
  return report;
}
