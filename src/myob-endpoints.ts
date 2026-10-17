// What Floorplan may ask MYOB for, and nothing else (decision 11: Johanne's
// agreement of 13 Oct 2026). myobRequest() classifies every call here before
// it is logged as sent; anything that does not match a rule is refused inside
// Floorplan. src/__tests__/myob-agreement.test.ts pins this list, so widening
// it is a deliberate, reviewed change.
//
// The agreement in code:
//   - Purchases section only: quotes, orders and bills, read and create.
//   - Amend only records Floorplan created (PUT checks MyobProposals), never
//     delete anything, never a supplier card or any other centre.
//   - Creates are dated today in Darwin; nothing lands in a prior period
//     (see myob-period.ts).

/** OAuth scopes, exactly. No contacts, general ledger, banking, sales or payroll. */
export const MYOB_SCOPES = ["sme-company-file", "sme-purchases"] as const;
export const MYOB_SCOPE_STRING = MYOB_SCOPES.join(" ");

export const MYOB_DEFAULT_API_BASE = "https://api.myob.com/accountright";
export const MYOB_TOKEN_URL = "https://secure.myob.com/oauth2/v1/authorize/";

export type MyobOperation =
  | "files.list"
  | "company_file.read"
  | "purchases.read"
  | "quotes.create"
  | "orders.create"
  | "bills.create"
  | "quotes.update"
  | "orders.update";

export type MyobMethod = "GET" | "POST" | "PUT" | "DELETE";

export interface MyobEndpointRule {
  method: Exclude<MyobMethod, "DELETE">;
  operation: MyobOperation;
  /** Matched against the path below the API base, e.g. "/{cf}/Purchase/Order/Service". */
  pattern: RegExp;
  /** "today": a create must be dated today in Darwin. "period": an update must stay in the current period. */
  dateRule?: "today" | "period";
  /** PUT only: the uid must be a record Floorplan itself created (MyobProposals). */
  floorplanRecordOnly?: boolean;
}

const GUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const CF = `(${GUID})`;

export const MYOB_ENDPOINTS: readonly MyobEndpointRule[] = [
  { method: "GET", operation: "files.list", pattern: /^\/$/ },
  { method: "GET", operation: "company_file.read", pattern: new RegExp(`^/${CF}/?$`) },
  {
    method: "GET",
    operation: "purchases.read",
    pattern: new RegExp(`^/${CF}/Purchase/(?:Quote|Order|Bill)(?:/[A-Za-z0-9-]+)*/?$`),
  },
  { dateRule: "today", method: "POST", operation: "quotes.create", pattern: new RegExp(`^/${CF}/Purchase/Quote/Service$`) },
  { dateRule: "today", method: "POST", operation: "orders.create", pattern: new RegExp(`^/${CF}/Purchase/Order/Service$`) },
  { dateRule: "today", method: "POST", operation: "bills.create", pattern: new RegExp(`^/${CF}/Purchase/Bill/Service$`) },
  {
    dateRule: "period",
    floorplanRecordOnly: true,
    method: "PUT",
    operation: "quotes.update",
    pattern: new RegExp(`^/${CF}/Purchase/Quote/Service/(${GUID})$`),
  },
  {
    dateRule: "period",
    floorplanRecordOnly: true,
    method: "PUT",
    operation: "orders.update",
    pattern: new RegExp(`^/${CF}/Purchase/Order/Service/(${GUID})$`),
  },
];

/** Centres the agreement names as off limits, in MYOB's words. A path into one raises system.health. */
export const FORBIDDEN_CENTRES: Readonly<Record<string, string>> = {
  banking: "Banking",
  contact: "Card File",
  generalledger: "Accounts",
  payroll: "Payroll",
  sale: "Sales",
};
const FORBIDDEN_RE = /\/(Contact|GeneralLedger|Banking|Sale|Payroll)(?=\/|$)/i;

export type MyobClassification =
  | { kind: "oauth" }
  | { kind: "endpoint"; rule: MyobEndpointRule; companyFileId: string | null; uid: string | null }
  | { kind: "refused"; reason: string; forbiddenCentre: string | null };

export function myobApiBase(): string {
  return (process.env.MYOB_API_BASE || MYOB_DEFAULT_API_BASE).replace(/\/+$/, "");
}

function refused(reason: string, forbiddenCentre: string | null = null): MyobClassification {
  return { forbiddenCentre, kind: "refused", reason };
}

/** Decides what a request is, or why it may not leave Floorplan. Pure. */
export function classifyMyobRequest(method: string, url: string, apiBase: string = myobApiBase()): MyobClassification {
  let parsed: URL;
  let base: URL;
  try {
    parsed = new URL(url);
    base = new URL(apiBase);
  } catch {
    return refused("The MYOB address could not be read");
  }
  if (parsed.username || parsed.password) return refused("MYOB addresses may not carry credentials");

  if (parsed.origin === "https://secure.myob.com") {
    const tokenPath = new URL(MYOB_TOKEN_URL).pathname;
    if (method === "POST" && parsed.pathname.replace(/\/?$/, "/") === tokenPath && !parsed.search) return { kind: "oauth" };
    return refused("Only the OAuth token exchange may go to MYOB's sign-in server");
  }

  const basePath = base.pathname.replace(/\/+$/, "");
  if (parsed.origin !== base.origin || !(parsed.pathname === basePath || parsed.pathname.startsWith(`${basePath}/`))) {
    return refused(`Not a MYOB API address (${parsed.origin})`);
  }
  const path = parsed.pathname.slice(basePath.length) || "/";

  const centre = FORBIDDEN_RE.exec(path);
  if (centre) {
    const name = FORBIDDEN_CENTRES[centre[1].toLowerCase()];
    return refused(`The agreement of 13 Oct 2026 keeps Floorplan out of MYOB's ${name} centre`, name);
  }
  if (method === "DELETE") return refused("Floorplan never deletes anything in MYOB");
  if (method !== "GET" && parsed.search) return refused("A MYOB write may not carry query parameters");

  for (const rule of MYOB_ENDPOINTS) {
    if (rule.method !== method) continue;
    const match = rule.pattern.exec(path);
    if (!match) continue;
    return {
      companyFileId: match[1] ? match[1].toLowerCase() : null,
      kind: "endpoint",
      rule,
      uid: rule.floorplanRecordOnly && match[2] ? match[2].toLowerCase() : null,
    };
  }
  return refused(`${method} ${path} is not on Floorplan's MYOB allowlist (Purchases quotes, orders and bills only)`);
}
