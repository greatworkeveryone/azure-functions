// MYOB Purchase Order (Service Order) API client.
//
// Wraps the MYOB AccountRight v2 Service Order endpoints.
// Follows the same auth + fetch pattern as myob-client.ts.
//
// API reference: https://developer.myob.com/api/myob-business-api/v2/purchase/order/order_service/
//
// Required environment variables (same as myob-client.ts):
//   MYOB_API_BASE          — e.g. https://api.myob.com/accountright
//   MYOB_COMPANY_FILE_ID   — GUID of the company file
//   MYOB_ACCESS_TOKEN      — OAuth 2.0 bearer token
//   MYOB_CLIENT_ID         — sent as x-myobapi-key header
//   MYOB_WEB_APP_URL       — base URL for "View on MYOB" links

const MYOB_API_BASE        = process.env.MYOB_API_BASE ?? "https://api.myob.com/accountright";
const MYOB_COMPANY_FILE_ID = process.env.MYOB_COMPANY_FILE_ID ?? "";
const MYOB_ACCESS_TOKEN    = process.env.MYOB_ACCESS_TOKEN ?? "";
const MYOB_WEB_APP_URL     = process.env.MYOB_WEB_APP_URL ?? "https://app.myob.com";

const base = () => `${MYOB_API_BASE}/${MYOB_COMPANY_FILE_ID}`;

function myobHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${MYOB_ACCESS_TOKEN}`,
    "Content-Type": "application/json",
    "x-myobapi-key": process.env.MYOB_CLIENT_ID ?? "",
    "x-myobapi-version": "v2",
  };
}

async function myobFetch(
  path: string,
  method: "GET" | "PUT" | "DELETE" = "GET",
  body?: unknown,
): Promise<unknown> {
  const url = `${base()}${path}`;
  const response = await fetch(url, {
    method,
    headers: myobHeaders(),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`MYOB API ${response.status} ${response.statusText}: ${text}`);
  }

  if (response.status === 204 || response.headers.get("content-length") === "0") {
    return null;
  }

  return response.json() as Promise<unknown>;
}

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
): Promise<MyobServiceOrderResponse> {
  const response = await fetch(`${base()}/Purchase/Order/Service`, {
    method: "POST",
    headers: myobHeaders(),
    body: JSON.stringify(params),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`MYOB createServiceOrder ${response.status}: ${text}`);
  }

  // Location: https://api.myob.com/accountright/{cfId}/Purchase/Order/Service/{uid}
  const location = response.headers.get("Location") ?? "";
  const uid = location.split("/").pop() ?? "";
  return { uid, url: buildMyobOrderUrl(uid) };
}

/**
 * Fetches a single Service Order by MYOB UID.
 * GET /{companyFileId}/Purchase/Order/Service/{uid}
 */
export async function myobGetServiceOrder(uid: string): Promise<MyobServiceOrder> {
  return myobFetch(`/Purchase/Order/Service/${uid}`) as Promise<MyobServiceOrder>;
}

/**
 * Updates an existing Service Order in MYOB.
 * PUT /{companyFileId}/Purchase/Order/Service/{uid}
 * RowVersion must be included (fetch the order first to get the current value).
 */
export async function myobUpdateServiceOrder(
  uid: string,
  params: Partial<MyobServiceOrder>,
): Promise<void> {
  await myobFetch(`/Purchase/Order/Service/${uid}`, "PUT", params);
}

/**
 * Deletes a Service Order in MYOB.
 * DELETE /{companyFileId}/Purchase/Order/Service/{uid}
 */
export async function myobDeleteServiceOrder(uid: string): Promise<void> {
  await myobFetch(`/Purchase/Order/Service/${uid}`, "DELETE");
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
