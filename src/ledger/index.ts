import { randomUUID } from "crypto";
import { TYPES } from "tedious";
import { executeQuery, type SqlParam } from "../db";
import { ledgerActionDefinition } from "./actions";
import { assertLedgerEntry, LedgerValidationError } from "./validate";
import type { LedgerEntryInput, LedgerTx } from "./types";

export * from "./actions";
export type * from "./types";
export { assertLedgerEntry, LedgerValidationError } from "./validate";

export function newCorrelationId(): string {
  return randomUUID();
}

// Column names are the contract with migration 094; a test keeps the two in step.
const INSERT_LEDGER_ROW = `INSERT INTO dbo.DecisionLedger
  (Action, SubjectType, SubjectId, TenantId, JobId, BuildingId,
   ActorUserId, ActorName, ActorRole, ActorKind,
   AttributedUserId, AttributedName, AttributedRole,
   Reason, [Before], [After], [Computed],
   FinancialImpact, RuleApplied, CorrelationId, AppVersion, IsException)
 VALUES
  (@Action, @SubjectType, @SubjectId, @TenantId, @JobId, @BuildingId,
   @ActorUserId, @ActorName, @ActorRole, @ActorKind,
   @AttributedUserId, @AttributedName, @AttributedRole,
   @Reason, @Before, @After, @Computed,
   @FinancialImpact, @RuleApplied, @CorrelationId, @AppVersion, @IsException)`;

const APP_VERSION_MAX_CHARS = 40;

/** JSON text for a snapshot column, or null when there is nothing to store.
 *  The column's ISJSON check accepts objects and arrays only, so a bare string,
 *  number or boolean is stored as {"value": ...} rather than failing the
 *  decision. */
function snapshotText(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const json = JSON.stringify(value);
  if (json === undefined) return null;
  return json.startsWith("{") || json.startsWith("[") ? json : JSON.stringify({ value });
}

function appVersion(): string | null {
  const raw = process.env.APP_VERSION?.trim();
  // Metadata, never worth failing a decision over: clip rather than refuse.
  return raw ? raw.slice(0, APP_VERSION_MAX_CHARS) : null;
}

/**
 * Records one decision inside the caller's open transaction (PLAN §3.12).
 *
 * Appends one row to dbo.DecisionLedger, an append-only ledger table: the row
 * can never be changed or removed afterwards. The caller owns the transaction
 * (`beginTransaction` before the decision's own writes, `commitTransaction`
 * after this resolves, `rollbackTransaction` on any throw), so a decision and
 * its ledger row commit or roll back together: no ledger row, no decision.
 *
 * Validation runs first and throws LedgerValidationError before any SQL is
 * sent, so a refused entry leaves the transaction untouched for the caller to
 * roll back. A failed INSERT rejects with the SQL error; callers must treat
 * that exactly like a failed decision write.
 *
 * `isException` comes from the action registry, not the caller, so the
 * exceptions view cannot be skewed by a call site.
 */
export async function record(tx: LedgerTx, entry: LedgerEntryInput): Promise<void> {
  assertLedgerEntry(entry);
  const def = ledgerActionDefinition(entry.action);
  if (!def) throw new LedgerValidationError(`Unknown ledger action "${entry.action}"`);

  const { actor, attributedTo } = entry;
  const params: SqlParam[] = [
    { name: "Action", type: TYPES.NVarChar, value: entry.action },
    { name: "SubjectType", type: TYPES.NVarChar, value: entry.subject.type },
    { name: "SubjectId", type: TYPES.NVarChar, value: String(entry.subject.id) },
    { name: "TenantId", type: TYPES.Int, value: entry.tenantId ?? null },
    { name: "JobId", type: TYPES.Int, value: entry.jobId ?? null },
    { name: "BuildingId", type: TYPES.Int, value: entry.buildingId ?? null },
    { name: "ActorUserId", type: TYPES.Int, value: actor.kind === "user" ? actor.userId : null },
    { name: "ActorName", type: TYPES.NVarChar, value: actor.name.trim() },
    { name: "ActorRole", type: TYPES.NVarChar, value: actor.kind === "user" ? actor.role.trim() : null },
    { name: "ActorKind", type: TYPES.NVarChar, value: actor.kind },
    { name: "AttributedUserId", type: TYPES.Int, value: attributedTo?.userId ?? null },
    { name: "AttributedName", type: TYPES.NVarChar, value: attributedTo ? attributedTo.name.trim() : null },
    { name: "AttributedRole", type: TYPES.NVarChar, value: attributedTo ? attributedTo.role.trim() : null },
    { name: "Reason", type: TYPES.NVarChar, value: entry.reason?.trim() || null },
    { name: "Before", type: TYPES.NVarChar, value: snapshotText(entry.before) },
    { name: "After", type: TYPES.NVarChar, value: snapshotText(entry.after) },
    { name: "Computed", type: TYPES.NVarChar, value: snapshotText(entry.computed) },
    // Without precision/scale tedious sends scale 0 and drops the cents.
    {
      name: "FinancialImpact",
      type: TYPES.Decimal,
      value: entry.financialImpact ?? null,
      options: { precision: 14, scale: 2 },
    },
    { name: "RuleApplied", type: TYPES.NVarChar, value: entry.ruleApplied?.trim() || null },
    { name: "CorrelationId", type: TYPES.UniqueIdentifier, value: entry.correlationId ?? newCorrelationId() },
    { name: "AppVersion", type: TYPES.NVarChar, value: appVersion() },
    { name: "IsException", type: TYPES.Bit, value: def.exception },
  ];

  await executeQuery(tx, INSERT_LEDGER_ROW, params);
}
