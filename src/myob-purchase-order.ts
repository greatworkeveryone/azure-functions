// MYOB Purchase Order (Service Order) API client.
//
// Wraps the MYOB AccountRight v2 Service Order endpoints.
// Shares myob-client.ts's request path (and so myobRequest's audit log and
// MYOB_WRITES_ENABLED gate): tokens come from dbo.MyobAuth via
// getValidMyobAccessToken(), refreshed as needed. Every call takes the actor it
// is made on behalf of and an optional correlationId.
//
// API reference: https://developer.myob.com/api/myob-business-api/v2/purchase/order/order_service/
//
// Required environment variables (same as myob-client.ts):
//   MYOB_API_BASE          — e.g. https://api.myob.com/accountright
//   MYOB_COMPANY_FILE_ID   — GUID of the company file
//   MYOB_CLIENT_ID         — sent as x-myobapi-key header
//   MYOB_CLIENT_SECRET     — used by the token-refresh flow
//   MYOB_WEB_APP_URL       — base URL for "View on MYOB" links

import { myobRequest, type MyobActor } from "./myob-api-log";
import { myobBase, myobFetch, myobHeaders } from "./myob-client";

const MYOB_WEB_APP_URL     = process.env.MYOB_WEB_APP_URL ?? "https://app.myob.com";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface MyobSupplierRef {
  UID: string;
  Name?: string;
}

export interface MyobAccountRef {
  UID: string;
  DisplayID?: string;
  Name?: string;
}

export interface MyobTaxCodeRef {
  UID: string;
  Code?: string;
}

export type MyobServiceOrderLineType = "Account" | "Header" | "Subtotal";

export interface MyobServiceOrderLine {
  /** Line type — "Account" for a charge line, "Header" for a heading. */
  Type: MyobServiceOrderLineType;
  Description: string;
  UnitPrice?: number;
  Units?: number;
  Total?: number;
  TaxCode?: MyobTaxCodeRef;
  Account?: MyobAccountRef;
}

export interface CreateMyobServiceOrderParams {
  /** MYOB supplier (vendor) UID — required by the MYOB API. */
  Supplier: MyobSupplierRef;
  /** Purchase order number / reference. */
  Number?: string;
  /** ISO date string, e.g. "2026-04-25". */
  Date?: string;
  /** ISO date string for expected delivery. */
  PromisedDate?: string;
  Memo?: string;
  Lines: MyobServiceOrderLine[];
  IsTaxInclusive?: boolean;
  ShipToAddress?: string;
}

export interface MyobServiceOrder extends CreateMyobServiceOrderParams {
  UID: string;
  RowVersion?: string;
  LastModified?: string;
  /** "Open" or "ConvertedToBill" */
  Status?: string;
  Subtotal?: number;
  TotalTax?: number;
  TotalAmount?: number;
  BalanceDueAmount?: number;
  URI?: string;
}

export interface MyobServiceOrderResponse {
  uid: string;
  /** Direct link to this order in the MYOB web app. */
  url: string;
}

// ── URL builder ───────────────────────────────────────────────────────────────

export function buildMyobOrderUrl(uid: string): string {
  return `${MYOB_WEB_APP_URL}/app/#/In/Purchase/Orders/Order/${uid}`;
}

// ── API calls ─────────────────────────────────────────────────────────────────

/**
 * Creates a Service Order (Purchase Order) in MYOB.
 * POST /{companyFileId}/Purchase/Order/Service
 * Returns 204 with the new UID in the Location header.
 */
export async function myobCreateServiceOrder(
  params: CreateMyobServiceOrderParams,
  sqlToken: string | null,
  actor: MyobActor,
  correlationId?: string,
): Promise<MyobServiceOrderResponse> {
  const response = await myobRequest({
    actor,
    body: params,
    correlationId,
    headers: () => myobHeaders(sqlToken, actor, correlationId),
    method: "POST",
    purpose: "create-service-order",
    url: `${myobBase()}/Purchase/Order/Service`,
  });

  if (!response.ok) {
    throw new Error(`MYOB createServiceOrder ${response.status}: ${response.text}`);
  }

  // Location: https://api.myob.com/accountright/{cfId}/Purchase/Order/Service/{uid}
  const uid = response.myobUid ?? "";
  return { uid, url: buildMyobOrderUrl(uid) };
}

/**
 * Fetches a single Service Order by MYOB UID.
 * GET /{companyFileId}/Purchase/Order/Service/{uid}
 */
export async function myobGetServiceOrder(
  uid: string,
  sqlToken: string | null,
  actor: MyobActor,
  correlationId?: string,
): Promise<MyobServiceOrder> {
  return myobFetch({
    actor,
    correlationId,
    method: "GET",
    path: `/Purchase/Order/Service/${uid}`,
    purpose: "get-service-order",
    sqlToken,
  }) as Promise<MyobServiceOrder>;
}

/**
 * Updates an existing Service Order in MYOB.
 * PUT /{companyFileId}/Purchase/Order/Service/{uid}
 * RowVersion must be included (fetch the order first to get the current value).
 */
export async function myobUpdateServiceOrder(
  uid: string,
  params: Partial<MyobServiceOrder>,
  sqlToken: string | null,
  actor: MyobActor,
  correlationId?: string,
): Promise<void> {
  await myobFetch({
    actor,
    body: params,
    correlationId,
    method: "PUT",
    path: `/Purchase/Order/Service/${uid}`,
    purpose: "update-service-order",
    sqlToken,
  });
}

/**
 * Deletes a Service Order in MYOB.
 * DELETE /{companyFileId}/Purchase/Order/Service/{uid}
 */
export async function myobDeleteServiceOrder(
  uid: string,
  sqlToken: string | null,
  actor: MyobActor,
  correlationId?: string,
): Promise<void> {
  await myobFetch({
    actor,
    correlationId,
    method: "DELETE",
    path: `/Purchase/Order/Service/${uid}`,
    purpose: "delete-service-order",
    sqlToken,
  });
}

/**
 * Converts a Service Order to a Purchase Bill.
 *
 * The MYOB AccountRight API does not expose a direct "convert order to bill"
 * endpoint. Convert the order to a bill manually in the MYOB web app. Track
 * https://developer.myob.com for future API support.
 */
export async function myobConvertOrderToBill(
  _uid: string,
): Promise<{ billUid: string; billUrl: string }> {
  throw new Error(
    "myobConvertOrderToBill is not supported by the MYOB AccountRight API. " +
      "Convert the order to a bill manually in the MYOB web app.",
  );
}
