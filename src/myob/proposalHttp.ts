// What every MYOB proposal endpoint shares: who may do what, the person
// behind the request, a transaction on the request's connection, and turning
// a refusal into its status with the plain reasons.
//
//   propose / update  accounts_manager, facilities_manager, cfo, director
//                     (never admin on its own: decision 4)
//   approve and send  the myobController capability, role cfo
//   withdraw          the proposer, or the CFO
// A further network and MFA gate on these money endpoints is sprint S11's.

import type { HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import type { Connection } from "tedious";
import { errorResponse, extractToken, rolesForRequest, unauthorizedResponse, verifiedIdentityFromRequest } from "../auth";
import { beginTransaction, closeConnection, commitTransaction, createRequestConnection, rollbackTransaction } from "../db";
import { LedgerValidationError } from "../ledger";
import { resolveLedgerActor } from "../ledger/actor";
import { isMyobController } from "../myob-controls-admin";
import { ProposalError } from "./proposalErrors";
import type { Person } from "./propose";

export const PROPOSER_ROLES: readonly string[] = ["accounts_manager", "facilities_manager", "cfo", "director"];

export const canPropose = (roles: readonly string[]) => roles.some((role) => PROPOSER_ROLES.includes(role));

export interface Caller {
  connection: Connection;
  isController: boolean;
  person: Person;
  roles: string[];
  token: string;
}

/** Runs `work` for a verified caller on the request's connection. Refusals become their status. */
export async function withCaller(
  request: HttpRequest,
  context: InvocationContext,
  name: string,
  work: (caller: Caller) => Promise<HttpResponseInit>,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const identity = await verifiedIdentityFromRequest(request);
  if (!identity) return unauthorizedResponse();
  let connection: Connection | undefined;
  try {
    const roles = await rolesForRequest(request);
    connection = await createRequestConnection(token);
    const ledger = await resolveLedgerActor(request, connection);
    if (!ledger) return unauthorizedResponse();
    const person: Person = { ledger, name: identity.name, oid: identity.oid };
    return await work({ connection, isController: isMyobController(roles), person, roles, token });
  } catch (error) {
    if (error instanceof ProposalError) return { jsonBody: { error: error.message, reasons: error.reasons }, status: error.status };
    if (error instanceof LedgerValidationError) return { jsonBody: { error: error.message }, status: 400 };
    const message = error instanceof Error ? error.message : String(error);
    context.error(`${name} failed:`, message);
    return errorResponse(`${name} failed`, message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

/** One transaction on `connection`: commit on success, roll back on anything thrown. */
export async function inTx<T>(connection: Connection, work: (tx: Connection) => Promise<T>): Promise<T> {
  await beginTransaction(connection);
  try {
    const result = await work(connection);
    await commitTransaction(connection);
    return result;
  } catch (error) {
    await rollbackTransaction(connection).catch(() => undefined);
    throw error;
  }
}

/** Where the job lives in Floorplan, for the MYOB Comment (decision 13). */
export function jobLink(jobId: number | null): string | null {
  const base = process.env.APP_BASE_URL?.replace(/\/+$/, "");
  return base && jobId ? `${base}/jobs?jobId=${jobId}` : null;
}

export const forbidden = (error: string): HttpResponseInit => ({ jsonBody: { error }, status: 403 });

const SUBJECT_TYPES = new Set(["purchase_order", "quote"]);
const OPERATIONS = new Set(["quotes.create", "orders.create", "bills.create", "quotes.update", "orders.update"]);

export function readSubject(body: Record<string, unknown>) {
  const subjectId = Number(body.subjectId);
  if (!SUBJECT_TYPES.has(String(body.subjectType)) || !Number.isInteger(subjectId) || subjectId <= 0) return null;
  if (!OPERATIONS.has(String(body.operation))) return null;
  return {
    operation: body.operation as "orders.create",
    subjectId,
    subjectType: body.subjectType as "purchase_order" | "quote",
  };
}

export function readPreview(body: Record<string, unknown>): { payloadHash: string; previewedAt: Date } | null {
  if (typeof body.payloadHash !== "string" || !/^[0-9a-f]{64}$/.test(body.payloadHash)) return null;
  const previewedAt = new Date(String(body.previewedAt));
  return Number.isNaN(previewedAt.getTime()) ? null : { payloadHash: body.payloadHash, previewedAt };
}
