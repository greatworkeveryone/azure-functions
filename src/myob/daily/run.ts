// One run of the daily "What Floorplan did in MYOB" email (plan M4, decision
// 13c), through the morning digest's send path: mail settings checked with
// missingNotificationConfig, links from appBaseUrl, addresses through
// resolveRecipient (DEV_EMAIL_OVERRIDE), sent with graphSendMail. It goes to
// every active cfo user, and only when Floorplan did something in MYOB in the
// window. One recipient's failed send never stops the others. A dry run does
// everything except send. Reads only: nothing in the database is written.
//
//   MYOB_DAILY_EMAIL_ENABLED=true   sends
//   MYOB_DAILY_EMAIL_DRY_RUN=true   logs who it would email and what, sends nothing (wins)

import type { Connection } from "tedious";
import { resolveRecipient } from "../../email-recipient";
import { darwinDateKey, holidaysFromEnv, isBusinessDay } from "../../escalation/businessTime";
import { appBaseUrl, missingNotificationConfig } from "../../escalation/config";
import { graphSendMail } from "../../graph";
import { buildMyobDailyEmail } from "./email";
import { lastCoveredRun, loadCfoRecipients, loadDailyFacts, MAX_CALL_ROWS } from "./store";
import type { DailyFacts, DailyRecipient } from "./types";

export type MyobDailyMode = "dry-run" | "live" | "off";

export function myobDailyMode(env: NodeJS.ProcessEnv = process.env): MyobDailyMode {
  if (env.MYOB_DAILY_EMAIL_DRY_RUN === "true") return "dry-run";
  return env.MYOB_DAILY_EMAIL_ENABLED === "true" ? "live" : "off";
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** The furthest back one email reaches; older activity is in Admin → MYOB. */
export const MAX_WINDOW_DAYS = 14;

/**
 * Up to 07:30 Darwin this morning, from where the last successful run of the
 * same kind ended (07:30 on its morning), so a skipped or failed day is not
 * lost; at most MAX_WINDOW_DAYS. With no such run, from the previous business
 * morning: Monday's first email covers the weekend.
 */
export function dailyWindow(
  now: Date,
  env: NodeJS.ProcessEnv = process.env,
  lastCovered: Date | null = null,
): { gapSince: Date | null; since: Date; until: Date } {
  const holidays = holidaysFromEnv(env);
  const until = new Date(`${darwinDateKey(now)}T07:30:00+09:30`);
  if (lastCovered) {
    const covered = new Date(`${darwinDateKey(lastCovered)}T07:30:00+09:30`);
    const earliest = new Date(until.getTime() - MAX_WINDOW_DAYS * DAY_MS);
    if (covered < earliest) return { gapSince: covered, since: earliest, until };
    return { gapSince: null, since: covered >= until ? until : covered, until };
  }
  for (let back = 1; back <= 14; back += 1) {
    const key = darwinDateKey(new Date(until.getTime() - back * DAY_MS));
    if (isBusinessDay(key, holidays)) return { gapSince: null, since: new Date(`${key}T07:30:00+09:30`), until };
  }
  return { gapSince: null, since: new Date(until.getTime() - DAY_MS), until };
}

export type SendMail = (to: string[], subject: string, body: string) => Promise<void>;

export interface MyobDailyDeps {
  lastCovered(connection: Connection, dryRun: boolean): Promise<Date | null>;
  load(connection: Connection, since: Date, until: Date): Promise<DailyFacts>;
  recipients(connection: Connection): Promise<DailyRecipient[]>;
  send: SendMail;
}

export const defaultDailyDeps: MyobDailyDeps = {
  lastCovered: lastCoveredRun,
  load: loadDailyFacts,
  recipients: loadCfoRecipients,
  send: (to, subject, body) => graphSendMail(to, subject, body),
};

export interface MyobDailyReport {
  calls: number;
  changes: number;
  configMissing: string[];
  controls: number;
  created: number;
  discrepancies: number;
  dryRun: boolean;
  errors: string[];
  noAddress: number;
  nothingToSend: boolean;
  recipients: number;
  sent: number;
  wouldSend: number;
}

const firstName = (name: string) => name.trim().split(/\s+/)[0] || "there";
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 300);

export async function runMyobDaily(
  connection: Connection,
  options: { dryRun: boolean; env?: NodeJS.ProcessEnv; log: (message: string) => void; now?: Date },
  deps: MyobDailyDeps = defaultDailyDeps,
): Promise<MyobDailyReport> {
  const env = options.env ?? process.env;
  const report: MyobDailyReport = {
    calls: 0, changes: 0, configMissing: [], controls: 0, created: 0, discrepancies: 0, dryRun: options.dryRun, errors: [], noAddress: 0,
    nothingToSend: false, recipients: 0, sent: 0, wouldSend: 0,
  };
  // A dry run sends nothing, so it can be read before the mail settings exist.
  const missing = options.dryRun ? [] : missingNotificationConfig(env);
  if (missing.length > 0) {
    report.configMissing = missing;
    report.errors.push(`Notification settings are missing: ${missing.join(", ")}`);
    return report;
  }

  const { gapSince, since, until } = dailyWindow(options.now ?? new Date(), env, await deps.lastCovered(connection, options.dryRun));
  const facts: DailyFacts = { ...(await deps.load(connection, since, until)), gapSince, since, until };
  if (facts.calls.length >= MAX_CALL_ROWS) options.log(`myob daily: ${MAX_CALL_ROWS} MYOB calls or more in the window; the email shows the first ${MAX_CALL_ROWS}`);
  const baseUrl = appBaseUrl(env);
  const probe = buildMyobDailyEmail(facts, { baseUrl, firstName: "there", overriddenFrom: null });
  if (!probe) {
    report.nothingToSend = true;
    options.log("myob daily: Floorplan did nothing in MYOB in the window; no email");
    return report;
  }
  Object.assign(report, probe.counts);

  const recipients = await deps.recipients(connection);
  report.recipients = recipients.length;
  if (recipients.length === 0) report.errors.push("No active user has the cfo role, so nobody was sent the MYOB email");

  for (const recipient of recipients) {
    try {
      const resolved = resolveRecipient(recipient.email);
      if (!resolved.address) {
        report.noAddress += 1;
        options.log(`myob daily: user #${recipient.userId} (cfo) has no email address`);
        continue;
      }
      const email = buildMyobDailyEmail(facts, { baseUrl, firstName: firstName(recipient.name), overriddenFrom: resolved.overridden ? resolved.original : null });
      if (!email) continue;
      if (options.dryRun) {
        report.wouldSend += 1;
        options.log(`myob daily dry run: would email user #${recipient.userId} "${email.subject}"\n${email.body}`);
        continue;
      }
      await deps.send([resolved.address], email.subject, email.body);
      report.sent += 1;
    } catch (error) {
      report.errors.push(`user #${recipient.userId}: ${errorText(error)}`);
    }
  }
  // Something was due and nobody got it (no address, or every send failed): the run fails, so TimerRuns says so.
  if (report.sent + report.wouldSend === 0 && recipients.length > 0 && report.errors.length === 0) {
    report.errors.push(`No CFO has an email address Floorplan can use, so nobody was sent the MYOB email (${report.noAddress} without one)`);
  }
  return report;
}
