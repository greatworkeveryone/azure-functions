// The one error type the engine throws for anything a caller can act on. The
// HTTP handlers turn it into a response; the sweep logs it and carries on.

export type EscalationErrorCode =
  | "already_acknowledged"
  | "authority_resolve"
  | "bad_request"
  | "condition_not_met"
  | "forbidden"
  | "no_further_level"
  | "not_found"
  | "not_live"
  | "policy_inactive"
  | "reason_required"
  | "stale"
  | "subject_not_found"
  | "target_not_eligible"
  | "unknown_policy"
  | "unknown_subject_type";

const STATUS: Record<EscalationErrorCode, number> = {
  already_acknowledged: 409,
  authority_resolve: 422,
  bad_request: 400,
  condition_not_met: 422,
  forbidden: 403,
  no_further_level: 422,
  not_found: 404,
  not_live: 409,
  policy_inactive: 422,
  reason_required: 400,
  stale: 409,
  subject_not_found: 404,
  target_not_eligible: 422,
  unknown_policy: 422,
  unknown_subject_type: 422,
};

export class EscalationError extends Error {
  readonly code: EscalationErrorCode;
  /** Extra fields for the response body (a deep link, the current row). */
  readonly details: Record<string, unknown>;
  readonly status: number;

  constructor(code: EscalationErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "EscalationError";
    this.code = code;
    this.details = details;
    this.status = STATUS[code];
  }
}

/** SQL Server unique-index and unique-constraint violations. */
export function isUniqueViolation(error: unknown): boolean {
  const number = (error as { number?: unknown } | null)?.number;
  return number === 2601 || number === 2627;
}
