// Errors myobRequest() throws instead of calling MYOB. Each refusal has
// already been written to dbo.MyobApiLog as an 'error' row by the time the
// caller sees it. Re-exported from myob-api-log.ts.

export const WRITES_DISABLED_MESSAGE = "MYOB writes disabled (MYOB_WRITES_ENABLED)";

/** Thrown instead of sending a write while MYOB_WRITES_ENABLED is not "true". */
export class MyobWritesDisabledError extends Error {
  constructor() {
    super(WRITES_DISABLED_MESSAGE);
    this.name = "MyobWritesDisabledError";
  }
}

/** The 'request' audit row could not be written, so MYOB was not called. */
export class MyobAuditLogError extends Error {
  readonly cause: unknown;
  constructor(cause: unknown) {
    super(
      `MYOB was not called because the audit log could not be written: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
    this.name = "MyobAuditLogError";
    this.cause = cause;
  }
}

export type MyobRefusalCode =
  | "not_allowed" // not on the allowlist, or into a forbidden centre
  | "outside_period" // a write dated outside the current period
  | "not_floorplan_record" // an update to a record Floorplan did not create
  | "controls" // Johanne's controls are missing or say no
  | "dry_run" // the operation is in dry run: logged with its payload, not sent
  | "config"; // a MYOB setting is missing or malformed

/** Refused inside Floorplan before anything was sent to MYOB. */
export class MyobRequestRefusedError extends Error {
  readonly code: MyobRefusalCode;
  /** The MYOB centre the request reached for, in MYOB's words, when that was the reason. */
  readonly forbiddenCentre: string | null;
  constructor(code: MyobRefusalCode, message: string, forbiddenCentre: string | null = null) {
    super(message);
    this.name = "MyobRequestRefusedError";
    this.code = code;
    this.forbiddenCentre = forbiddenCentre;
  }
}

export const MYOB_TIMEOUT_MS = 30_000;

/** MYOB did not answer within MYOB_TIMEOUT_MS. Whether a write landed is unknown. */
export class MyobTimeoutError extends Error {
  constructor() {
    super(`MYOB did not answer within ${MYOB_TIMEOUT_MS / 1000} s`);
    this.name = "MyobTimeoutError";
  }
}
