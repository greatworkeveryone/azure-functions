// The one place this app talks HTTP to MYOB, and the audit trail of every call.
//
// Every request — company-file reads and writes, and the OAuth token exchange
// and refresh — goes through myobRequest(). Each call writes an append-only
// row to dbo.MyobApiLog BEFORE it leaves (who/what was sent, secrets redacted),
// then a second row with what came back, linked by CorrelationId, so the CFO
// can audit every MYOB interaction. Nothing outside this file may call fetch()
// against MYOB; src/__tests__/myob-single-client.test.ts enforces that.
//
// Before anything is logged as sent, myob-request-guard.ts decides whether the
// call may leave at all (allowlist, period, write switch, Floorplan-created
// records only). A refusal leaves one 'error' row and throws. Every call has a
// 30 s timeout; a 429 is retried once, and so is a 5xx on a read (never on a
// write, where a retry could create a duplicate).
//
// Env:
//   MYOB_WRITES_ENABLED — only the exact string "true" lets a non-GET request
//                         reach the company file. Anything else refuses it.
//   APP_VERSION         — optional; stored in MyobApiLog.AppVersion.

import { randomUUID } from "crypto";
import { TYPES } from "tedious";
import { closeConnection, createServiceRequestConnection, executeQuery } from "./db";
import { extractMyobUid, loggablePath, redactedResponse, serialiseBody } from "./myob-api-log-format";
import { MYOB_TIMEOUT_MS, MyobAuditLogError, MyobRequestRefusedError, MyobTimeoutError } from "./myob-errors";
import { MYOB_HEALTH_SUBJECTS, raiseMyobHealth } from "./myob-health";
import type { MyobActor, MyobRequestInput, MyobResponse } from "./myob-api-types";
import { guardMyobRequest } from "./myob-request-guard";
import { Sentry } from "./sentry";

export { userActor, type MyobActor, type MyobRequestInput, type MyobResponse } from "./myob-api-types";

export { MAX_LOGGED_RESPONSE_CHARS, redactSecrets } from "./myob-api-log-format";
export {
  MYOB_TIMEOUT_MS,
  MyobAuditLogError,
  MyobRequestRefusedError,
  MyobTimeoutError,
  MyobWritesDisabledError,
  WRITES_DISABLED_MESSAGE,
} from "./myob-errors";

type Phase = "request" | "response" | "error";

interface LogRow {
  actor: MyobActor;
  attempt: number;
  correlationId: string;
  durationMs?: number;
  errorMessage?: string;
  httpStatus?: number;
  method: string;
  myobUid?: string | null;
  path: string;
  phase: Phase;
  purpose: string;
  requestBody?: string | null;
  responseBody?: string | null;
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INSERT_LOG_SQL = `INSERT INTO dbo.MyobApiLog
  (CorrelationId, Phase, Method, Path, Purpose,
   ActorKind, ActorName, ActorRole, ActorOid,
   RequestBody, HttpStatus, ResponseBody, MyobUid,
   DurationMs, ErrorMessage, Attempt, AppVersion)
VALUES
  (@CorrelationId, @Phase, @Method, @Path, @Purpose,
   @ActorKind, @ActorName, @ActorRole, @ActorOid,
   @RequestBody, @HttpStatus, @ResponseBody, @MyobUid,
   @DurationMs, @ErrorMessage, @Attempt, @AppVersion)`;

const clip = (value: string | null | undefined, max: number): string | null =>
  value == null ? null : value.slice(0, max);

// A service connection, never the caller's: the log must be writable whatever
// the caller can do, and a fresh one because tedious connections can't be shared
// between concurrent requests.
async function insertLogRow(row: LogRow): Promise<void> {
  const actor = row.actor;
  const connection = await createServiceRequestConnection();
  try {
    await executeQuery(connection, INSERT_LOG_SQL, [
      { name: "CorrelationId", type: TYPES.UniqueIdentifier, value: row.correlationId },
      { name: "Phase", type: TYPES.NVarChar, value: row.phase },
      { name: "Method", type: TYPES.NVarChar, value: clip(row.method, 10) },
      { name: "Path", type: TYPES.NVarChar, value: clip(row.path, 500) },
      { name: "Purpose", type: TYPES.NVarChar, value: clip(row.purpose, 100) },
      { name: "ActorKind", type: TYPES.NVarChar, value: actor.kind },
      { name: "ActorName", type: TYPES.NVarChar, value: clip(actor.name, 200) },
      { name: "ActorRole", type: TYPES.NVarChar, value: actor.kind === "user" ? clip(actor.role, 50) : null },
      { name: "ActorOid", type: TYPES.NVarChar, value: actor.kind === "user" ? clip(actor.oid, 100) : null },
      { name: "RequestBody", type: TYPES.NVarChar, value: row.requestBody ?? null },
      { name: "HttpStatus", type: TYPES.Int, value: row.httpStatus ?? null },
      { name: "ResponseBody", type: TYPES.NVarChar, value: row.responseBody ?? null },
      { name: "MyobUid", type: TYPES.NVarChar, value: clip(row.myobUid, 100) },
      { name: "DurationMs", type: TYPES.Int, value: row.durationMs ?? null },
      { name: "ErrorMessage", type: TYPES.NVarChar, value: clip(row.errorMessage, 2000) },
      { name: "Attempt", type: TYPES.Int, value: row.attempt },
      { name: "AppVersion", type: TYPES.NVarChar, value: clip(process.env.APP_VERSION, 50) },
    ]);
  } finally {
    closeConnection(connection);
  }
}

// For rows written AFTER the outcome is known. MYOB has already acted (or the
// call is already refused), so a failed write must not turn into a failed call
// — but it must be impossible to miss.
async function insertOutcomeRow(row: LogRow): Promise<void> {
  try {
    await insertLogRow(row);
  } catch (err) {
    // No InvocationContext here; console.error reaches the function log.
    console.error(
      `[myob-api-log] FAILED to write the '${row.phase}' audit row for ${row.method} ${row.path} (correlation ${row.correlationId}):`,
      err instanceof Error ? err.message : err,
    );
    Sentry.captureException(err, {
      extra: { correlationId: row.correlationId, method: row.method, path: row.path, phase: row.phase },
      tags: { area: "myob-api-log" },
    });
  }
}

const MAX_TRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 10_000;

// 429 means MYOB did nothing, so any call may try once more. A 5xx on a write
// may have landed: retrying could create a duplicate, so only reads retry.
function shouldRetry(method: string, status: number): boolean {
  return status === 429 || (method === "GET" && status >= 500);
}

function retryDelayMs(response: Response): number {
  const header = response.headers.get("Retry-After");
  const seconds = header === null ? NaN : Number(header);
  if (!Number.isFinite(seconds) || seconds < 0) return DEFAULT_RETRY_DELAY_MS;
  return Math.min(seconds * 1000, MAX_RETRY_DELAY_MS);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// One HTTP exchange, abandoned after MYOB_TIMEOUT_MS (headers and body).
async function send(url: string, init: RequestInit): Promise<{ response: Response; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new MyobTimeoutError()), MYOB_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    return { response, text: await response.text() };
  } catch (err) {
    throw controller.signal.aborted ? new MyobTimeoutError() : err;
  } finally {
    clearTimeout(timer);
  }
}

// A dry run keeps the exact payload it would have sent (redacted), so the CFO
// can read what Floorplan was about to do. Other refusals log no body.
async function refuse(base: Omit<LogRow, "phase">, err: unknown, body: unknown): Promise<never> {
  const dryRun = err instanceof MyobRequestRefusedError && err.code === "dry_run";
  await insertOutcomeRow({
    ...base,
    errorMessage: err instanceof Error ? err.message : String(err),
    phase: "error",
    requestBody: dryRun ? serialiseBody(body).loggable : null,
  });
  if (err instanceof MyobRequestRefusedError && err.forbiddenCentre) {
    await raiseMyobHealth(MYOB_HEALTH_SUBJECTS.agreement, `Refused ${base.method} ${base.path}: ${err.message}`, {
      actor: base.actor.name,
      centre: err.forbiddenCentre,
      correlationId: base.correlationId,
      method: base.method,
      path: base.path,
      purpose: base.purpose,
    });
  }
  throw err;
}

/**
 * The only way to make an HTTP call to MYOB.
 *
 * Order matters: a refused call is logged and thrown before anything is
 * logged as sent; the 'request' row is committed before MYOB is called (if it
 * can't be written, MYOB is not called); the outcome row is best-effort
 * because the side effect has already happened by then.
 */
export async function myobRequest(input: MyobRequestInput): Promise<MyobResponse> {
  const { actor, method, purpose, url } = input;
  if (input.correlationId !== undefined && !GUID.test(input.correlationId)) {
    throw new TypeError("myobRequest: correlationId must be a UUID");
  }
  const correlationId = input.correlationId ?? randomUUID();
  const base = { actor, attempt: input.attempt ?? 1, correlationId, method, path: loggablePath(url), purpose };

  let headers: Record<string, string>;
  try {
    const guarded = await guardMyobRequest({ body: input.body, headers: input.headers, method, url });
    headers = { ...input.headers, ...guarded.extraHeaders };
  } catch (err) {
    return refuse(base, err, input.body);
  }

  const { loggable, wire } = serialiseBody(input.body);
  for (let tries = 1; ; tries += 1) {
    const attempt = base.attempt + tries - 1;
    try {
      await insertLogRow({ ...base, attempt, phase: "request", requestBody: loggable });
    } catch (err) {
      throw new MyobAuditLogError(err);
    }

    const startedAt = Date.now();
    let exchange: { response: Response; text: string };
    try {
      exchange = await send(url, { body: wire, headers, method });
    } catch (err) {
      await insertOutcomeRow({
        ...base,
        attempt,
        durationMs: Date.now() - startedAt,
        errorMessage: err instanceof Error ? err.message : String(err),
        phase: "error",
      });
      throw err;
    }

    const { response, text } = exchange;
    const myobUid = extractMyobUid(response.headers, text);
    await insertOutcomeRow({
      ...base,
      attempt,
      durationMs: Date.now() - startedAt,
      errorMessage: response.ok ? undefined : `MYOB responded HTTP ${response.status}`,
      httpStatus: response.status,
      myobUid,
      phase: "response",
      responseBody: redactedResponse(text),
    });

    if (tries < MAX_TRIES && shouldRetry(method, response.status)) {
      await sleep(retryDelayMs(response));
      continue;
    }
    return {
      correlationId,
      headers: response.headers,
      json: <T = unknown>() => JSON.parse(text) as T,
      myobUid,
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      text,
    };
  }
}
