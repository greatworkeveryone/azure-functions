// The one place this app talks HTTP to MYOB, and the audit trail of every call.
//
// Every request — company-file reads and writes, and the OAuth token exchange
// and refresh — goes through myobRequest(). Each call writes an append-only
// row to dbo.MyobApiLog BEFORE it leaves (who/what was sent, secrets redacted),
// then a second row with what came back, linked by CorrelationId, so the CFO
// can audit every MYOB interaction. Nothing outside this file may call fetch()
// against MYOB; src/__tests__/myob-single-client.test.ts enforces that.
//
// Env:
//   MYOB_WRITES_ENABLED — only the exact string "true" lets a non-GET request
//                         reach the company file. Anything else refuses it.
//   APP_VERSION         — optional; stored in MyobApiLog.AppVersion.

import { randomUUID } from "crypto";
import { TYPES } from "tedious";
import { closeConnection, createServiceRequestConnection, executeQuery } from "./db";
import { Sentry } from "./sentry";

/**
 * Who is behind a call. Kept structurally compatible with the decision
 * ledger's actor so a decision row and its MYOB calls name the same person.
 */
export type MyobActor =
  | { kind: "user"; name: string; role?: string; userId?: number | null; oid?: string }
  | { kind: "system"; name: string };

/** Actor for a signed-in caller. `roles` is the caller's app roles, first wins. */
export function userActor(
  identity: { name: string; oid?: string },
  roles?: readonly string[],
): MyobActor {
  const role = roles?.[0];
  return {
    kind: "user",
    name: identity.name,
    ...(identity.oid ? { oid: identity.oid } : {}),
    ...(role ? { role } : {}),
  };
}

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

export interface MyobRequestInput {
  method: "GET" | "POST" | "PUT" | "DELETE";
  url: string;
  /** Objects are sent as JSON, URLSearchParams as form-encoded, strings as-is. */
  body?: unknown;
  /** Sent, never logged. */
  headers: Record<string, string>;
  actor: MyobActor;
  /** Short reason for the call, e.g. "create-bill". Stored in MyobApiLog.Purpose. */
  purpose: string;
  /** Links this call's rows to a decision-ledger row. Generated when omitted. */
  correlationId?: string;
  /** 1 unless a caller retries; stored as MyobApiLog.Attempt. */
  attempt?: number;
}

export interface MyobResponse {
  ok: boolean;
  status: number;
  statusText: string;
  headers: Headers;
  /** The raw body, read once. */
  text: string;
  correlationId: string;
  /** From the Location header or the response's UID, when MYOB gave one. */
  myobUid: string | null;
  json<T = unknown>(): T;
}

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
const SENSITIVE_KEY = /secret|token|password|code|refresh|authorization/i;
const REDACTED = "[redacted]";
export const MAX_LOGGED_RESPONSE_CHARS = 32_000;
const TRUNCATED_MARKER = "…[truncated]";

// The OAuth token exchange and refresh talk to MYOB's auth server, not the
// company file, so the write switch doesn't apply to them. Decided from the
// URL itself so a caller can't claim the exemption for a company-file write.
function isOAuthServerUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.origin === "https://secure.myob.com" && parsed.pathname.startsWith("/oauth2/");
  } catch {
    return false;
  }
}

/** Replaces the value of any key that looks like a credential, at any depth. */
export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] = SENSITIVE_KEY.test(key) ? REDACTED : redactSecrets(inner);
    }
    return out;
  }
  return value;
}

function redactedJson(text: string): string | null {
  try {
    return JSON.stringify(redactSecrets(JSON.parse(text)));
  } catch {
    return null;
  }
}

// What goes on the wire, and what is safe to store about it.
function serialiseBody(body: unknown): { loggable: string | null; wire: string | undefined } {
  if (body === undefined) return { loggable: null, wire: undefined };
  if (body instanceof URLSearchParams) {
    return {
      loggable: JSON.stringify(redactSecrets(Object.fromEntries(body))),
      wire: body.toString(),
    };
  }
  const wire = typeof body === "string" ? body : JSON.stringify(body);
  return { loggable: redactedJson(wire) ?? "[non-JSON body not logged]", wire };
}

function redactedResponse(text: string): string {
  const shown = redactedJson(text) ?? text;
  if (shown.length <= MAX_LOGGED_RESPONSE_CHARS) return shown;
  return shown.slice(0, MAX_LOGGED_RESPONSE_CHARS - TRUNCATED_MARKER.length) + TRUNCATED_MARKER;
}

// Path and query only: the host is implied, and credential-looking query
// values never reach the log.
function loggablePath(url: string): string {
  try {
    const parsed = new URL(url);
    const query: string[] = [];
    parsed.searchParams.forEach((value, key) => {
      query.push(`${key}=${SENSITIVE_KEY.test(key) ? REDACTED : encodeURIComponent(value)}`);
    });
    return (parsed.pathname + (query.length ? `?${query.join("&")}` : "")).slice(0, 500);
  } catch {
    return "[unparseable url]";
  }
}

function extractMyobUid(headers: Headers, text: string): string | null {
  const location = headers.get("Location");
  if (location) {
    const last = location.split("?")[0].replace(/\/+$/, "").split("/").pop();
    if (last) return last.slice(0, 100);
  }
  try {
    const uid = (JSON.parse(text) as { UID?: unknown } | null)?.UID;
    if (typeof uid === "string" && uid) return uid.slice(0, 100);
  } catch {
    // Not JSON (e.g. 204 No Content): no UID to record.
  }
  return null;
}

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

/**
 * The only way to make an HTTP call to MYOB.
 *
 * Order matters: a write is refused before anything is logged as sent; the
 * 'request' row is committed before MYOB is called (if it can't be written,
 * MYOB is not called); the outcome row is best-effort because the side effect
 * has already happened by then.
 */
export async function myobRequest(input: MyobRequestInput): Promise<MyobResponse> {
  const { actor, headers, method, purpose, url } = input;
  if (input.correlationId !== undefined && !GUID.test(input.correlationId)) {
    throw new TypeError("myobRequest: correlationId must be a UUID");
  }
  const correlationId = input.correlationId ?? randomUUID();
  const base = {
    actor,
    attempt: input.attempt ?? 1,
    correlationId,
    method,
    path: loggablePath(url),
    purpose,
  };

  if (method !== "GET" && !isOAuthServerUrl(url) && process.env.MYOB_WRITES_ENABLED !== "true") {
    await insertOutcomeRow({ ...base, errorMessage: WRITES_DISABLED_MESSAGE, phase: "error" });
    throw new MyobWritesDisabledError();
  }

  const { loggable, wire } = serialiseBody(input.body);
  try {
    await insertLogRow({ ...base, phase: "request", requestBody: loggable });
  } catch (err) {
    throw new MyobAuditLogError(err);
  }

  const startedAt = Date.now();
  let response: Response;
  let text: string;
  try {
    response = await fetch(url, { body: wire, headers, method });
    text = await response.text();
  } catch (err) {
    await insertOutcomeRow({
      ...base,
      durationMs: Date.now() - startedAt,
      errorMessage: err instanceof Error ? err.message : String(err),
      phase: "error",
    });
    throw err;
  }

  const myobUid = extractMyobUid(response.headers, text);
  await insertOutcomeRow({
    ...base,
    durationMs: Date.now() - startedAt,
    errorMessage: response.ok ? undefined : `MYOB responded HTTP ${response.status}`,
    httpStatus: response.status,
    myobUid,
    phase: "response",
    responseBody: redactedResponse(text),
  });

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
