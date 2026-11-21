// The leave request adapter: describes a pending leave request to the engine for leave.decision (authority, the
// reporting manager or every eligible senior, then the CFO, then a director). Links to the review tab of /leave.
// The escalation ends with the decision (approved, declined) or the requester's withdrawal, never by hand.

import { type Connection, TYPES } from "tedious";
import { executeQuery } from "../../db";
import { APPROVAL_SUBJECTS } from "../approvals/policies";
import type { EscalationAdapter } from "./registry";

const LEAVE_SQL = `SELECT r.RequestId, r.Kind, r.Status, CONVERT(VARCHAR(10), r.StartDate, 23) AS StartDate,
    CONVERT(VARCHAR(10), r.EndDate, 23) AS EndDate, u.DisplayName
  FROM dbo.LeaveRequests r
  LEFT JOIN dbo.AppUsers u ON u.UserID = r.UserId
  WHERE r.RequestId = @RequestId`;

const KIND_WORDS: Record<string, string> = {
  annual_leave: "Annual leave",
  other_leave: "Leave",
  personal_leave: "Personal leave",
  unpaid_leave: "Unpaid leave",
};

async function load(connection: Connection, subjectId: string) {
  const id = /^\d{1,10}$/.test(subjectId) ? Number(subjectId) : Number.NaN;
  if (!Number.isInteger(id) || id <= 0) return null;
  return (await executeQuery(connection, LEAVE_SQL, [{ name: "RequestId", type: TYPES.Int, value: id }]))[0] ?? null;
}

export const leaveRequestAdapter: EscalationAdapter = {
  subjectType: APPROVAL_SUBJECTS.leave,

  deepLink: () => "/leave?view=review",

  // Authority: only asked of attention rows, which this never has. True while the request waits.
  async isConditionActive(connection, ref) {
    const row = await load(connection, ref.subjectId);
    return row !== null && row.Status === "pending";
  },

  async loadSummary(connection, subjectId) {
    const row = await load(connection, subjectId);
    if (!row) return null;
    const who = typeof row.DisplayName === "string" && row.DisplayName.trim() !== "" ? row.DisplayName.trim() : "Someone";
    const what = KIND_WORDS[String(row.Kind)] ?? "Leave";
    return {
      buildingId: null,
      context: { endDate: row.EndDate, kind: row.Kind, requestId: Number(row.RequestId), requesterName: who, startDate: row.StartDate },
      summary: `${what} · ${who} · ${row.StartDate} to ${row.EndDate}`.slice(0, 160),
    };
  },

  visibleTo: () => true,

  // The decision, or the requester withdrawing the request, ends it.
  withdrawable: () => false,
};
