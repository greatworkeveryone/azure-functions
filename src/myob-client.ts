// MYOB AccountRight Live API client.
//
// All calls go through Azure Functions — the frontend never touches MYOB.
//
// Required environment variables:
//   MYOB_API_BASE          — e.g. https://api.myob.com/accountright
//   MYOB_COMPANY_FILE_ID   — GUID of the company file (find it via GET /accountright)
//   MYOB_ACCESS_TOKEN      — OAuth 2.0 bearer token (rotate via MYOB developer portal)
//   MYOB_EXPENSE_ACCOUNT_UID — UID of the GL expense account to post purchases to
//   MYOB_BANK_ACCOUNT_UID  — UID of the bank/payment account used for outgoing payments
//   MYOB_WEB_APP_URL       — base URL of MYOB web app for "View on MYOB" links
//                            (default: https://app.myob.com)
//   MYOB_WEBHOOK_KEY       — secret used to validate incoming webhook HMAC signatures

import { createHmac } from "crypto";

const MYOB_API_BASE        = process.env.MYOB_API_BASE ?? "https://api.myob.com/accountright";
const MYOB_COMPANY_FILE_ID = process.env.MYOB_COMPANY_FILE_ID ?? "";
const MYOB_ACCESS_TOKEN    = process.env.MYOB_ACCESS_TOKEN ?? "";
const MYOB_EXPENSE_ACCOUNT_UID = process.env.MYOB_EXPENSE_ACCOUNT_UID ?? "";
const MYOB_BANK_ACCOUNT_UID    = process.env.MYOB_BANK_ACCOUNT_UID ?? "";
const MYOB_WEB_APP_URL     = process.env.MYOB_WEB_APP_URL ?? "https://app.myob.com";
export const MYOB_WEBHOOK_KEY  = process.env.MYOB_WEBHOOK_KEY ?? "";

const base = () => `${MYOB_API_BASE}/${MYOB_COMPANY_FILE_ID}`;

// ── Shared fetch ─────────────────────────────────────────────────────────────

async function myobFetch(
  path: string,
  method: "GET" | "POST" | "PUT" | "DELETE" = "GET",
  body?: unknown,
): Promise<any> {
  const url = `${base()}${path}`;
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${MYOB_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
      "x-myobapi-key": process.env.MYOB_CLIENT_ID ?? "",
      "x-myobapi-version": "v2",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`MYOB API ${response.status} ${response.statusText}: ${text}`);
  }

  // 204 No Content on successful POST (MYOB returns the UID in Location header)
  if (response.status === 204 || response.headers.get("content-length") === "0") {
    return null;
  }

  return response.json();
}

// ── Bill (Accounts Payable) ──────────────────────────────────────────────────

export interface MyobBillResult {
  uid: string;
  url: string;
}

/**
 * Creates a Purchase Bill in MYOB representing money owed to a contractor.
 * Called when a payment is first recorded in the app.
 *
 * @param jobId        — for the bill reference number / description
 * @param jobTitle     — human-readable job title for the bill description line
 * @param amount       — dollar amount
 * @param contractorName — supplier display name (informational, not a MYOB contact lookup)
 * @param notes        — optional extra notes to append to the line description
 * @param referenceNumber — our internal payment reference (e.g. "PAY-42-1")
 */
export async function createMyobBill(opts: {
  amount: number;
  contractorName?: string;
  jobId: number;
  jobTitle: string;
  notes?: string;
  referenceNumber: string;
}): Promise<MyobBillResult> {
  const description = [
    `Job #${opts.jobId} — ${opts.jobTitle}`,
    opts.contractorName ? `Contractor: ${opts.contractorName}` : null,
    opts.notes ?? null,
  ]
    .filter(Boolean)
    .join(" · ");

  // POST returns 204 with Location header containing the new UID
  const response = await fetch(`${base()}/Purchase/Bill/Service`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${MYOB_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
      "x-myobapi-key": process.env.MYOB_CLIENT_ID ?? "",
      "x-myobapi-version": "v2",
    },
    body: JSON.stringify({
      Date: new Date().toISOString().slice(0, 10),
      Lines: [
        {
          Account: MYOB_EXPENSE_ACCOUNT_UID ? { UID: MYOB_EXPENSE_ACCOUNT_UID } : undefined,
          Description: description,
          TotalAmount: opts.amount,
          Type: "Account",
        },
      ],
      Number: opts.referenceNumber,
      // Supplier is optional here — MYOB will accept a bill without a contact.
      // Wire up MYOB_SUPPLIER_UID per-contractor if you want proper supplier tracking.
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`MYOB createBill ${response.status}: ${text}`);
  }

  // The new resource UID is returned in the Location header:
  // Location: https://api.myob.com/accountright/{cfId}/Purchase/Bill/Service/{uid}
  const location = response.headers.get("Location") ?? "";
  const uid = location.split("/").pop() ?? "";
  const url = buildMyobBillUrl(uid);

  return { uid, url };
}

/**
 * Applies a payment against an existing Purchase Bill — marks it as paid in MYOB.
 * Called when the user clicks "Mark as paid" in the app.
 */
export async function applyMyobPayment(opts: {
  billUid: string;
  amount: number;
  paidDate?: Date;
}): Promise<void> {
  await myobFetch("/Purchase/PaymentPurchase", "POST", {
    Bills: [{ AmountApplied: opts.amount, UID: opts.billUid }],
    PaymentDate: (opts.paidDate ?? new Date()).toISOString().slice(0, 10),
    SupplierPaymentDetails: MYOB_BANK_ACCOUNT_UID
      ? { Account: { UID: MYOB_BANK_ACCOUNT_UID } }
      : undefined,
  });
}

/**
 * Builds the direct MYOB web-app URL for a Purchase Bill.
 * Adjust MYOB_WEB_APP_URL if your MYOB instance uses a different URL pattern.
 */
export function buildMyobBillUrl(uid: string): string {
  return `${MYOB_WEB_APP_URL}/app/#/In/Bills/AccountsPayable/Bill/${uid}`;
}

// ── Webhook validation ────────────────────────────────────────────────────────

/**
 * Validates the HMAC-SHA256 signature MYOB attaches to every webhook delivery.
 * MYOB sends the signature in the `x-myob-hmac-sha256` header as a base64 string.
 *
 * Returns true if the signature matches (i.e. the request genuinely came from MYOB).
 */
export function validateMyobWebhookSignature(
  rawBody: string,
  signatureHeader: string,
): boolean {
  if (!MYOB_WEBHOOK_KEY) return false;
  const expected = createHmac("sha256", MYOB_WEBHOOK_KEY)
    .update(rawBody, "utf8")
    .digest("base64");
  return expected === signatureHeader;
}

// ── Webhook event shapes ──────────────────────────────────────────────────────

export interface MyobWebhookEvent {
  CompanyFileId: string;
  EntityUID: string;
  EventType: string;
  LastUpdated: string;
}

export interface MyobWebhookPayload {
  Events: MyobWebhookEvent[];
}

/** Event types we act on. */
export const MYOB_PAYMENT_APPLIED_EVENT = "PaymentPurchase.Created";
