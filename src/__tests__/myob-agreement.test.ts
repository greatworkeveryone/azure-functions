/// <reference types="jest" />
jest.mock("../myob-controls", () => ({ assertMyobControlsAllow: jest.fn().mockResolvedValue(undefined) }));
jest.mock("../db", () => ({
  closeConnection: jest.fn(),
  createServiceRequestConnection: jest.fn().mockResolvedValue({}),
  executeQuery: jest.fn().mockResolvedValue([]),
}));
jest.mock("../myob-health", () => ({
  MYOB_HEALTH_SUBJECTS: { agreement: "myob_agreement", link: "myob_link" },
  raiseMyobHealth: jest.fn().mockResolvedValue(undefined),
}));

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { buildAuthorizeUrl } from "../myob-auth";
import {
  classifyMyobRequest,
  MYOB_DEFAULT_API_BASE,
  MYOB_ENDPOINTS,
  MYOB_SCOPE_STRING,
  MYOB_SCOPES,
} from "../myob-endpoints";
import { todayInDarwin } from "../darwinDate";
import { myobRequest } from "../myob-api-log";
import { checkMyobPeriod } from "../myob-period";
import { guardMyobRequest, setFloorplanRecordLookup } from "../myob-request-guard";

// Johanne's MYOB agreement of 13 Oct 2026 (sprint plan, decision 11), pinned
// against the code that enforces it. If one of these fails, the change in
// front of you widens what Floorplan may do in RP's books: it needs Johanne's
// written say-so before this file is edited.

const CF = "0f9e8d7c-6b5a-4f3e-9d2c-1b0a99887766";
const UID = "11111111-2222-4333-8444-555555555555";
const API = `${MYOB_DEFAULT_API_BASE}/${CF}`;
// RegExp#source escapes "/"; compare patterns the way they read.
const sourceOf = (pattern: RegExp) => pattern.source.replace(/\\\//g, "/");
const classify = (method: string, path: string) => classifyMyobRequest(method, `${API}${path}`, MYOB_DEFAULT_API_BASE);
const NOW = new Date("2026-10-14T01:00:00Z"); // 10:30 on 14 Oct in Darwin
const savedEnv = { ...process.env };

afterAll(() => {
  process.env = savedEnv;
  setFloorplanRecordLookup(null);
});

describe("the endpoint allowlist is exactly the agreed list", () => {
  it("has not changed (method, operation, path pattern)", () => {
    const guid = "([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})";
    const readable = MYOB_ENDPOINTS.map((r) => `${r.method} ${r.operation} ${sourceOf(r.pattern).split(guid).join("{guid}")}`);
    expect(readable).toEqual([
      "GET files.list ^/$",
      "GET company_file.read ^/{guid}/?$",
      "GET purchases.read ^/{guid}/Purchase/(?:Quote|Order|Bill)(?:/[A-Za-z0-9-]+)*/?$",
      "POST quotes.create ^/{guid}/Purchase/Quote/Service$",
      "POST orders.create ^/{guid}/Purchase/Order/Service$",
      "POST bills.create ^/{guid}/Purchase/Bill/Service$",
      "PUT quotes.update ^/{guid}/Purchase/Quote/Service/{guid}$",
      "PUT orders.update ^/{guid}/Purchase/Order/Service/{guid}$",
    ]);
  });
});

describe("term 1: nothing already in MYOB is amended or deleted", () => {
  it("has no DELETE rule, and refuses DELETE on every path", () => {
    expect(MYOB_ENDPOINTS.some((r) => (r.method as string) === "DELETE")).toBe(false);
    for (const path of ["/Purchase/Order/Service/" + UID, "/Purchase/Quote/Service/" + UID, "/Purchase/Bill/Service/" + UID, "/"]) {
      expect(classify("DELETE", path).kind).toBe("refused");
    }
  });

  it("allows PUT only on quotes and orders, and only for records Floorplan created", () => {
    const puts = MYOB_ENDPOINTS.filter((r) => r.method === "PUT");
    expect(puts.map((r) => r.operation).sort()).toEqual(["orders.update", "quotes.update"]);
    expect(puts.every((r) => r.floorplanRecordOnly === true)).toBe(true);
    expect(classify("PUT", `/Purchase/Bill/Service/${UID}`).kind).toBe("refused");
  });

  it("refuses an update to a record Floorplan did not create, before the write switch is even consulted", async () => {
    setFloorplanRecordLookup(null);
    process.env.MYOB_WRITES_ENABLED = "true";
    await expect(
      guardMyobRequest({ body: { Date: "2026-10-14" }, method: "PUT", url: `${API}/Purchase/Order/Service/${UID}` }, NOW),
    ).rejects.toMatchObject({ code: "not_floorplan_record" });
  });
});

describe("term 2: no new data in prior periods", () => {
  it("dates every create today and keeps every update in the current period", () => {
    for (const rule of MYOB_ENDPOINTS.filter((r) => r.method === "POST")) expect(rule.dateRule).toBe("today");
    for (const rule of MYOB_ENDPOINTS.filter((r) => r.method === "PUT")) expect(rule.dateRule).toBe("period");
  });

  it("refuses a backdated create", () => {
    expect(checkMyobPeriod("today", { Date: "2026-09-30" }, NOW).ok).toBe(false);
    expect(checkMyobPeriod("today", { Date: "2026-10-14" }, NOW).ok).toBe(true);
  });

  // MYOB reads JSON names without regard to case and the last value wins, so
  // a second "date" key would be the date MYOB records.
  it("refuses a second date key in another case", () => {
    expect(checkMyobPeriod("today", { Date: "2026-10-14", date: "2026-09-01" }, NOW).ok).toBe(false);
    expect(checkMyobPeriod("today", JSON.stringify({ DATE: "2026-09-01", Date: "2026-10-14" }), NOW).ok).toBe(false);
  });

  it("checks the bytes actually sent: last duplicate wins, and toJSON can't hide a backdate", async () => {
    const fetchMock = jest.fn(async () => new Response("{}", { status: 200 }));
    global.fetch = fetchMock as unknown as typeof fetch;
    process.env.MYOB_WRITES_ENABLED = "true";
    const today = todayInDarwin();
    const send = (body: unknown) =>
      myobRequest({
        actor: { kind: "system", name: "agreement-test" },
        body,
        headers: {},
        method: "POST",
        purpose: "create-order",
        url: `${API}/Purchase/Order/Service`,
      });
    const disguised = { Date: today, toJSON: () => ({ Date: "2026-09-01" }) };

    await expect(send(disguised)).rejects.toMatchObject({ code: "outside_period" });
    await expect(send(`{"Date":"${today}","Date":"2026-09-01"}`)).rejects.toMatchObject({ code: "outside_period" });
    expect(fetchMock).not.toHaveBeenCalled();
    await send({ Date: today });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("term 3: the Purchases section only", () => {
  it("asks MYOB for exactly sme-company-file and sme-purchases", () => {
    expect([...MYOB_SCOPES]).toEqual(["sme-company-file", "sme-purchases"]);
    expect(MYOB_SCOPE_STRING).toBe("sme-company-file sme-purchases");
    process.env.MYOB_CLIENT_ID = "id";
    process.env.MYOB_REDIRECT_URI = "https://example.test/cb";
    expect(new URL(buildAuthorizeUrl("s")).searchParams.get("scope")).toBe(MYOB_SCOPE_STRING);
  });

  it("reaches nothing in a company file outside Purchase/Quote, Order and Bill", () => {
    for (const rule of MYOB_ENDPOINTS) {
      if (rule.operation === "files.list" || rule.operation === "company_file.read") continue;
      expect(sourceOf(rule.pattern)).toMatch(/\/Purchase\/(\(\?:Quote\|Order\|Bill\)|Quote\/|Order\/|Bill\/)/);
    }
  });

  it("lets no setting change the scopes: nothing reads MYOB_SCOPE", () => {
    const src = join(__dirname, "..");
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) return name === "__tests__" ? [] : walk(full);
        return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [full] : [];
      });
    const readers = walk(src).filter((file) => /process\.env\.MYOB_SCOPE\b/.test(readFileSync(file, "utf8")));
    expect(readers.map((f) => relative(src, f))).toEqual([]);
  });
});

describe("term 4: supplier cards (and their bank details) are out of reach", () => {
  it("has no contacts scope and no Contact path", () => {
    expect(MYOB_SCOPES.some((s) => /contact/i.test(s))).toBe(false);
    expect(MYOB_ENDPOINTS.some((r) => /contact/i.test(r.pattern.source))).toBe(false);
  });

  it.each(["GET", "POST", "PUT"])("refuses %s Contact/Supplier as the Card File", (method) => {
    expect(classify(method, `/Contact/Supplier${method === "PUT" ? `/${UID}` : ""}`)).toMatchObject({
      forbiddenCentre: "Card File",
      kind: "refused",
    });
  });
});

describe("term 5: no other MYOB centre", () => {
  it("requests no banking, sales, payroll, general-ledger or inventory scope", () => {
    for (const scope of MYOB_SCOPES) expect(scope).not.toMatch(/banking|sale|payroll|general-ledger|inventory|contacts/);
  });

  it.each([
    ["GET", "/GeneralLedger/Account", "Accounts"],
    ["POST", "/GeneralLedger/GeneralJournal", "Accounts"],
    ["POST", "/Banking/SpendMoneyTxn", "Banking"],
    ["GET", "/Banking/BankAccount", "Banking"],
    ["POST", "/Sale/Invoice/Service", "Sales"],
    ["GET", "/Payroll/PayrollCategory", "Payroll"],
  ])("refuses %s %s (%s)", (method, path, centre) => {
    expect(classify(method, path)).toMatchObject({ forbiddenCentre: centre, kind: "refused" });
  });
});
