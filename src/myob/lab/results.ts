// Johanne's lab results (plan M5): one ledger row per result she records, on
// the demonstration file, with her note, what she observed and whether it
// passed. Append-only, like every decision; the checklist shows the latest per
// case. (The plan's MyobLabResults table is the ledger here: no migration.)

import type { Connection } from "tedious";
import { TYPES } from "tedious";
import { executeQuery } from "../../db";
import { record, type LedgerActor } from "../../ledger";
import { MyobControlsError } from "../../myob-controls-admin";
import { labCase } from "./cases";

export interface LabResultInput {
  caseId: string;
  note: string;
  observed: string;
  pass: boolean;
  proposalId: number | null;
}

export interface LabResult {
  at: string;
  by: string;
  note: string | null;
  observed: string;
  pass: boolean;
}

export async function recordLabResult(tx: Connection, actor: LedgerActor, input: LabResultInput, demoFile: string): Promise<void> {
  const known = labCase(input.caseId);
  if (!known) throw new MyobControlsError(400, `The lab has no case "${input.caseId}"`);
  await record(tx, {
    action: "myob.lab_result",
    actor,
    after: { caseId: known.id, expected: known.expected, observed: input.observed, pass: input.pass, proposalId: input.proposalId },
    reason: input.note,
    ruleApplied: known.id,
    subject: { id: `${demoFile}:lab`, type: "myob_control" },
  });
}

export async function loadLabResults(connection: Connection, demoFile: string): Promise<Map<string, LabResult>> {
  const rows = await executeQuery(
    connection,
    `SELECT TOP (500) ActorName, OccurredAt, Reason, [After] FROM dbo.DecisionLedger
      WHERE Action = N'myob.lab_result' AND SubjectType = N'myob_control' AND SubjectId = @Subject
      ORDER BY OccurredAt DESC, LedgerId DESC`,
    [{ name: "Subject", type: TYPES.NVarChar, value: `${demoFile}:lab` }],
  );
  const latest = new Map<string, LabResult>();
  for (const row of rows) {
    let after: Record<string, unknown> = {};
    try {
      after = JSON.parse(String(row.After ?? "{}")) as Record<string, unknown>;
    } catch {
      continue;
    }
    const id = String(after.caseId ?? "");
    if (!id || latest.has(id)) continue;
    latest.set(id, {
      at: row.OccurredAt instanceof Date ? row.OccurredAt.toISOString() : String(row.OccurredAt),
      by: String(row.ActorName ?? ""),
      note: typeof row.Reason === "string" ? row.Reason : null,
      observed: String(after.observed ?? ""),
      pass: after.pass === true,
    });
  }
  return latest;
}
