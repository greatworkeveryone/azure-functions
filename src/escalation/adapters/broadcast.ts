// The broadcast adapter: a send held for approval (comms.broadcast_approval, authority). Subject type
// "correspondence", the same id the comms ledger uses. Ends with approval or cancellation.

import { type Connection, TYPES } from "tedious";
import { executeQuery } from "../../db";
import { APPROVAL_SUBJECTS } from "../approvals/policies";
import type { EscalationAdapter } from "./registry";

const SQL = `SELECT CorrespondenceId, Subject, Status, RecipientCount, CreatedByName FROM dbo.Correspondence WHERE CorrespondenceId = @Id`;

async function load(connection: Connection, subjectId: string) {
  const id = /^\d{1,10}$/.test(subjectId) ? Number(subjectId) : Number.NaN;
  if (!Number.isInteger(id) || id <= 0) return null;
  return (await executeQuery(connection, SQL, [{ name: "Id", type: TYPES.Int, value: id }]))[0] ?? null;
}

export const broadcastAdapter: EscalationAdapter = {
  subjectType: APPROVAL_SUBJECTS.broadcast,

  deepLink: (subjectId) => `/broadcast?send=${encodeURIComponent(subjectId)}`,

  async isConditionActive(connection, ref) {
    const row = await load(connection, ref.subjectId);
    return row !== null && row.Status === "awaiting_approval";
  },

  async loadSummary(connection, subjectId) {
    const row = await load(connection, subjectId);
    if (!row) return null;
    const subject = typeof row.Subject === "string" && row.Subject.trim() !== "" ? row.Subject.trim() : "Untitled send";
    const count = Number(row.RecipientCount ?? 0);
    return {
      buildingId: null,
      context: { correspondenceId: Number(row.CorrespondenceId), recipients: count, sentBy: row.CreatedByName ?? null },
      summary: `Send to ${count} ${count === 1 ? "recipient" : "recipients"} · ${subject}`.slice(0, 160),
    };
  },

  visibleTo: () => true,

  // Only the approval or the cancellation ends it.
  withdrawable: () => false,
};
