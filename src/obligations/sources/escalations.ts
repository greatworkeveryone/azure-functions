// Escalations sent to the viewer: the people the notifier tells (targetUsers), never ones merely visible to them
// (oversight sees more, and is not on the hook for it). An approval (authority) goes to Decide, an attention row to Do;
// ones the viewer raised are Waiting. Policies that have their own adapter, with their own authority check, are left
// out here so nothing counts twice: decision requests, next steps, director-tier approvals, leave, procedures, broadcasts,
// rent reviews, schedule changes, lease options and tenancy sign-offs.

import { TYPES } from "tedious";
import { executeQuery } from "../../db";
import { toEscalationRow, ESCALATION_COLUMNS, NOT_TEST_SUBJECT_SQL } from "../../escalation/store";
import { targetUsers } from "../../escalation/notifier";
import { availableActions } from "../../escalation/permissions";
import type { EscalationRow } from "../../escalation/types";
import { getAdapter } from "../../escalation/adapters/registry";
import "../../escalation/adapters";
import type { Candidate, SourceAdapter } from "../types";
import { iso, joinNames } from "../util";

/** Covered by a direct source with its own authority check. */
const COVERED = new Set([
  "job.decision_pending",
  "job.next_step",
  "job.approval_waiting",
  "leave.decision",
  "procedure.approval",
  "comms.broadcast_approval",
  "rent_review.approval",
  "schedule.change_ratification",
  "lease.option_approval",
  "tenancy.schedule_unsigned",
]);

const SQL = `SELECT TOP (1000) ${ESCALATION_COLUMNS.split(",").map((column) => `e.${column.trim()}`).join(", ")}
  FROM dbo.Escalations e
 WHERE e.Status IN (N'open', N'acknowledged') AND ${NOT_TEST_SUBJECT_SQL}
 ORDER BY e.EscalationId`;

export const escalationsSource: SourceAdapter<EscalationRow[]> = {
  name: "escalations",
  async load(connection) {
    const rows = await executeQuery(connection, SQL, [{ name: "ShowTest", type: TYPES.Bit, value: 0 }]);
    return rows.map(toEscalationRow).filter((row) => !COVERED.has(row.policyKey));
  },
  derive(rows, viewer, ctx) {
    const out: Candidate[] = [];
    const asViewer = { name: viewer.name, roles: viewer.roles, userId: viewer.userId };
    for (const row of rows) {
      const subjectKey = row.subjectType === "job" ? `job:${row.subjectId}` : `escalation:${row.escalationId}`;
      const link = getAdapter(row.subjectType)?.deepLink(row.subjectId, row) ?? "/escalations";
      const base = {
        chasedNext: row.status === "open" ? iso(row.dueAt) : null,
        dueAt: iso(row.dueAt),
        id: `escalation:${row.escalationId}`,
        key: subjectKey,
        kind: "escalation",
        link,
        place: null,
        subject: row.summary,
        waitingSince: iso(row.createdAt),
      };
      const targeted = viewer.userId !== null && targetUsers(row, ctx.directory).some((user) => user.userId === viewer.userId);
      if (targeted && row.raisedByUserId !== viewer.userId) {
        const actions = availableActions(asViewer, row);
        // An attention row is answered by acknowledging or resolving it, or by pushing it further up.
        const canAct = row.kind === "authority" || actions.acknowledge || actions.resolve || actions.escalateFurther;
        if (!canAct) continue;
        out.push({ ...base, canAct, from: row.raisedByName, group: row.kind === "authority" ? "decide" : "do", verb: row.kind === "authority" ? "Decide" : "Look into it" });
      } else if (viewer.userId !== null && row.raisedByUserId === viewer.userId) {
        const names = targetUsers(row, ctx.directory).map((user) => user.name);
        out.push({ ...base, canAct: false, from: null, group: "waiting", verb: "Waiting for an answer", with: names.length > 0 ? joinNames(names) : null });
      }
    }
    return out;
  },
};
