import { ledgerActionDefinition } from "./actions";
import type { LedgerEntryInput } from "./types";

export class LedgerValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerValidationError";
  }
}

const MAX_REASON_CHARS = 2000;
const MAX_SNAPSHOT_BYTES = 64 * 1024;

function assertSnapshot(label: string, value: unknown): void {
  if (value === undefined) return;
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    throw new LedgerValidationError(`${label} is not JSON-serialisable`);
  }
  if (json !== undefined && Buffer.byteLength(json, "utf8") > MAX_SNAPSHOT_BYTES) {
    throw new LedgerValidationError(`${label} exceeds ${MAX_SNAPSHOT_BYTES} bytes`);
  }
}

/** Throws LedgerValidationError when the entry can't be recorded. Pure; the
 *  caller maps the error to a 400 and the decision does not happen. */
export function assertLedgerEntry(entry: LedgerEntryInput): void {
  const def = ledgerActionDefinition(entry.action);
  if (!def) throw new LedgerValidationError(`Unknown ledger action "${entry.action}"`);

  const { id, type } = entry.subject;
  if (def.subjects !== "any" && !def.subjects.includes(type)) {
    throw new LedgerValidationError(`${entry.action} does not apply to a ${type}`);
  }
  if (id === "" || id === null || id === undefined) {
    throw new LedgerValidationError(`${entry.action} needs a subject id`);
  }

  const reason = entry.reason?.trim() ?? "";
  if (def.reasonRequired && !reason) {
    throw new LedgerValidationError(`A reason is required to ${entry.action.replace(/[._]/g, " ")}`);
  }
  if (reason.length > MAX_REASON_CHARS) {
    throw new LedgerValidationError(`Reason is longer than ${MAX_REASON_CHARS} characters`);
  }

  const { actor } = entry;
  if (!actor.name.trim()) throw new LedgerValidationError("Ledger actor needs a name");
  if (actor.kind === "user" && !actor.role.trim()) {
    throw new LedgerValidationError("Ledger user actor needs a role");
  }

  if (entry.financialImpact != null && !Number.isFinite(entry.financialImpact)) {
    throw new LedgerValidationError("financialImpact must be a finite number");
  }

  assertSnapshot("before", entry.before);
  assertSnapshot("after", entry.after);
  assertSnapshot("computed", entry.computed);
}
