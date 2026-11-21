// Leave requests to decide (the viewer is one of the request's approvers: the reporting manager, or the eligible
// managers when none is named: leaveApprovers, the function decideLeaveRequest itself calls) and the viewer's own
// pending leave, with who has it.

import { executeQuery, type SqlRow } from "../../db";
import { leaveApprovers } from "../../leavePolicy";
import type { Candidate, SourceAdapter } from "../types";
import { iso, joinNames } from "../util";

const SQL = `SELECT TOP (500) RequestId, UserId, Kind, CONVERT(VARCHAR(10), StartDate, 23) AS StartDate, CONVERT(VARCHAR(10), EndDate, 23) AS EndDate, CreatedAt
  FROM dbo.LeaveRequests WHERE Status = N'pending' ORDER BY RequestId`;

const display = (iso10: unknown): string => {
  const [y, m, d] = String(iso10).split("-");
  return `${Number(d)}/${Number(m)}/${y}`;
};

export const leaveSource: SourceAdapter<SqlRow[]> = {
  name: "leave",
  load: (connection) => executeQuery(connection, SQL),
  derive(rows, viewer, ctx) {
    const self = ctx.staff.find((person) => viewer.oid !== null && person.oid === viewer.oid);
    if (!self) return [];
    const out: Candidate[] = [];
    for (const row of rows) {
      const subject = ctx.staff.find((person) => person.id === Number(row.UserId));
      if (!subject) continue;
      const approvers = leaveApprovers(subject, ctx.staff, ctx.links);
      const when = `${display(row.StartDate)} to ${display(row.EndDate)}`;
      const base = { chasedNext: null, dueAt: null, id: `leave:${row.RequestId}`, key: `leave:${row.RequestId}`, kind: "leave", link: "/leave?view=review", place: null, waitingSince: iso(row.CreatedAt) };
      if (subject.id === self.id) {
        out.push({ ...base, canAct: false, from: null, group: "waiting", link: "/leave", subject: `Your leave, ${when}`, verb: "Waiting for approval", with: approvers.length > 0 ? joinNames(approvers.map((person) => person.name)) : null });
      } else if (approvers.some((person) => person.id === self.id)) {
        out.push({ ...base, canAct: true, from: subject.name, group: "decide", subject: `${subject.name}'s leave, ${when}`, verb: "Decide leave" });
      }
    }
    return out;
  },
};
