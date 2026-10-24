import { ledgerActionDefinition } from "./actions";
import type { LedgerEntryInput } from "./types";

export class LedgerValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerValidationError";
  }
}

/** The most a before / after / computed snapshot may hold: its UTF-8 JSON, in bytes. */
export const LEDGER_MAX_SNAPSHOT_BYTES = 64 * 1024;

/** What the ledger counts against that cap for a snapshot (0 when there is nothing to store). */
export function snapshotBytes(value: unknown): number {
  const json = JSON.stringify(value);
  return json === undefined ? 0 : Buffer.byteLength(json, "utf8");
}

// Column widths of dbo.DecisionLedger (migration 094); a test holds the two in
// step. An entry that would not fit is refused here with a clear message
// instead of failing the INSERT with "string or binary data would be
// truncated" and taking the decision with it.
export const LEDGER_LIMITS = {
  name: 200, // ActorName, AttributedName
  reason: 2000,
  role: 32, // ActorRole, AttributedRole
  ruleApplied: 64,
  subjectId: 64,
} as const;

const INT_MAX = 2_147_483_647;
const IMPACT_LIMIT = 1e12; // DECIMAL(14,2)
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertSnapshot(label: string, value: unknown): void {
  if (value === undefined) return;
  let bytes: number;
  try {
    bytes = snapshotBytes(value);
  } catch {
    throw new LedgerValidationError(`${label} is not JSON-serialisable`);
  }
  if (bytes > LEDGER_MAX_SNAPSHOT_BYTES) {
    throw new LedgerValidationError(`${label} exceeds ${LEDGER_MAX_SNAPSHOT_BYTES} bytes`);
  }
}

function isBlank(value: unknown): boolean {
  return typeof value !== "string" || value.trim() === "";
}

function assertInt(label: string, value: number | null | undefined): void {
  if (value === null || value === undefined) return;
  if (!Number.isInteger(value) || Math.abs(value) > INT_MAX) {
    throw new LedgerValidationError(`${label} must be a whole number`);
  }
}

function assertFits(label: string, value: string, max: number): void {
  if (value.length > max) {
    throw new LedgerValidationError(`${label} is longer than ${max} characters`);
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
  assertFits("Subject id", String(id), LEDGER_LIMITS.subjectId);

  const reason = entry.reason?.trim() ?? "";
  if (def.reasonRequired && !reason) {
    throw new LedgerValidationError(`A reason is required to ${entry.action.replace(/[._]/g, " ")}`);
  }
  if (reason.length > LEDGER_LIMITS.reason) {
    throw new LedgerValidationError(`Reason is longer than ${LEDGER_LIMITS.reason} characters`);
  }

  const { actor } = entry;
  if (!actor.name.trim()) throw new LedgerValidationError("Ledger actor needs a name");
  assertFits("Ledger actor name", actor.name.trim(), LEDGER_LIMITS.name);
  if (actor.kind === "user") {
    if (!actor.role.trim()) throw new LedgerValidationError("Ledger user actor needs a role");
    assertFits("Ledger actor role", actor.role.trim(), LEDGER_LIMITS.role);
    assertInt("Ledger actor userId", actor.userId);
  }

  const attributed = entry.attributedTo;
  // Decision 18: a manager acting within their own limit names nobody else.
  const ownVariance = entry.action === "po.variance_within_tolerance" &&
    entry.ruleApplied === "within_margin_own_authority" && actor.kind === "user" &&
    ["facilities_manager", "accounts_manager", "cfo", "director"].includes(actor.role);
  if (def.attributionRequired && !attributed && !ownVariance) {
    throw new LedgerValidationError(`${entry.action} needs attributedTo: the person whose authority it relies on`);
  }
  if (attributed) {
    if (isBlank(attributed.name)) throw new LedgerValidationError("attributedTo needs a name");
    if (isBlank(attributed.role)) throw new LedgerValidationError("attributedTo needs a role");
    assertFits("attributedTo name", attributed.name.trim(), LEDGER_LIMITS.name);
    assertFits("attributedTo role", attributed.role.trim(), LEDGER_LIMITS.role);
    assertInt("attributedTo userId", attributed.userId);
    if (
      attributed.userId != null &&
      actor.kind === "user" &&
      actor.userId != null &&
      attributed.userId === actor.userId
    ) {
      throw new LedgerValidationError("attributedTo can't be the person deciding");
    }
  }

  assertInt("tenantId", entry.tenantId);
  assertInt("jobId", entry.jobId);
  assertInt("buildingId", entry.buildingId);
  if (entry.ruleApplied) assertFits("ruleApplied", entry.ruleApplied, LEDGER_LIMITS.ruleApplied);
  if (entry.correlationId !== undefined && !GUID_RE.test(entry.correlationId)) {
    throw new LedgerValidationError("correlationId must be a GUID");
  }

  if (entry.financialImpact != null) {
    if (!Number.isFinite(entry.financialImpact)) {
      throw new LedgerValidationError("financialImpact must be a finite number");
    }
    if (Math.abs(entry.financialImpact) >= IMPACT_LIMIT) {
      throw new LedgerValidationError("financialImpact is out of range");
    }
  }

  assertSnapshot("before", entry.before);
  assertSnapshot("after", entry.after);
  assertSnapshot("computed", entry.computed);
}
