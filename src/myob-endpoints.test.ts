/// <reference types="jest" />

import { classifyMyobRequest, MYOB_DEFAULT_API_BASE, MYOB_TOKEN_URL } from "./myob-endpoints";

const CF = "0f9e8d7c-6b5a-4f3e-9d2c-1b0a99887766";
const UID = "11111111-2222-4333-8444-555555555555";
const API = `${MYOB_DEFAULT_API_BASE}/${CF}`;

const classify = (method: string, url: string) => classifyMyobRequest(method, url, MYOB_DEFAULT_API_BASE);
const operation = (method: string, url: string) => {
  const result = classify(method, url);
  return result.kind === "endpoint" ? result.rule.operation : result.kind;
};

describe("classifyMyobRequest: what is allowed", () => {
  it.each([
    ["GET", `${MYOB_DEFAULT_API_BASE}/`, "files.list"],
    ["GET", `${API}/`, "company_file.read"],
    ["GET", API, "company_file.read"],
    ["GET", `${API}/Purchase/Order`, "purchases.read"],
    ["GET", `${API}/Purchase/Order/Service?$filter=Number%20eq%20'66Sm261013'`, "purchases.read"],
    ["GET", `${API}/Purchase/Quote/Service/${UID}`, "purchases.read"],
    ["GET", `${API}/Purchase/Bill/Service?$top=100&$skip=100`, "purchases.read"],
    ["POST", `${API}/Purchase/Quote/Service`, "quotes.create"],
    ["POST", `${API}/Purchase/Order/Service`, "orders.create"],
    ["POST", `${API}/Purchase/Bill/Service`, "bills.create"],
    ["PUT", `${API}/Purchase/Quote/Service/${UID}`, "quotes.update"],
    ["PUT", `${API}/Purchase/Order/Service/${UID}`, "orders.update"],
  ])("%s %s → %s", (method, url, expected) => {
    expect(operation(method, url)).toBe(expected);
  });

  it("recognises only the OAuth token POST on MYOB's sign-in server", () => {
    expect(classify("POST", MYOB_TOKEN_URL)).toEqual({ kind: "oauth" });
    expect(classify("GET", MYOB_TOKEN_URL).kind).toBe("refused");
    expect(classify("POST", "https://secure.myob.com/oauth2/other/").kind).toBe("refused");
  });

  it("returns the company file and, for updates, the record uid in lower case", () => {
    const result = classify("PUT", `${MYOB_DEFAULT_API_BASE}/${CF.toUpperCase()}/Purchase/Order/Service/${UID.toUpperCase()}`);
    expect(result).toMatchObject({ companyFileId: CF, kind: "endpoint", uid: UID });
  });
});

describe("classifyMyobRequest: what is refused", () => {
  it.each([
    ["DELETE", `${API}/Purchase/Order/Service/${UID}`],
    ["DELETE", `${API}/Purchase/Bill/Service/${UID}`],
    ["PUT", `${API}/Purchase/Bill/Service/${UID}`],
    ["POST", `${API}/Purchase/SupplierPayment`],
    ["POST", `${API}/Purchase/PaymentPurchase`],
    ["POST", `${API}/Purchase/Order/Item`],
    ["GET", `${API}/Inventory/Item`],
    ["GET", `${API}/Company`],
    ["POST", `${API}/Purchase/Order/Service?returnBody=true`],
    ["GET", `${API}/Purchase/Order/Service/..%2F..%2FContact`],
    ["GET", "https://evil.example.com/accountright/"],
    ["GET", `https://user:pass@api.myob.com/accountright/${CF}/`],
    ["GET", "https://api.myob.com/other/"],
    ["GET", `${MYOB_DEFAULT_API_BASE}/not-a-guid/Purchase/Order`],
    ["GET", "not a url"],
  ])("%s %s", (method, url) => {
    expect(classify(method, url).kind).toBe("refused");
  });

  it.each([
    ["GET", `${API}/Contact/Supplier`, "Card File"],
    ["PUT", `${API}/Contact/Supplier/${UID}`, "Card File"],
    ["GET", `${API}/contact/supplier`, "Card File"],
    ["GET", `${API}/GeneralLedger/Account`, "Accounts"],
    ["GET", `${API}/GeneralLedger/TaxCode`, "Accounts"],
    ["POST", `${API}/Banking/SpendMoneyTxn`, "Banking"],
    ["GET", `${API}/Sale/Invoice`, "Sales"],
    ["GET", `${API}/Payroll/Timesheet`, "Payroll"],
    ["GET", `${API}/Purchase/Order/../../Banking/BankAccount`, "Banking"],
  ])("%s %s names the forbidden centre (%s)", (method, url, centre) => {
    expect(classify(method, url)).toMatchObject({ forbiddenCentre: centre, kind: "refused" });
  });

  it("says why a DELETE is refused", () => {
    expect(classify("DELETE", `${API}/Purchase/Order/Service/${UID}`)).toMatchObject({
      reason: "Floorplan never deletes anything in MYOB",
    });
  });

  it("follows MYOB_API_BASE when it is set", () => {
    const base = "https://sandbox.example.test/accountright";
    expect(classifyMyobRequest("GET", `${base}/${CF}/Purchase/Order`, base).kind).toBe("endpoint");
    expect(classifyMyobRequest("GET", `${API}/Purchase/Order`, base).kind).toBe("refused");
  });
});
