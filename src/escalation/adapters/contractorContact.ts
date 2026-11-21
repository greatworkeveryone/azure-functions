// The contractor contact adapter: a contractor's email or ABN was changed and a second person has to confirm it
// (contractor.contact_changed, authority, SECA-04). The subject is the ContractorID. Ends when someone other
// than the editor confirms (confirmContractorContact). The two-weekday lapse of the purchase-order hold does not
// end it: a change nobody else has looked at stays on the list.

import { type Connection, TYPES } from "tedious";
import { executeQuery } from "../../db";
import { APPROVAL_SUBJECTS } from "../approvals/policies";
import type { EscalationAdapter } from "./registry";

const SQL = `SELECT ContractorID, ContractorName, ContactChangedBy, ContactChangedAt, ContactConfirmedAt
  FROM dbo.Contractors WHERE ContractorID = @Id`;

async function load(connection: Connection, subjectId: string) {
  const id = /^\d{1,10}$/.test(subjectId) ? Number(subjectId) : Number.NaN;
  if (!Number.isInteger(id) || id <= 0) return null;
  return (await executeQuery(connection, SQL, [{ name: "Id", type: TYPES.Int, value: id }]))[0] ?? null;
}

export const contractorContactAdapter: EscalationAdapter = {
  subjectType: APPROVAL_SUBJECTS.contractor,

  deepLink: () => "/contractors",

  async isConditionActive(connection, ref) {
    const row = await load(connection, ref.subjectId);
    return row !== null && row.ContactChangedAt !== null && row.ContactConfirmedAt === null;
  },

  async loadSummary(connection, subjectId) {
    const row = await load(connection, subjectId);
    if (!row) return null;
    const name = typeof row.ContractorName === "string" && row.ContractorName.trim() !== "" ? row.ContractorName.trim() : "A contractor";
    const by = typeof row.ContactChangedBy === "string" && row.ContactChangedBy.trim() !== "" ? row.ContactChangedBy.trim() : null;
    return {
      buildingId: null,
      context: { changedBy: by, contractorId: Number(row.ContractorID), contractorName: name },
      summary: `Contractor · ${name} · email or ABN changed${by ? ` by ${by}` : ""}`.slice(0, 160),
    };
  },

  visibleTo: () => true,

  withdrawable: () => false,
};
