// MYOB Purchases client: Service Quotes, Orders and Bills in one company file.
// Every call goes through myobRequest, so the allowlist, the period guard on
// the bytes sent, the file's mode and the CFO's controls apply, and headers
// (with the token) are built only after those pass. Bodies are passed as the
// exact string to send: the proposal pipeline hands over the canonical JSON
// whose hash the person approved (decision 12).
//
// There is no delete and no convert-to-bill here, by design (decision 11):
// Floorplan never deletes anything in MYOB, and the order-to-bill path stays
// off until the CFO approves it. A PUT is allowed only for a record Floorplan
// created (myob-request-guard.ts checks MyobProposals).
//
// API reference: developer.myob.com/api/myob-business-api/v2/purchase/order/order_service/

import { myobRequest, type MyobActor, type MyobResponse } from "./myob-api-log";
import { myobHeaders } from "./myob-client";
import { myobApiBase } from "./myob-endpoints";

export type PurchaseKind = "Bill" | "Order" | "Quote";

const MYOB_WEB_APP_URL = process.env.MYOB_WEB_APP_URL ?? "https://app.myob.com";

const serviceUrl = (kind: PurchaseKind, companyFileId: string) => `${myobApiBase()}/${companyFileId}/Purchase/${kind}/Service`;
const headers = (actor: MyobActor, correlationId?: string) => () => myobHeaders(null, actor, correlationId);

export function myobWebUrl(kind: PurchaseKind, uid: string): string {
  const path = kind === "Bill" ? "Bills/AccountsPayable/Bill" : kind === "Quote" ? "Purchase/Quotes/Quote" : "Purchase/Orders/Order";
  return `${MYOB_WEB_APP_URL}/app/#/In/${path}/${uid}`;
}

function ensureOk(response: MyobResponse, what: string): void {
  if (!response.ok) throw new MyobPurchaseError(response.status, `MYOB refused to ${what} (HTTP ${response.status}): ${response.text.slice(0, 500)}`);
}

/** MYOB answered, and the answer was no. Its words are kept for the CFO. */
export class MyobPurchaseError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "MyobPurchaseError";
    this.status = status;
  }
}

/** The record with this number, if MYOB already has one (so a retry links instead of duplicating). */
export async function findPurchaseByNumber(
  kind: PurchaseKind,
  companyFileId: string,
  number: string,
  actor: MyobActor,
  correlationId?: string,
): Promise<Record<string, unknown> | null> {
  const filter = encodeURIComponent(`Number eq '${number.replace(/'/g, "''")}'`);
  const response = await myobRequest({
    actor,
    correlationId,
    headers: headers(actor, correlationId),
    method: "GET",
    purpose: `find-${kind.toLowerCase()}-by-number`,
    url: `${serviceUrl(kind, companyFileId)}?$filter=${filter}`,
  });
  ensureOk(response, `look up ${kind.toLowerCase()} ${number}`);
  const items = response.json<{ Items?: Record<string, unknown>[] }>().Items ?? [];
  return items.find((item) => item.Number === number) ?? null;
}

export async function getPurchase(
  kind: PurchaseKind,
  companyFileId: string,
  uid: string,
  actor: MyobActor,
  correlationId?: string,
): Promise<Record<string, unknown>> {
  const response = await myobRequest({
    actor,
    correlationId,
    headers: headers(actor, correlationId),
    method: "GET",
    purpose: `read-back-${kind.toLowerCase()}`,
    url: `${serviceUrl(kind, companyFileId)}/${uid}`,
  });
  ensureOk(response, `read ${kind.toLowerCase()} ${uid}`);
  return response.json<Record<string, unknown>>();
}

/** POSTs the exact bytes given. Returns MYOB's uid for the new record. */
export async function createPurchase(
  kind: PurchaseKind,
  companyFileId: string,
  body: string,
  actor: MyobActor,
  correlationId?: string,
): Promise<string> {
  const response = await myobRequest({
    actor,
    body,
    correlationId,
    headers: headers(actor, correlationId),
    method: "POST",
    purpose: `create-${kind.toLowerCase()}`,
    url: serviceUrl(kind, companyFileId),
  });
  ensureOk(response, `create the ${kind.toLowerCase()}`);
  if (!response.myobUid) throw new MyobPurchaseError(response.status, "MYOB accepted the record but didn't say its UID");
  return response.myobUid.toLowerCase();
}

/** PUTs the exact bytes given to a record Floorplan created. */
export async function putPurchase(
  kind: PurchaseKind,
  companyFileId: string,
  uid: string,
  body: string,
  actor: MyobActor,
  correlationId?: string,
): Promise<void> {
  const response = await myobRequest({
    actor,
    body,
    correlationId,
    headers: headers(actor, correlationId),
    method: "PUT",
    purpose: `update-${kind.toLowerCase()}`,
    url: `${serviceUrl(kind, companyFileId)}/${uid}`,
  });
  ensureOk(response, `update ${kind.toLowerCase()} ${uid}`);
}
