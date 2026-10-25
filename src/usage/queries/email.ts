import { TYPES, type Connection } from "tedious";
import { executeQuery } from "../../db";
import type { UsagePeriod } from "../period";

// Email (PLAN §14): what Floorplan has sent through EB1's Correspondence, by week, by kind, by
// template (the use case), by sending identity (the team) and by delivery outcome. Counts only: no
// subject, body or address is read. A send counts from the day it was queued; drafts that were never
// queued do not count.

export interface UsageEmailDto {
  byIdentity: { identity: string; recipients: number; sends: number; team: string | null }[];
  byKind: { kind: string; recipients: number; sends: number }[];
  byRecipientType: { count: number; recipientType: string }[];
  byTemplate: { recipients: number; sends: number; templateId: string | null }[];
  outcomes: { count: number; status: string }[];
  period: { days: number; from: string; to: string };
  totals: { recipients: number; sends: number };
  weekly: { blocked: number; failed: number; recipients: number; sends: number; sent: number; weekStart: string }[];
}

const QUEUED = `c.QueuedAt IS NOT NULL AND c.QueuedAt >= @FromUtc AND c.QueuedAt < @ToUtc`;
const DARWIN_QUEUED_DAY = `CAST(DATEADD(MINUTE, 570, c.QueuedAt) AS DATE)`;
const WEEK_START = `DATEADD(DAY, -(DATEDIFF(DAY, '19000101', ${DARWIN_QUEUED_DAY}) % 7), ${DARWIN_QUEUED_DAY})`;

export async function loadUsageEmail(connection: Connection, period: UsagePeriod): Promise<UsageEmailDto> {
  const params = [
    { name: "FromUtc", type: TYPES.DateTime2, value: period.fromUtc },
    { name: "ToUtc", type: TYPES.DateTime2, value: period.toUtc },
  ];
  const run = (sql: string) => executeQuery(connection, sql, params);
  const weekly = await run(
    `SELECT CONVERT(CHAR(10), ${WEEK_START}, 23) AS WeekStart, COUNT(*) AS Sends, SUM(c.RecipientCount) AS Recipients,
            SUM(c.SentCount) AS Sent, SUM(c.FailedCount) AS Failed, SUM(c.BlockedCount) AS Blocked
       FROM dbo.Correspondence c WHERE ${QUEUED} GROUP BY ${WEEK_START} ORDER BY ${WEEK_START}`,
  );
  const byKind = await run(
    `SELECT c.Kind, COUNT(*) AS Sends, SUM(c.RecipientCount) AS Recipients FROM dbo.Correspondence c WHERE ${QUEUED} GROUP BY c.Kind ORDER BY COUNT(*) DESC`,
  );
  const byTemplate = await run(
    `SELECT c.TemplateId, COUNT(*) AS Sends, SUM(c.RecipientCount) AS Recipients FROM dbo.Correspondence c WHERE ${QUEUED} GROUP BY c.TemplateId ORDER BY COUNT(*) DESC`,
  );
  const byIdentity = await run(
    `SELECT COALESCE(i.DisplayName, c.FromName) AS IdentityName, i.TeamLabel, COUNT(*) AS Sends, SUM(c.RecipientCount) AS Recipients
       FROM dbo.Correspondence c LEFT JOIN dbo.CommsIdentities i ON i.IdentityId = c.ReplyToIdentityId
      WHERE ${QUEUED} GROUP BY COALESCE(i.DisplayName, c.FromName), i.TeamLabel ORDER BY COUNT(*) DESC`,
  );
  const outcomes = await run(
    `SELECT r.Status, COUNT(*) AS N FROM dbo.CorrespondenceRecipients r JOIN dbo.Correspondence c ON c.CorrespondenceId = r.CorrespondenceId
      WHERE ${QUEUED} GROUP BY r.Status ORDER BY COUNT(*) DESC`,
  );
  const byType = await run(
    `SELECT r.RecipientType, COUNT(*) AS N FROM dbo.CorrespondenceRecipients r JOIN dbo.Correspondence c ON c.CorrespondenceId = r.CorrespondenceId
      WHERE ${QUEUED} GROUP BY r.RecipientType ORDER BY COUNT(*) DESC`,
  );
  const weeks = weekly.map((row) => ({
    blocked: Number(row.Blocked ?? 0),
    failed: Number(row.Failed ?? 0),
    recipients: Number(row.Recipients ?? 0),
    sends: Number(row.Sends),
    sent: Number(row.Sent ?? 0),
    weekStart: String(row.WeekStart),
  }));
  return {
    byIdentity: byIdentity.map((row) => ({
      identity: String(row.IdentityName ?? ""),
      recipients: Number(row.Recipients ?? 0),
      sends: Number(row.Sends),
      team: (row.TeamLabel as string | null) ?? null,
    })),
    byKind: byKind.map((row) => ({ kind: String(row.Kind), recipients: Number(row.Recipients ?? 0), sends: Number(row.Sends) })),
    byRecipientType: byType.map((row) => ({ count: Number(row.N), recipientType: String(row.RecipientType) })),
    byTemplate: byTemplate.map((row) => ({ recipients: Number(row.Recipients ?? 0), sends: Number(row.Sends), templateId: (row.TemplateId as string | null) ?? null })),
    outcomes: outcomes.map((row) => ({ count: Number(row.N), status: String(row.Status) })),
    period: { days: period.days, from: period.from, to: period.to },
    totals: { recipients: weeks.reduce((sum, week) => sum + week.recipients, 0), sends: weeks.reduce((sum, week) => sum + week.sends, 0) },
    weekly: weeks,
  };
}
