// The read-back sync (plan M10): MYOB has no webhooks, so Floorplan reads back
// the records it created and says when MYOB and Floorplan disagree. Reads only,
// Purchases only (decision 11): one GET per record through the GET-only reader
// (readbackClient.ts), whose getPurchase goes through the logged MYOB client,
// so the file's mode and the CFO's purchases.read switch apply, and the
// read-back can never write.
//
// It selects positively: the latest verified proposal for each MYOB record
// Floorplan created, by proposal id, oldest check first. Records Floorplan
// didn't create are never read. It never changes a Floorplan record: a
// difference is recorded on the proposal, ledgered (myob.discrepancy) when it
// appears, changes or clears, and shown on the job.

import type { Connection } from "tedious";
import { TYPES } from "tedious";
import { executeQuery } from "../db";
import { record as ledgerRecord, type LedgerActor } from "../ledger";
import type { MyobActor } from "../myob-api-log";
import { PROPOSAL_COLUMNS, toProposalRow, type ProposalRow } from "./proposalRow";
import { getProposal, updateProposal } from "./proposalsStore";
import { KIND_OF } from "./kinds";
import { LIVE_READER, MyobPurchaseError, type MyobReader } from "./readbackClient";
import { compareReadback, NOT_FOUND_ONCE, type Discrepancy, type ReadbackVerdict } from "./readbackCompare";

export const READBACK_STALE_MINUTES = 25;

export async function selectForReadback(connection: Connection, limit: number, now: Date, staleMinutes = READBACK_STALE_MINUTES): Promise<ProposalRow[]> {
  const rows = await executeQuery(
    connection,
    `SELECT TOP (@Limit) ${PROPOSAL_COLUMNS.split(",").map((c) => `p.${c.trim()}`).join(", ")}
       FROM dbo.MyobProposals p
      WHERE p.State = N'verified' AND p.MyobUid IS NOT NULL
        AND p.ProposalId = (SELECT MAX(q.ProposalId) FROM dbo.MyobProposals q
                             WHERE q.CompanyFileId = p.CompanyFileId AND q.MyobUid = p.MyobUid AND q.State = N'verified')
        AND (p.LastReadBackAt IS NULL OR p.LastReadBackAt < @Before)
      ORDER BY p.LastReadBackAt ASC, p.ProposalId ASC`,
    [
      { name: "Limit", type: TYPES.Int, value: limit },
      { name: "Before", type: TYPES.DateTime2, value: new Date(now.getTime() - staleMinutes * 60_000) },
    ],
  );
  return rows.map(toProposalRow);
}

/** Floorplan's own last decision on the record (decision ledger): who, when, what. MYOB can't say who changed it there. */
export async function floorplanLastTouch(connection: Connection, proposal: ProposalRow): Promise<Discrepancy["floorplanLastTouch"]> {
  const rows = await executeQuery(
    connection,
    `SELECT TOP 1 ActorName, OccurredAt, Action FROM dbo.DecisionLedger
      WHERE SubjectType = @SubjectType AND SubjectId = @SubjectId ORDER BY OccurredAt DESC`,
    [
      { name: "SubjectType", type: TYPES.NVarChar, value: proposal.subjectType },
      { name: "SubjectId", type: TYPES.NVarChar, value: String(proposal.subjectId) },
    ],
  );
  const row = rows[0];
  return row ? { action: String(row.Action), at: row.OccurredAt instanceof Date ? row.OccurredAt.toISOString() : "", name: String(row.ActorName) } : null;
}

/**
 * Reads one record back from MYOB and compares it. A 404 means it is missing in
 * MYOB. Everything is compared with the record as read back after sending (the
 * same as what was sent, for a verified proposal), or, once the CFO accepted
 * MYOB's record as the baseline (activity/acceptBaseline.ts), with that record.
 */
export async function readBackProposal(
  connection: Connection,
  proposal: ProposalRow,
  actor: MyobActor,
  now: Date,
  reader: MyobReader = LIVE_READER,
): Promise<{ record: Record<string, unknown> | null; verdict: ReadbackVerdict }> {
  const kind = KIND_OF[proposal.operation];
  let current: Record<string, unknown> | null;
  try {
    current = await reader.get(kind, proposal.companyFileId, proposal.myobUid ?? "", actor, proposal.correlationId);
  } catch (error) {
    if (!(error instanceof MyobPurchaseError && error.status === 404)) throw error;
    current = null;
  }
  const verdict = compareReadback({
    floorplanLastTouch: await floorplanLastTouch(connection, proposal),
    kind,
    lastSeen: proposal.readBack,
    myob: current,
    now,
    previousStatus: proposal.myobStatus,
    sent: proposal.readBack ?? proposal.payload,
    sentLabels: { supplier: proposal.rendered?.supplier ?? "the supplier Floorplan sent" },
  });
  return { record: current, verdict };
}

const fingerprint = (discrepancy: unknown) => {
  const d = discrepancy as Discrepancy | null;
  return d ? JSON.stringify({ fields: d.fields, missing: d.missing }) : null;
};

/** Stores what the read-back saw. Returns whether the discrepancy appeared, changed or cleared. */
export async function recordReadback(
  tx: Connection,
  proposalId: number,
  outcome: { record: Record<string, unknown> | null; verdict: ReadbackVerdict },
  actor: LedgerActor,
  now: Date,
): Promise<{ discrepancyChanged: boolean; versionAdvanced: boolean }> {
  const row = await getProposal(tx, proposalId, true);
  if (!row) return { discrepancyChanged: false, versionAdvanced: false };
  const { record, verdict } = outcome;
  if (verdict.notFoundOnce) {
    // One 404 isn't "missing" yet: note it, and say so only if the next read misses too.
    const noted = await updateProposal(tx, row.proposalId, row.rowVersion, { LastReadBackAt: now, MyobStatus: NOT_FOUND_ONCE });
    if (!noted) throw new Error(`MyobProposals ${proposalId} changed during its read-back`);
    return { discrepancyChanged: false, versionAdvanced: false };
  }
  const newVersion = verdict.advanceVersion && record?.RowVersion != null ? String(record.RowVersion) : null;
  const changed = fingerprint(row.discrepancy) !== fingerprint(verdict.discrepancy);
  const updated = await updateProposal(tx, row.proposalId, row.rowVersion, {
    Discrepancy: verdict.discrepancy ? JSON.stringify(verdict.discrepancy) : null,
    LastReadBackAt: now,
    MyobSnapshot: record ? JSON.stringify(record) : row.myobSnapshot ? JSON.stringify(row.myobSnapshot) : null,
    MyobStatus: verdict.status?.slice(0, 32) ?? null,
    ...(newVersion ? { MyobRowVersion: newVersion } : {}),
  });
  if (!updated) throw new Error(`MyobProposals ${proposalId} changed during its read-back`);
  if (changed) {
    await ledgerRecord(tx, {
      action: "myob.discrepancy",
      actor,
      after: verdict.discrepancy ?? { cleared: true },
      before: row.discrepancy ?? undefined,
      correlationId: row.correlationId,
      jobId: row.jobId,
      ruleApplied: verdict.discrepancy ? (verdict.discrepancy.missing ? "missing" : "found") : "cleared",
      subject: { id: row.proposalId, type: "myob_proposal" },
    });
  }
  return { discrepancyChanged: changed, versionAdvanced: Boolean(newVersion) && newVersion !== row.myobRowVersion };
}
