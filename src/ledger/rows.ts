import type { SqlRow } from "../db";
import type { LedgerAttribution } from "./types";

// What the history and decisions endpoints return for one ledger row. Kept out
// of ledger/index.ts so jest.mock("../ledger") in other packages' tests never
// swallows it.
export interface DecisionRow {
  action: string;
  actor: {
    kind: "system" | "user";
    name: string;
    role: string | null;
    userId: number | null;
  };
  after: unknown;
  /** The person the decider named, when the decision relied on their say-so. */
  attributedTo: LedgerAttribution | null;
  before: unknown;
  buildingId: number | null;
  computed: unknown;
  correlationId: string;
  /** Annualised AUD; positive = money forgone or at risk. */
  financialImpact: number | null;
  isException: boolean;
  jobId: number | null;
  ledgerId: number;
  /** ISO 8601, UTC. */
  occurredAt: string;
  reason: string | null;
  ruleApplied: string | null;
  subjectId: string;
  subjectType: string;
  tenantId: number | null;
}

// Explicit column list: no SELECT * (a column added to the table must not leak
// into responses unreviewed). AppVersion is stored but not exposed.
export const DECISION_COLUMNS = `LedgerId, OccurredAt, Action, SubjectType, SubjectId,
  TenantId, JobId, BuildingId, ActorUserId, ActorName, ActorRole, ActorKind,
  AttributedUserId, AttributedName, AttributedRole, Reason,
  [Before], [After], [Computed], FinancialImpact, RuleApplied, CorrelationId, IsException`;

/** The CHECK constraints guarantee valid JSON, so a parse failure can only mean
 *  a damaged row; return null rather than failing the whole page. */
function parseSnapshot(text: unknown): unknown {
  if (typeof text !== "string" || text === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function orNull<T>(value: T | null | undefined): T | null {
  return value ?? null;
}

export function toDecisionRow(r: SqlRow): DecisionRow {
  const occurred = r.OccurredAt instanceof Date ? r.OccurredAt : new Date(r.OccurredAt as string);
  const attributedName = orNull(r.AttributedName as string | null | undefined);
  return {
    action: r.Action as string,
    actor: {
      kind: r.ActorKind === "system" ? "system" : "user",
      name: r.ActorName as string,
      role: orNull(r.ActorRole as string | null | undefined),
      userId: orNull(r.ActorUserId as number | null | undefined),
    },
    after: parseSnapshot(r.After),
    attributedTo:
      attributedName === null
        ? null
        : {
            name: attributedName,
            role: (r.AttributedRole as string | null | undefined) ?? "",
            userId: orNull(r.AttributedUserId as number | null | undefined),
          },
    before: parseSnapshot(r.Before),
    buildingId: orNull(r.BuildingId as number | null | undefined),
    computed: parseSnapshot(r.Computed),
    // SQL Server returns GUIDs upper-case; newCorrelationId() is lower-case.
    correlationId: String(r.CorrelationId).toLowerCase(),
    financialImpact: r.FinancialImpact === null || r.FinancialImpact === undefined ? null : Number(r.FinancialImpact),
    isException: Boolean(r.IsException),
    jobId: orNull(r.JobId as number | null | undefined),
    // BIGINT arrives as a string (tedious keeps 64-bit values exact).
    ledgerId: Number(r.LedgerId),
    occurredAt: occurred.toISOString(),
    reason: orNull(r.Reason as string | null | undefined),
    ruleApplied: orNull(r.RuleApplied as string | null | undefined),
    subjectId: String(r.SubjectId),
    subjectType: r.SubjectType as string,
    tenantId: orNull(r.TenantId as number | null | undefined),
  };
}
