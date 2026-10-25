import { newCorrelationId, record } from "./ledger";
import { LEDGER_MAX_SNAPSHOT_BYTES, snapshotBytes } from "./ledger/validate";
import type { LedgerEntryInput, LedgerTx } from "./ledger";

// The ledger rows for an info sheet change (S3-6, D11 re-check). A delete used to
// ledger the whole sheet against a 64 KB cap, so a sheet over that size could not
// lose a row. Now only what the change names is kept: the entry removed (with where
// it was) or the rows added. An entry too big for one ledger row is not refused:
// its JSON is cut into slices, one ledger row each, in the caller's transaction and
// sharing a correlation id, each row `{ part, parts, json }`. To read it back, join
// the `json` of the parts in order and parse.

/** Seven eighths of the ledger's cap, so a field added to a row later can't tip a full one over it. */
const ROW_BUDGET_BYTES = Math.floor((LEDGER_MAX_SNAPSHOT_BYTES / 8) * 7);

/**
 * Each slice, in characters. Written as an escaped string inside the row, a slice
 * costs at most 6 bytes a character (a half of a surrogate pair is escaped on its
 * own), so 8,000 characters is under the budget whatever the text holds.
 */
const SLICE_CHARS = 8_000;

/** What goes in a snapshot column, as one value when it fits and as ordered slices when it doesn't; none for nothing. */
export function snapshotParts(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  if (snapshotBytes(value) <= ROW_BUDGET_BYTES) return [value];
  const json = JSON.stringify(value);
  const parts = Math.ceil(json.length / SLICE_CHARS);
  return Array.from({ length: parts }, (_unused, index) => ({
    json: json.slice(index * SLICE_CHARS, (index + 1) * SLICE_CHARS),
    part: index + 1,
    parts,
  }));
}

/** One ledger row for the change, or several when what it kept is too big for one. Inside the caller's open transaction. */
export async function recordInfoSheetChange(tx: LedgerTx, entry: LedgerEntryInput): Promise<void> {
  const before = snapshotParts(entry.before);
  const after = snapshotParts(entry.after);
  if (before.length <= 1 && after.length <= 1) {
    await record(tx, { ...entry, after: after[0], before: before[0] });
    return;
  }
  const correlationId = entry.correlationId ?? newCorrelationId();
  for (let index = 0; index < Math.max(before.length, after.length); index += 1) {
    await record(tx, { ...entry, after: after[index], before: before[index], correlationId });
  }
}
