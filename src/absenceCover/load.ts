// What the engine reads about people before it plans: who is in the directory, the
// approved leave, when each person was last seen, the nominated covers, the reporting
// lines and the approval limits. All reads; one call per fact.

import { TYPES, type Connection } from "tedious";
import { loadApprovalFacts } from "../approvalAuthority-db";
import { todayInDarwin } from "../darwinDate";
import { executeQuery } from "../db";
import { listActiveUsers } from "../escalation/store";
import type { DirectoryUser } from "../escalation/types";
import type { ReportingLink as LeaveLink, StaffMember } from "../leavePolicy";
import { loadPeople } from "../peopleWorkflow";
import type { AuthorityFacts } from "../approvalAuthority";
import type { LeaveFact } from "./absence";
import { listDelegatesOn } from "./delegateStore";
import { probeEmailColumns, type EmailColumns } from "./inventory/emails";
import type { CoverDelegate } from "./types";

export interface CoverState {
  delegates: CoverDelegate[];
  directory: DirectoryUser[];
  emailColumns: EmailColumns;
  facts: AuthorityFacts;
  /** Darwin date of the newest access-log event of anyone; null when there is none (or logging is off). */
  accessLogNewestOn: string | null;
  lastSeenOn: Map<number, string>;
  leaves: LeaveFact[];
  links: LeaveLink[];
  staff: StaffMember[];
}

/** Approved leave that has not finished, starting within 90 days: enough to see back-to-back leave run on. */
async function loadLeaves(connection: Connection, today: string): Promise<LeaveFact[]> {
  const rows = await executeQuery(
    connection,
    `SELECT RequestId, UserId, Kind, CONVERT(VARCHAR(10), StartDate, 23) AS StartDate, CONVERT(VARCHAR(10), EndDate, 23) AS EndDate, UpdatedAt
       FROM dbo.LeaveRequests
      WHERE Status = N'approved' AND EndDate >= @Today AND StartDate <= DATEADD(day, 90, @Today)`,
    [{ name: "Today", type: TYPES.Date, value: new Date(`${today}T00:00:00Z`) }],
  );
  return rows.map((row) => ({
    approvedOn: todayInDarwin(row.UpdatedAt as Date),
    endDate: String(row.EndDate),
    kind: String(row.Kind),
    requestId: Number(row.RequestId),
    startDate: String(row.StartDate),
    userId: Number(row.UserId),
  }));
}

/** The Darwin date each person was last seen in the access log, over the last 45 days. */
async function loadLastSeen(connection: Connection): Promise<Map<number, string>> {
  const rows = await executeQuery(
    connection,
    `SELECT u.UserID, MAX(a.At) AS LastAt
       FROM dbo.AccessEvents a
       INNER JOIN dbo.AppUsers u ON u.EntraOid = a.Oid
      WHERE a.At >= DATEADD(day, -45, SYSUTCDATETIME())
      GROUP BY u.UserID`,
  );
  return new Map(rows.map((row) => [Number(row.UserID), todayInDarwin(row.LastAt as Date)]));
}

/** When anybody last signed in: tells a quiet office from a log that has stopped being written. */
async function loadNewestEvent(connection: Connection): Promise<string | null> {
  const rows = await executeQuery(connection, `SELECT MAX(At) AS NewestAt FROM dbo.AccessEvents`);
  const newest = rows[0]?.NewestAt;
  return newest instanceof Date ? todayInDarwin(newest) : null;
}

export async function loadCoverState(connection: Connection, today: string, accessLoggingOn: boolean): Promise<CoverState> {
  const people = await loadPeople(connection);
  return {
    delegates: await listDelegatesOn(connection, today),
    directory: await listActiveUsers(connection),
    emailColumns: await probeEmailColumns(connection),
    facts: await loadApprovalFacts(connection, null),
    accessLogNewestOn: accessLoggingOn ? await loadNewestEvent(connection) : null,
    lastSeenOn: accessLoggingOn ? await loadLastSeen(connection) : new Map(),
    leaves: await loadLeaves(connection, today),
    links: people.links,
    staff: people.staff,
  };
}
