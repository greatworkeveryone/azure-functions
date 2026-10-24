// Leave requests waiting for an approver who is away. A request is at risk only when
// every approver the leave rules allow for it (leaveApprovers: the reporting manager,
// or the eligible managers when none is named) is away. These can be listed and a
// cover suggested, but not moved from here: who may approve follows the reporting
// line (decideLeaveRequest), which the CFO or a director edits. Timesheets need no
// adapter: any manager in the approving role can approve, nothing is assigned to a person.

import type { Connection } from "tedious";
import { executeQuery } from "../../db";
import { businessDayStart } from "../../escalation/businessTime";
import { eligibleManager, leaveApprovers, type StaffMember } from "../../leavePolicy";
import type { ReportingLink } from "../../leavePolicy";
import { displayDate } from "../absence";
import type { CoverItem } from "../types";

export async function loadLeaveApprovalItems(
  connection: Connection,
  absentIds: ReadonlySet<number>,
  staff: readonly StaffMember[],
  links: readonly ReportingLink[],
): Promise<CoverItem[]> {
  if (absentIds.size === 0) return [];
  const rows = await executeQuery(
    connection,
    `SELECT RequestId, UserId, Kind, CONVERT(VARCHAR(10), StartDate, 23) AS StartDate, CONVERT(VARCHAR(10), EndDate, 23) AS EndDate
       FROM dbo.LeaveRequests WHERE Status = N'pending'`,
  );
  const items: CoverItem[] = [];
  for (const row of rows) {
    const subject = staff.find((person) => person.id === Number(row.UserId));
    if (!subject) continue;
    const approvers = leaveApprovers(subject, [...staff], [...links]);
    if (approvers.length === 0 || !approvers.every((person) => absentIds.has(person.id))) continue;
    items.push({
      capability: null,
      deepLink: "/leave?view=review",
      detail: {},
      dueAt: businessDayStart(String(row.StartDate)),
      id: String(row.RequestId),
      importance: "medium",
      importanceCode: "default",
      isTest: false,
      label: `${subject.name}'s leave from ${displayDate(String(row.StartDate))} to ${displayDate(String(row.EndDate))} is waiting to be approved`,
      minRole: null,
      money: null,
      move: "none",
      onlyIf: (person) => eligibleManager(subject, { id: person.userId, name: person.name, oid: "", role: person.role }),
      ownerUserId: approvers[0].id,
      personal: false,
      raisedByUserId: subject.id,
      type: "leave_approval",
    });
  }
  return items;
}
