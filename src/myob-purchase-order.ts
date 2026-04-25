// MYOB Purchase Order (Service Order) API client — STUB.
//
// These functions wrap the MYOB AccountRight v2 Service Order endpoints.
// All functions are stubbed: they log the call for observability but do NOT
// make real API calls yet. Activate by removing the stub guards and wiring up
// the real MYOB OAuth credentials.
//
// API reference: https://developer.myob.com/api/myob-business-api/v2/purchase/order/order_service/
//
// Required environment variables (same as myob-client.ts):
//   MYOB_API_BASE          — e.g. https://api.myob.com/accountright
//   MYOB_COMPANY_FILE_ID   — GUID of the company file
//   MYOB_ACCESS_TOKEN      — OAuth 2.0 bearer token

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
  /** Unit price per unit. */
  UnitPrice?: number;
  /** Number of units. */
  Units?: number;
  /** Total for this line (UnitPrice * Units). */
  Total?: number;
  TaxCode?: MyobTaxCodeRef;
  Account?: MyobAccountRef;
}

export interface CreateMyobServiceOrderParams {
  /** MYOB supplier (vendor) UID. */
  Supplier?: MyobSupplierRef;
  /** Purchase order number / reference. */
  Number?: string;
  /** ISO date string, e.g. "2026-04-24". */
  Date?: string;
  /** ISO date string for expected delivery. */
  PromisedDate?: string;
  Memo?: string;
  Lines: MyobServiceOrderLine[];
  /** Whether tax is inclusive in the line totals. */
  IsTaxInclusive?: boolean;
  ShipToAddress?: string;
}

export interface MyobServiceOrder extends CreateMyobServiceOrderParams {
  /** MYOB-assigned GUID for this order. */
  UID: string;
  /** ISO datetime string. */
  LastModified?: string;
  /** Order status in MYOB. */
  Status?: string;
  /** Total amount before tax. */
  Subtotal?: number;
  /** Total tax amount. */
  TotalTax?: number;
  /** Total amount including tax. */
  TotalAmount?: number;
  /** Direct URL to this resource in the MYOB API. */
  URI?: string;
}

export interface MyobServiceOrderResponse {
  /** MYOB-assigned GUID for the created order. */
  uid: string;
  /** Direct URL to this resource in the MYOB API (from Location header). */
  url: string;
}

// ── Environment helpers ───────────────────────────────────────────────────────

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `MYOB Purchase Order client: missing required environment variable "${name}". ` +
        `Set it in your Azure Function App configuration.`,
    );
  }
  return value;
}

function companyFileBase(): string {
  const apiBase = requireEnv("MYOB_API_BASE");
  const fileId = requireEnv("MYOB_COMPANY_FILE_ID");
  return `${apiBase}/${fileId}`;
}

// ── STUB: MYOB API not yet active ─────────────────────────────────────────────

class NotImplementedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotImplementedError";
  }
}

/**
 * Creates a Service Order (Purchase Order) in MYOB.
 *
 * POST /{companyFileId}/Purchase/Order/Service
 *
 * // STUB: MYOB API not yet active
 */
export async function myobCreateServiceOrder(
  params: CreateMyobServiceOrderParams,
): Promise<MyobServiceOrderResponse> {
  const base = companyFileBase();
  const accessToken = requireEnv("MYOB_ACCESS_TOKEN");
  console.log(
    `[myobCreateServiceOrder] STUB — would POST ${base}/Purchase/Order/Service`,
    JSON.stringify({ params, accessToken: accessToken ? "[redacted]" : "(missing)" }),
  );
  // STUB: MYOB API not yet active
  // When activating: make the real POST, read the Location header for the UID,
  // return { uid, url }.
  throw new NotImplementedError(
    "myobCreateServiceOrder is not yet active. Remove the stub guard and wire up MYOB OAuth credentials to enable it.",
  );
}

/**
 * Fetches a single Service Order by MYOB UID.
 *
 * GET /{companyFileId}/Purchase/Order/Service/{uid}
 *
 * // STUB: MYOB API not yet active
 */
export async function myobGetServiceOrder(uid: string): Promise<MyobServiceOrder> {
  const base = companyFileBase();
  const accessToken = requireEnv("MYOB_ACCESS_TOKEN");
  console.log(
    `[myobGetServiceOrder] STUB — would GET ${base}/Purchase/Order/Service/${uid}`,
    JSON.stringify({ uid, accessToken: accessToken ? "[redacted]" : "(missing)" }),
  );
  // STUB: MYOB API not yet active
  throw new NotImplementedError(
    "myobGetServiceOrder is not yet active. Remove the stub guard and wire up MYOB OAuth credentials to enable it.",
  );
}

/**
 * Updates an existing Service Order in MYOB.
 *
 * PUT /{companyFileId}/Purchase/Order/Service/{uid}
 *
 * // STUB: MYOB API not yet active
 */
export async function myobUpdateServiceOrder(
  uid: string,
  params: Partial<CreateMyobServiceOrderParams>,
): Promise<void> {
  const base = companyFileBase();
  const accessToken = requireEnv("MYOB_ACCESS_TOKEN");
  console.log(
    `[myobUpdateServiceOrder] STUB — would PUT ${base}/Purchase/Order/Service/${uid}`,
    JSON.stringify({ uid, params, accessToken: accessToken ? "[redacted]" : "(missing)" }),
  );
  // STUB: MYOB API not yet active
  throw new NotImplementedError(
    "myobUpdateServiceOrder is not yet active. Remove the stub guard and wire up MYOB OAuth credentials to enable it.",
  );
}

/**
 * Deletes a Service Order in MYOB.
 *
 * DELETE /{companyFileId}/Purchase/Order/Service/{uid}
 *
 * // STUB: MYOB API not yet active
 */
export async function myobDeleteServiceOrder(uid: string): Promise<void> {
  const base = companyFileBase();
  const accessToken = requireEnv("MYOB_ACCESS_TOKEN");
  console.log(
    `[myobDeleteServiceOrder] STUB — would DELETE ${base}/Purchase/Order/Service/${uid}`,
    JSON.stringify({ uid, accessToken: accessToken ? "[redacted]" : "(missing)" }),
  );
  // STUB: MYOB API not yet active
  throw new NotImplementedError(
    "myobDeleteServiceOrder is not yet active. Remove the stub guard and wire up MYOB OAuth credentials to enable it.",
  );
}

/**
 * Converts a Service Order to a Purchase Bill in MYOB.
 *
 * The MYOB AccountRight API does not currently expose a direct "convert order
 * to bill" endpoint. The standard workflow is to open the order in the MYOB
 * web UI and convert it there. This stub is a placeholder for when MYOB adds
 * API support for this operation, or if a workaround is identified (e.g.
 * creating a Bill with reference to the Order UID).
 *
 * // STUB: MYOB API not yet active
 */
export async function myobConvertOrderToBill(
  uid: string,
): Promise<{ billUid: string; billUrl: string }> {
  console.log(
    `[myobConvertOrderToBill] STUB — MYOB API does not yet support converting a Service Order to a Bill programmatically. UID: ${uid}`,
  );
  // STUB: MYOB API not yet active
  // Future: MYOB may add a POST /{cfId}/Purchase/Bill/Service endpoint that
  // accepts an OrderUID to create a bill from an existing order. Track the
  // MYOB developer changelog at https://developer.myob.com for updates.
  throw new NotImplementedError(
    "myobConvertOrderToBill is not yet supported by the MYOB AccountRight API. " +
      "Convert the order to a bill manually in the MYOB web app.",
  );
}
