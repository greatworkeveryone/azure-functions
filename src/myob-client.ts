// MYOB AccountRight Live API client.
//
// All calls go through Azure Functions — the frontend never touches MYOB, and
// every HTTP call is made, logged and write-gated by myobRequest().
// The access token is fetched from dbo.MyobAuth on every call (refreshed
// automatically when within 60s of expiry). Authorize via the admin page.
//
// Required environment variables:
//   MYOB_API_BASE          — e.g. https://api.myob.com/accountright
//   MYOB_COMPANY_FILE_ID   — GUID of the company file (find it via GET /accountright)
//   MYOB_CLIENT_ID         — "Key" from the MYOB developer portal (x-myobapi-key header)
//   MYOB_CLIENT_SECRET     — "Secret" from the MYOB developer portal
//   MYOB_REDIRECT_URI      — OAuth callback URL, must match the registered Redirect Uri
//   MYOB_EXPENSE_ACCOUNT_UID — UID of the GL expense account to post purchases to
//   MYOB_BANK_ACCOUNT_UID  — UID of the bank/payment account used for outgoing payments
//   MYOB_WEB_APP_URL       — base URL of MYOB web app for "View on MYOB" links
//                            (default: https://app.myob.com)
//   MYOB_WRITES_ENABLED    — must be exactly "true" for any write to reach MYOB
//                            (see myob-api-log.ts)
//   MYOB_TOKEN_KEY         — AES-256-GCM key for the stored tokens (myob-token-crypto.ts);
//                            MYOB_TOKEN_KEY_VERSION / MYOB_TOKEN_KEY_PREVIOUS for rotation
//   MYOB_CF_USER, MYOB_CF_PASSWORD — the restricted company-file user, sent as
//                            x-myobapi-cftoken on every company-file call (myob-request-guard.ts)
//   MYOB_PERIOD_START      — optional lock date (YYYY-MM-DD); writes dated before it are
//                            refused (myob-period.ts). Default: 1st of the current Darwin month
//
// What may be called at all is fixed in myob-endpoints.ts (Purchases only).

import { getValidMyobAccessToken } from "./myob-auth";
import { myobRequest, type MyobActor } from "./myob-api-log";

const MYOB_API_BASE        = process.env.MYOB_API_BASE ?? "https://api.myob.com/accountright";
const MYOB_COMPANY_FILE_ID = process.env.MYOB_COMPANY_FILE_ID ?? "";
const MYOB_EXPENSE_ACCOUNT_UID = process.env.MYOB_EXPENSE_ACCOUNT_UID ?? "";
const MYOB_BANK_ACCOUNT_UID    = process.env.MYOB_BANK_ACCOUNT_UID ?? "";
const MYOB_WEB_APP_URL     = process.env.MYOB_WEB_APP_URL ?? "https://app.myob.com";

export const myobBase = () => `${MYOB_API_BASE}/${MYOB_COMPANY_FILE_ID}`;

export async function myobHeaders(
  sqlToken: string | null,
  actor: MyobActor,
  correlationId?: string,
): Promise<Record<string, string>> {
  return {
    Authorization: `Bearer ${await getValidMyobAccessToken(sqlToken, actor, correlationId)}`,
    "Content-Type": "application/json",
    "x-myobapi-key": process.env.MYOB_CLIENT_ID ?? "",
    "x-myobapi-version": "v2",
  };
}

// ── Shared request ───────────────────────────────────────────────────────────

export async function myobFetch(opts: {
  actor: MyobActor;
  body?: unknown;
  correlationId?: string;
  method?: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  purpose: string;
  sqlToken: string | null;
}): Promise<any> {
  const response = await myobRequest({
    actor: opts.actor,
    body: opts.body,
    correlationId: opts.correlationId,
    headers: await myobHeaders(opts.sqlToken, opts.actor, opts.correlationId),
    method: opts.method ?? "GET",
    purpose: opts.purpose,
    url: `${myobBase()}${opts.path}`,
  });

  if (!response.ok) {
    throw new Error(`MYOB API ${response.status} ${response.statusText}: ${response.text}`);
  }

  // 204 No Content on successful POST (MYOB returns the UID in Location header)
  if (response.status === 204 || response.text === "") {
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
 * @param actor        — who this call is on behalf of, for the MYOB audit log
 * @param correlationId — links the log rows to a decision-ledger row
 */
export async function createMyobBill(opts: {
  actor: MyobActor;
  amount: number;
  contractorName?: string;
  correlationId?: string;
  jobId: number;
  jobTitle: string;
  notes?: string;
  referenceNumber: string;
  sqlToken: string | null;
}): Promise<MyobBillResult> {
  const description = [
    `Job #${opts.jobId} — ${opts.jobTitle}`,
    opts.contractorName ? `Contractor: ${opts.contractorName}` : null,
    opts.notes ?? null,
  ]
    .filter(Boolean)
    .join(" · ");

  // POST returns 204 with Location header containing the new UID
  const response = await myobRequest({
    actor: opts.actor,
    body: {
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
      // No Supplier yet — see the MYOB_WRITES_ENABLED note above applyMyobPayment.
    },
    correlationId: opts.correlationId,
    headers: await myobHeaders(opts.sqlToken, opts.actor, opts.correlationId),
    method: "POST",
    purpose: "create-bill",
    url: `${myobBase()}/Purchase/Bill/Service`,
  });

  if (!response.ok) {
    throw new Error(`MYOB createBill ${response.status}: ${response.text}`);
  }

  // The new resource UID is returned in the Location header:
  // Location: https://api.myob.com/accountright/{cfId}/Purchase/Bill/Service/{uid}
  const uid = response.myobUid ?? "";
  const url = buildMyobBillUrl(uid);

  return { uid, url };
}

// MYOB_WRITES_ENABLED stays false until applyMyobPayment and createMyobBill are
// corrected and verified against a real company file:
//   1. The documented endpoint for paying a bill is POST /Purchase/SupplierPayment
//      with Lines[{ Type: "Bill", Purchase: { UID }, AmountApplied }] plus
//      PayFrom, Account and Supplier — not /Purchase/PaymentPurchase with Bills[].
//   2. A Service Bill needs a Supplier; createMyobBill sends none.
/**
 * Applies a payment against an existing Purchase Bill — marks it as paid in MYOB.
 * Called when the user clicks "Mark as paid" in the app.
 */
export async function applyMyobPayment(opts: {
  actor: MyobActor;
  billUid: string;
  amount: number;
  correlationId?: string;
  paidDate?: Date;
  sqlToken: string | null;
}): Promise<void> {
  await myobFetch({
    actor: opts.actor,
    body: {
      Bills: [{ AmountApplied: opts.amount, UID: opts.billUid }],
      PaymentDate: (opts.paidDate ?? new Date()).toISOString().slice(0, 10),
      SupplierPaymentDetails: MYOB_BANK_ACCOUNT_UID
        ? { Account: { UID: MYOB_BANK_ACCOUNT_UID } }
        : undefined,
    },
    correlationId: opts.correlationId,
    method: "POST",
    path: "/Purchase/PaymentPurchase",
    purpose: "apply-payment",
    sqlToken: opts.sqlToken,
  });
}

/**
 * Builds the direct MYOB web-app URL for a Purchase Bill.
 * Adjust MYOB_WEB_APP_URL if your MYOB instance uses a different URL pattern.
 */
export function buildMyobBillUrl(uid: string): string {
  return `${MYOB_WEB_APP_URL}/app/#/In/Bills/AccountsPayable/Bill/${uid}`;
}
