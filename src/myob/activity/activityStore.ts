// Reads for the MYOB Activity view (SPR-M4). Reads only.
//   proposals  every proposal of a registered company file, newest first
//   calls      one MyobApiLog outcome row per call (answered, refused or
//              failed), with the proposal it served (by correlation id)
// Filters are parameters; at most PROPOSAL_ROWS / CALL_ROWS rows, newest first.

import type { Connection } from "tedious";
import { TYPES } from "tedious";
import { executeQuery, type SqlRow } from "../../db";
import type { ActivityFilters } from "./activityInput";

export const PROPOSAL_ROWS = 500;
export const CALL_ROWS = 2000;

const window = (filters: ActivityFilters) => [
  { name: "From", type: TYPES.DateTime2, value: filters.from },
  { name: "To", type: TYPES.DateTime2, value: filters.to },
];

export function loadProposalRows(connection: Connection, filters: ActivityFilters): Promise<SqlRow[]> {
  return executeQuery(
    connection,
    `SELECT TOP (${PROPOSAL_ROWS}) p.ProposalId, p.Operation, p.State, p.CompanyFileId, f.Name AS FileName, p.Rendered, p.ProposedBy, p.ProposedAt,
            p.ReviewedBy, p.ReviewedAt, p.PushedAt, p.MyobNumber, p.MyobError, p.LastReadBackAt, p.MyobStatus, p.Discrepancy
       FROM dbo.MyobProposals p JOIN dbo.MyobCompanyFiles f ON f.CompanyFileId = p.CompanyFileId
      WHERE (@File IS NULL OR p.CompanyFileId = @File) AND (@State IS NULL OR p.State = @State)
        AND (@From IS NULL OR p.ProposedAt >= @From) AND (@To IS NULL OR p.ProposedAt < @To)
      ORDER BY p.ProposalId DESC`,
    [
      { name: "File", type: TYPES.NVarChar, value: filters.companyFileId },
      { name: "State", type: TYPES.NVarChar, value: filters.state },
      ...window(filters),
    ],
  );
}

export function loadCallRows(connection: Connection, filters: ActivityFilters): Promise<SqlRow[]> {
  return executeQuery(
    connection,
    `SELECT TOP (${CALL_ROWS}) l.LogId, l.OccurredAt, l.Phase, l.Method, l.Path, l.Purpose, l.ActorKind, l.ActorName, l.HttpStatus, l.ErrorMessage,
            l.DurationMs, p.ProposalId
       FROM dbo.MyobApiLog l
       OUTER APPLY (SELECT TOP 1 q.ProposalId, q.CompanyFileId FROM dbo.MyobProposals q WHERE q.CorrelationId = l.CorrelationId ORDER BY q.ProposalId DESC) p
      WHERE l.Phase IN (N'response', N'error') AND (@From IS NULL OR l.OccurredAt >= @From) AND (@To IS NULL OR l.OccurredAt < @To)
      ORDER BY l.OccurredAt DESC, l.LogId DESC`,
    window(filters),
  );
}

export async function loadRegisteredFiles(connection: Connection): Promise<Map<string, string>> {
  const rows = await executeQuery(connection, `SELECT CompanyFileId, Name FROM dbo.MyobCompanyFiles`);
  return new Map(rows.map((row) => [String(row.CompanyFileId).toLowerCase(), typeof row.Name === "string" && row.Name ? row.Name : String(row.CompanyFileId)]));
}
