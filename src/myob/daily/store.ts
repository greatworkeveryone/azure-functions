// Reads for the daily MYOB email (plan M4). Reads only.
//   events      DecisionLedger rows about MYOB proposals in the window, joined
//               to the proposal and, by INNER JOIN, to a company file the CFO
//               registered: a proposal for any other file is never read
//   calls       MyobApiLog outcome rows (one per call: answered, refused or
//               failed) in the window; the email drops calls for unregistered
//               files by their path
//   controls    the CFO's switches, a file's mode, pause/resume and the MYOB
//               link (myob.control_change, myob.link), by INNER JOIN only for a
//               registered file (the file is the subject, or the subject's part
//               before ":")
//   recipients  active users whose role is cfo
//   lastCoveredRun  where the last successful run of the same kind ended, so a
//               skipped or failed morning is covered by the next one

import type { Connection } from "tedious";
import { TYPES } from "tedious";
import { executeQuery, type SqlRow } from "../../db";
import { loadTestSubjectKeys } from "../../test-data";
import type { ControlEvent, DailyFacts, DailyRecipient, MyobCall, ProposalEvent } from "./types";

/** More than a day can hold; a run that reaches it says so in the log. */
export const MAX_CALL_ROWS = 5000;

const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);
const json = (value: unknown): Record<string, unknown> | null => {
  if (typeof value !== "string" || !value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};
const date = (value: unknown) => (value instanceof Date ? value : new Date(String(value)));

function toEvent(row: SqlRow): ProposalEvent {
  return {
    action: String(row.Action),
    actorName: text(row.ActorName) ?? "Someone",
    after: json(row.After),
    companyFileId: String(row.CompanyFileId).toLowerCase(),
    companyFileName: text(row.CompanyFileName),
    jobId: row.JobId == null ? null : Number(row.JobId),
    myobNumber: text(row.MyobNumber),
    myobUrl: text(row.MyobUrl),
    occurredAt: date(row.OccurredAt),
    operation: String(row.Operation),
    proposalId: Number(row.ProposalId),
    proposedBy: text(row.ProposedBy) ?? "Someone",
    reason: text(row.Reason),
    rendered: (json(row.Rendered) ?? {}) as ProposalEvent["rendered"],
    reviewedBy: text(row.ReviewedBy),
    ruleApplied: text(row.RuleApplied),
    subjectId: row.SubjectId == null ? null : Number(row.SubjectId),
    subjectType: text(row.SubjectType),
  };
}

function toControl(row: SqlRow): ControlEvent {
  const subject = String(row.SubjectId);
  const colon = subject.indexOf(":");
  return {
    action: row.Action === "myob.link" ? "myob.link" : "myob.control_change",
    actorName: text(row.ActorName) ?? "Someone",
    after: json(row.After),
    before: json(row.Before),
    companyFileId: String(row.CompanyFileId).toLowerCase(),
    occurredAt: date(row.OccurredAt),
    reason: text(row.Reason),
    ruleApplied: text(row.RuleApplied),
    scope: colon >= 0 ? subject.slice(colon + 1) : null,
  };
}

function toCall(row: SqlRow): MyobCall {
  return {
    actorKind: String(row.ActorKind),
    actorName: text(row.ActorName) ?? "Someone",
    errorMessage: text(row.ErrorMessage),
    httpStatus: row.HttpStatus == null ? null : Number(row.HttpStatus),
    method: String(row.Method),
    occurredAt: date(row.OccurredAt),
    path: String(row.Path),
    phase: row.Phase === "error" ? "error" : "response",
    purpose: String(row.Purpose),
  };
}

export async function loadDailyFacts(connection: Connection, since: Date, until: Date): Promise<DailyFacts> {
  const window = [
    { name: "Since", type: TYPES.DateTime2, value: since },
    { name: "Until", type: TYPES.DateTime2, value: until },
  ];
  const files = await executeQuery(connection, `SELECT CompanyFileId, Name FROM dbo.MyobCompanyFiles`);
  const events = await executeQuery(
    connection,
    `SELECT l.Action, l.ActorName, l.OccurredAt, l.RuleApplied, l.Reason, l.[After],
            p.ProposalId, p.Operation, p.CompanyFileId, p.JobId, p.MyobNumber, p.MyobUrl, p.ProposedBy, p.ReviewedBy, p.Rendered,
            p.SubjectType, p.SubjectId,
            f.Name AS CompanyFileName
       FROM dbo.DecisionLedger l
       INNER JOIN dbo.MyobProposals p ON p.ProposalId = TRY_CAST(l.SubjectId AS INT)
       INNER JOIN dbo.MyobCompanyFiles f ON f.CompanyFileId = p.CompanyFileId
      WHERE l.SubjectType = N'myob_proposal' AND l.Action LIKE N'myob.%'
        AND l.OccurredAt >= @Since AND l.OccurredAt < @Until
        -- D9: only events about a real record on a real job (positive selection).
        AND (
          (p.SubjectType = N'purchase_order' AND EXISTS (SELECT 1 FROM dbo.PurchaseOrders s JOIN dbo.Jobs sj ON sj.JobID = s.JobID WHERE s.PurchaseOrderID = p.SubjectId AND s.IsTest = 0 AND sj.IsTest = 0))
          OR (p.SubjectType = N'quote' AND EXISTS (SELECT 1 FROM dbo.Quotes s JOIN dbo.Jobs sj ON sj.JobID = s.JobID WHERE s.QuoteID = p.SubjectId AND s.IsTest = 0 AND sj.IsTest = 0))
          OR (p.SubjectType = N'invoice' AND EXISTS (SELECT 1 FROM dbo.JobInvoices s JOIN dbo.Jobs sj ON sj.JobID = s.JobID WHERE s.JobInvoiceID = p.SubjectId AND s.IsTest = 0 AND sj.IsTest = 0))
        )
      ORDER BY l.OccurredAt, l.LedgerId`,
    window,
  );
  const controls = await executeQuery(
    connection,
    `SELECT l.Action, l.ActorName, l.OccurredAt, l.RuleApplied, l.Reason, l.[Before], l.[After], l.SubjectType, l.SubjectId, f.CompanyFileId
       FROM dbo.DecisionLedger l
       INNER JOIN dbo.MyobCompanyFiles f
          ON f.CompanyFileId = CASE WHEN l.SubjectType = N'myob_control' THEN LEFT(l.SubjectId, CHARINDEX(N':', l.SubjectId + N':') - 1) ELSE l.SubjectId END
      WHERE l.Action IN (N'myob.control_change', N'myob.link')
        AND l.OccurredAt >= @Since AND l.OccurredAt < @Until
      ORDER BY l.OccurredAt, l.LedgerId`,
    window,
  );
  const calls = await executeQuery(
    connection,
    `SELECT TOP (${MAX_CALL_ROWS}) OccurredAt, Phase, Method, Path, Purpose, ActorKind, ActorName, HttpStatus, ErrorMessage
       FROM dbo.MyobApiLog
      WHERE Phase IN (N'response', N'error') AND OccurredAt >= @Since AND OccurredAt < @Until
      ORDER BY OccurredAt, LogId`,
    window,
  );
  const testKeys = await loadTestSubjectKeys(connection);
  return {
    calls: calls.map(toCall),
    controls: controls.map(toControl),
    events: events.map(toEvent),
    files: files.map((row) => ({ id: String(row.CompanyFileId).toLowerCase(), name: text(row.Name) })),
    since,
    testKeys,
    until,
  };
}

export async function loadCfoRecipients(connection: Connection): Promise<DailyRecipient[]> {
  const rows = await executeQuery(
    connection,
    `SELECT UserID, DisplayName, Email FROM dbo.AppUsers WHERE IsActive = 1 AND LOWER(LTRIM(RTRIM(Role))) = N'cfo' ORDER BY UserID`,
  );
  return rows.map((row) => ({ email: text(row.Email), name: text(row.DisplayName) ?? text(row.Email) ?? `User ${row.UserID}`, userId: Number(row.UserID) }));
}

/** When the last successful run of the same kind (live or dry run) started: it covered everything up to that morning. */
export async function lastCoveredRun(connection: Connection, dryRun: boolean): Promise<Date | null> {
  const rows = await executeQuery(
    connection,
    `SELECT TOP 1 StartedAt FROM dbo.TimerRuns
      WHERE Name = N'myobDailyEmailTimer' AND Outcome = N'ok'
        AND (CASE WHEN ISJSON(Counts) = 1 THEN JSON_VALUE(Counts, '$.dryRun') END) = @DryRun
      ORDER BY StartedAt DESC`,
    [{ name: "DryRun", type: TYPES.NVarChar, value: dryRun ? "true" : "false" }],
  );
  return rows[0] ? date(rows[0].StartedAt) : null;
}
