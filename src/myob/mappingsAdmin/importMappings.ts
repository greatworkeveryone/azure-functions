// Importing one CSV of MYOB mappings (plan M2), CFO only. A preview reads and
// says what every row would do; an apply re-reads under lock, refuses unless
// the result is exactly the preview she saw (its fingerprint), needs her note
// when it changes existing rows, writes, and ledgers one myob.control_change
// per company file it touched, with counts and every change before → after.

import type { Connection } from "tedious";
import { record, type LedgerActor } from "../../ledger";
import { MyobControlsError } from "../../myob-controls-admin";
import { CsvError, parseCsv } from "./csv";
import { KINDS, type MappingKind } from "./mappingKinds";
import { loadRefs, writePlan } from "./mappingsStore";
import { MappingImportError, planImport, type ImportPlan } from "./planImport";

export interface ImportInput {
  csv: string;
  kind: MappingKind;
  mode: "apply" | "preview";
  note: string | null;
  previewHash: string | null;
}

/** Most changes listed in one ledger row; the counts are always complete. */
const LEDGER_CHANGES = 100;

function plan(input: ImportInput, refs: Awaited<ReturnType<typeof loadRefs>>): ImportPlan {
  try {
    return planImport(input.kind, parseCsv(input.csv), refs);
  } catch (error) {
    if (error instanceof CsvError || error instanceof MappingImportError) throw new MyobControlsError(400, error.message);
    throw error;
  }
}

export async function importMappings(tx: Connection, actor: LedgerActor, input: ImportInput): Promise<{ applied: boolean; plan: ImportPlan }> {
  const result = plan(input, await loadRefs(tx, input.kind, input.mode === "apply"));
  if (input.mode === "preview") return { applied: false, plan: result };
  if (input.previewHash !== result.hash) throw new MyobControlsError(409, "The mappings or the file changed since your preview. Preview again.");
  if (result.counts.change > 0 && !input.note) throw new MyobControlsError(400, "Changing existing mappings needs your note");
  if (result.counts.add + result.counts.change === 0) return { applied: true, plan: result };

  await writePlan(tx, result, actor.name, input.note);
  const label = KINDS[input.kind].label;
  for (const file of [...new Set(result.rows.filter((row) => row.outcome === "add" || row.outcome === "change").map((row) => String(row.file)))]) {
    const rows = result.rows.filter((row) => row.file === file);
    const count = (outcome: string) => rows.filter((row) => row.outcome === outcome).length;
    const changes = rows.filter((row) => row.outcome === "change").map((row) => ({ before: row.before, after: row.after, key: row.key }));
    await record(tx, {
      action: "myob.control_change",
      actor,
      after: { added: count("add"), changed: count("change"), changes: changes.slice(0, LEDGER_CHANGES), kind: input.kind, skipped: result.counts.skip, unchanged: count("unchanged") },
      reason: input.note ?? `Imported ${count("add")} new ${label} from a CSV`,
      ruleApplied: `import.${input.kind}`,
      subject: { id: `${file}:mappings`, type: "myob_control" },
    });
  }
  return { applied: true, plan: result };
}
