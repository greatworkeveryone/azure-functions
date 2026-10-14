// Reads for the daily MYOB email (plan M4). Reads only.
//   events      DecisionLedger rows about MYOB proposals in the window, joined
//               to the proposal and, by INNER JOIN, to a company file the CFO
//               registered: a proposal for any other file is never read
//   calls       MyobApiLog outcome rows (one per call: answered, refused or
//               failed) in the window; the email drops calls for unregistered
//               files by their path
//   recipients  active users whose role is cfo

import type { Connection } from "tedious";
import { TYPES } from "tedious";
import { executeQuery, type SqlRow } from "../../db";
import type { DailyFacts, DailyRecipient, MyobCall, ProposalEvent } from "./types";

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
            f.Name AS CompanyFileName
       FROM dbo.DecisionLedger l
       INNER JOIN dbo.MyobProposals p ON p.ProposalId = TRY_CAST(l.SubjectId AS INT)
       INNER JOIN dbo.MyobCompanyFiles f ON f.CompanyFileId = p.CompanyFileId
      WHERE l.SubjectType = N'myob_proposal' AND l.Action LIKE N'myob.%'
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
  return {
    calls: calls.map(toCall),
    events: events.map(toEvent),
    files: files.map((row) => ({ id: String(row.CompanyFileId).toLowerCase(), name: text(row.Name) })),
    since,
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
