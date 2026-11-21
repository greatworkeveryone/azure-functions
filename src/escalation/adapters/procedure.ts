// The procedure adapter: a draft sent to a director for approval (procedure.approval, authority). The subject
// is the procedure's slug. Ends when the draft is published, edited (which withdraws the request) or asked of
// someone else.

import { type Connection, TYPES } from "tedious";
import { executeQuery } from "../../db";
import { APPROVAL_SUBJECTS } from "../approvals/policies";
import type { EscalationAdapter } from "./registry";

const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,98}$/;

const SQL = `SELECT TOP 1 v.Slug, v.Title, v.ApprovalRequestedBy, v.ApprovalRequestedFromName
  FROM dbo.ProcedureVersions v WHERE v.Slug = @Slug AND v.Status = 'draft'`;

async function load(connection: Connection, subjectId: string) {
  if (!SLUG_RE.test(subjectId)) return null;
  return (await executeQuery(connection, SQL, [{ name: "Slug", type: TYPES.NVarChar, value: subjectId }]))[0] ?? null;
}

export const procedureAdapter: EscalationAdapter = {
  subjectType: APPROVAL_SUBJECTS.procedure,

  deepLink: (subjectId) => `/procedures/${encodeURIComponent(subjectId)}/edit`,

  async isConditionActive(connection, ref) {
    const row = await load(connection, ref.subjectId);
    return row !== null && row.ApprovalRequestedBy !== null;
  },

  async loadSummary(connection, subjectId) {
    const row = await load(connection, subjectId);
    if (!row) return null;
    return {
      buildingId: null,
      context: { askedOf: row.ApprovalRequestedFromName ?? null, slug: subjectId },
      summary: `Procedure · ${String(row.Title ?? subjectId)}`.slice(0, 160),
    };
  },

  visibleTo: () => true,

  withdrawable: () => false,
};
