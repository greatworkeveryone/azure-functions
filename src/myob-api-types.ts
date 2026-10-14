// The shapes myobRequest() takes and returns, and who a call is made for.
// Re-exported from myob-api-log.ts, which is where callers import them from.

import type { MyobMethod } from "./myob-endpoints";

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

export interface MyobRequestInput {
  method: MyobMethod;
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
