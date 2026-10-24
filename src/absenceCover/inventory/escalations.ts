// Live escalations aimed at an absent person by name: an attention item someone
// picked them for, or an authority escalation (a lease option, a rent review) that
// reached them. Left out, each for its reason:
//   job.decision_pending   the decision request has its own adapter and its own move
//   job.next_step          a step handed to its owner; it follows the job
//   *_notice               "did you agree to this?" to a named manager: only they can answer
//   cover.moved            a notice about cover itself: never covered in turn
//   authority, no role     nothing says which role holds the authority it needs, so no cover can be shown fit

import type { Connection } from "tedious";
import { TYPES } from "tedious";
import { executeQuery } from "../../db";
import { DECISION_PENDING_POLICY, NEXT_STEP_POLICY } from "../../escalation/decisionRows";
import { ATTRIBUTION_POLICIES } from "../../escalation/adapters/approvalAttribution";
import { getAdapter } from "../../escalation/adapters/registry";
import { ESCALATION_COLUMNS, NOT_TEST_SUBJECT_SQL, toEscalationRow } from "../../escalation/store";
import { escalationImportance } from "../importance";
import type { CoverItem } from "../types";
import { intList } from "./sqlList";

export const COVER_NOTICE_POLICY = "cover.moved";

const NEVER_COVERED = [
  DECISION_PENDING_POLICY,
  NEXT_STEP_POLICY,
  ATTRIBUTION_POLICIES.quoteNotice,
  ATTRIBUTION_POLICIES.varianceNotice,
  COVER_NOTICE_POLICY,
];

export async function loadEscalationItems(connection: Connection, userIds: readonly number[]): Promise<CoverItem[]> {
  if (userIds.length === 0) return [];
  const { params: userParams, placeholders } = intList("U", userIds);
  const NEVER_COVERED_LIST = NEVER_COVERED.map((_, index) => `@P${index}`).join(", ");
  const rows = await executeQuery(
    connection,
    `SELECT ${ESCALATION_COLUMNS.split(",").map((column) => `e.${column.trim()}`).join(", ")}
       FROM dbo.Escalations e
      WHERE e.Status IN (N'open', N'acknowledged') AND e.TargetUserId IN (${placeholders})
        AND e.PolicyKey NOT IN (${NEVER_COVERED_LIST})
        AND NOT (e.Kind = N'authority' AND e.TargetRole IS NULL)
        AND ${NOT_TEST_SUBJECT_SQL}`,
    [
      ...userParams,
      ...NEVER_COVERED.map((key, index) => ({ name: `P${index}`, type: TYPES.NVarChar, value: key })),
      { name: "ShowTest", type: TYPES.Bit, value: 0 },
    ],
  );
  return rows.map(toEscalationRow).map((row): CoverItem => {
    const rated = escalationImportance({ level: row.level, policyKey: row.policyKey, urgent: row.urgent });
    const deepLink = getAdapter(row.subjectType)?.deepLink(row.subjectId, row) ?? "/escalations";
    return {
      capability: row.kind === "authority" && row.targetRole ? null : "viewEscalations",
      deepLink,
      detail: { escalationId: row.escalationId, rowVersion: row.rowVersion },
      dueAt: row.dueAt,
      id: String(row.escalationId),
      importance: rated.importance,
      importanceCode: rated.code,
      isTest: false,
      label: row.summary,
      minRole: row.kind === "authority" && row.targetRole ? row.targetRole : null,
      money: null,
      move: "escalation_retarget",
      ownerUserId: row.targetUserId as number,
      personal: false,
      raisedByUserId: row.raisedByKind === "user" ? row.raisedByUserId : null,
      type: "escalation",
    };
  });
}
