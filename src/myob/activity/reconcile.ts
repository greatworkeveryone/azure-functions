// Reconciliation (SPR-M4): for each record Floorplan sent to MYOB, its own
// record against MYOB's, read now through the GET-only reader (one GET each,
// so the file's mode and purchases.read apply). Matched, differs field by
// field, missing in MYOB, or not read and why. It writes nothing: no
// discrepancy, no version, no ledger row. Accepting MYOB's record is a
// separate CFO action (acceptBaseline.ts).
//
// Selected positively, as the read-back is: the latest verified proposal for
// each (company file, MYOB uid), optionally one file, at most `limit`.

import type { Connection } from "tedious";
import { TYPES } from "tedious";
import { executeQuery } from "../../db";
import type { MyobActor } from "../../myob-api-log";
import { MyobRequestRefusedError, MyobWritesDisabledError } from "../../myob-errors";
import { PROPOSAL_COLUMNS, toProposalRow, type ProposalRow } from "../proposalRow";
import { readBackProposal } from "../readback";
import type { MyobReader } from "../readbackClient";
import type { DiscrepancyField } from "../readbackCompare";

export type ReconcileStatus = "differs" | "failed" | "matched" | "missing" | "refused";

export interface ReconcileRow {
  companyFileId: string;
  fields: DiscrepancyField[];
  message: string | null;
  myobLastModified: string | null;
  myobRowVersion: string | null;
  proposalId: number;
  proposalRowVersion: string;
  record: string;
  status: ReconcileStatus;
}

export const RECONCILE_LIMIT = 100;

async function selectSent(connection: Connection, companyFileId: string | null, limit: number): Promise<ProposalRow[]> {
  const rows = await executeQuery(
    connection,
    `SELECT TOP (@Limit) ${PROPOSAL_COLUMNS.split(",").map((c) => `p.${c.trim()}`).join(", ")}
       FROM dbo.MyobProposals p
      WHERE p.State = N'verified' AND p.MyobUid IS NOT NULL
        AND (@File IS NULL OR p.CompanyFileId = @File)
        AND p.ProposalId = (SELECT MAX(q.ProposalId) FROM dbo.MyobProposals q
                             WHERE q.CompanyFileId = p.CompanyFileId AND q.MyobUid = p.MyobUid AND q.State = N'verified')
      ORDER BY p.ProposalId DESC`,
    [
      { name: "Limit", type: TYPES.Int, value: limit },
      { name: "File", type: TYPES.NVarChar, value: companyFileId },
    ],
  );
  return rows.map(toProposalRow);
}

const label = (row: ProposalRow) => `${row.rendered?.document ?? "Record"} ${row.myobNumber ?? row.rendered?.number ?? `#${row.proposalId}`}`;

export async function reconcile(
  connection: Connection,
  actor: MyobActor,
  input: { companyFileId: string | null; limit: number },
  deps: { now: Date; reader: MyobReader },
): Promise<{ rows: ReconcileRow[] }> {
  const sent = await selectSent(connection, input.companyFileId, Math.min(input.limit, RECONCILE_LIMIT));
  const rows: ReconcileRow[] = [];
  for (const proposal of sent) {
    const base = {
      companyFileId: proposal.companyFileId, fields: [], message: null, myobLastModified: null, myobRowVersion: null,
      proposalId: proposal.proposalId, proposalRowVersion: proposal.rowVersion, record: label(proposal),
    };
    try {
      const { record, verdict } = await readBackProposal(connection, proposal, actor, deps.now, deps.reader);
      if (!record) {
        rows.push({ ...base, status: "missing" });
        continue;
      }
      const fields = verdict.discrepancy?.fields ?? [];
      rows.push({
        ...base,
        fields,
        myobLastModified: typeof record.LastModified === "string" ? record.LastModified : null,
        myobRowVersion: record.RowVersion == null ? null : String(record.RowVersion),
        status: fields.length > 0 ? "differs" : "matched",
      });
    } catch (error) {
      const refused = error instanceof MyobRequestRefusedError || error instanceof MyobWritesDisabledError;
      rows.push({ ...base, message: error instanceof Error ? error.message : String(error), status: refused ? "refused" : "failed" });
    }
  }
  return { rows };
}
