/// <reference types="jest" />

import { buildMyobDailyEmail, companyFileOfPath } from "./email";
import type { DailyFacts, MyobCall, ProposalEvent } from "./types";

const DEMO = "0f9e8d7c-6b5a-4f3e-9d2c-1b0a99887766";
const RP = "11111111-2222-4333-8444-555555555555"; // RP's own file, never registered here
const AT = (hhmm: string) => new Date(`2026-10-14T${hhmm}:00+09:30`);
const event = (over: Partial<ProposalEvent> = {}): ProposalEvent => ({
  action: "myob.propose", actorName: "Ray", after: null, companyFileId: DEMO, companyFileName: "Demo Pty Ltd", jobId: 12, myobNumber: null,
  myobUrl: null, occurredAt: AT("09:12"), operation: "orders.create", proposalId: 5, proposedBy: "Ray", reason: null,
  rendered: { amount: "$4,840.00 inc GST", document: "Order", number: "66Sm261014", supplier: "ACME Air Pty Ltd" }, reviewedBy: null, ruleApplied: null,
  ...over,
});
const call = (over: Partial<MyobCall> = {}): MyobCall => ({
  actorKind: "user", actorName: "Johanne", errorMessage: null, httpStatus: 201, method: "POST", occurredAt: AT("09:35"),
  path: `/accountright/${DEMO}/Purchase/Order/Service`, phase: "response", purpose: "create-order", ...over,
});
const facts = (over: Partial<DailyFacts> = {}): DailyFacts => ({
  calls: [], events: [], files: [{ id: DEMO, name: "Demo Pty Ltd" }], since: new Date("2026-10-13T07:30:00+09:30"), until: new Date("2026-10-14T07:30:00+09:30"), ...over,
});
const OPTIONS = { baseUrl: "https://floorplan.example", firstName: "Johanne", overriddenFrom: null };

describe("buildMyobDailyEmail", () => {
  it("sends nothing when Floorplan did nothing in MYOB", () => {
    expect(buildMyobDailyEmail(facts(), OPTIONS)).toBeNull();
  });

  it("lists each record created, every proposal state change and every MYOB call, each with the acting person", () => {
    const email = buildMyobDailyEmail(
      facts({
        calls: [call({ httpStatus: 200, method: "GET", purpose: "find-order-by-number" }), call()],
        events: [
          event(),
          event({ action: "myob.approve", actorName: "Johanne", occurredAt: AT("09:35") }),
          event({ action: "myob.push", actorName: "Johanne", myobNumber: "66Sm261014", myobUrl: "https://app.myob.com/o/1", occurredAt: AT("09:36"), reviewedBy: "Johanne" }),
          event({ action: "myob.withdraw", actorName: "Ana", proposalId: 6, reason: "Wrong supplier" }),
        ],
      }),
      OPTIONS,
    );
    expect(email).not.toBeNull();
    const body = email!.body;
    expect(email!.subject).toBe("What Floorplan did in MYOB, 14/10/2026");
    expect(email!.subject).not.toMatch(/\$|ACME|66Sm/);
    expect(body).toContain("Records created in MYOB (1)");
    expect(body).toContain("- Order 66Sm261014 · ACME Air Pty Ltd · $4,840.00 inc GST · proposed by Ray · approved by Johanne · Demo Pty Ltd");
    expect(body).toContain("https://floorplan.example/jobs?jobId=12");
    expect(body).toContain("View in MYOB: https://app.myob.com/o/1");
    expect(body).toContain("Proposals (4 changes)");
    expect(body).toContain("- 14/10 09:12 · Ray · proposed · Order 66Sm261014");
    expect(body).toContain("- 14/10 09:35 · Johanne · approved and sent · Order 66Sm261014");
    expect(body).toContain("- 14/10 09:36 · Johanne · in MYOB, read back and matches · Order 66Sm261014");
    expect(body).toContain("- 14/10 09:12 · Ana · withdrew (Wrong supplier) · Order 66Sm261014");
    expect(body).toContain("MYOB calls (2)");
    expect(body).toContain("- 14/10 09:35 · Johanne · GET find-order-by-number · HTTP 200");
    expect(body).toContain("- 14/10 09:35 · Johanne · POST create-order · HTTP 201");
  });

  it("reports discrepancies seen or cleared under 'Changed in MYOB since'", () => {
    const fields = [{ field: "total", floorplan: "$4,840.00 inc GST", label: "Amount", myob: "$4,900.00 inc GST" }];
    const email = buildMyobDailyEmail(
      facts({
        events: [
          event({ action: "myob.discrepancy", actorName: "myobReadbackTimer", after: { fields, missing: false }, occurredAt: AT("10:00"), ruleApplied: "found" }),
          event({ action: "myob.discrepancy", actorName: "myobReadbackTimer", after: { fields: [], missing: true }, occurredAt: AT("11:00"), proposalId: 7, ruleApplied: "missing" }),
          event({ action: "myob.discrepancy", actorName: "myobReadbackTimer", after: { cleared: true }, occurredAt: AT("12:00"), proposalId: 8, ruleApplied: "cleared" }),
        ],
      }),
      OPTIONS,
    )!;
    expect(email.body).toContain("Changed in MYOB since (3)");
    expect(email.body).toContain("- 14/10 10:00 · Order 66Sm261014 · Amount: MYOB $4,900.00 inc GST · Floorplan $4,840.00 inc GST");
    expect(email.body).toContain("- 14/10 11:00 · Order 66Sm261014 · missing in MYOB");
    expect(email.body).toContain("- 14/10 12:00 · Order 66Sm261014 · matches Floorplan again");
    expect(email.body).not.toContain("Proposals (");
  });

  it("never includes a record or call from a company file the CFO has not registered", () => {
    const unregistered = buildMyobDailyEmail(
      facts({
        calls: [call({ path: `/accountright/${RP}/Purchase/Order/Service/abc`, purpose: "read-back-order" })],
        events: [event({ companyFileId: RP, companyFileName: "Randazzo Properties", rendered: { document: "Order", number: "RP-SECRET" } })],
      }),
      OPTIONS,
    );
    expect(unregistered).toBeNull();

    const mixed = buildMyobDailyEmail(
      facts({
        calls: [call(), call({ path: `/accountright/${RP.toUpperCase()}/Purchase/Order/Service`, purpose: "rp-call" })],
        events: [event(), event({ companyFileId: RP, companyFileName: "Randazzo Properties", rendered: { document: "Order", number: "RP-SECRET" } })],
      }),
      OPTIONS,
    )!;
    expect(mixed.body).not.toMatch(/RP-SECRET|Randazzo|rp-call/);
    expect(mixed.body).not.toContain(RP);
    expect(mixed.body).toContain("MYOB calls (1)");
  });

  it("keeps account-level calls (sign-in, the file list), lists refusals, and summarises the read-back timer's successful reads", () => {
    const reads = Array.from({ length: 30 }, (_, i) => call({ actorKind: "system", actorName: "myobReadbackTimer", httpStatus: 200, method: "GET", occurredAt: AT(`10:${String(i).padStart(2, "0")}`), purpose: "read-back-order" }));
    const email = buildMyobDailyEmail(
      facts({
        calls: [
          ...reads,
          call({ actorKind: "system", actorName: "myobReadbackTimer", errorMessage: "purchases.read is switched off", httpStatus: null, method: "GET", phase: "error", purpose: "read-back-order" }),
          call({ actorKind: "system", actorName: "myobReadbackTimer", httpStatus: 200, path: "/oauth2/v1/authorize", purpose: "oauth-token-refresh" }),
        ],
      }),
      OPTIONS,
    )!;
    expect(email.body).toContain("MYOB calls (32)");
    expect(email.body).toContain("- myobReadbackTimer (automatic) · GET read-back-order · 30 calls, all answered");
    expect(email.body).toContain("- 14/10 09:35 · myobReadbackTimer · GET read-back-order · refused or failed: purchases.read is switched off");
    expect(email.body).toContain("oauth-token-refresh");
  });

  it("caps the call list and points to Admin → MYOB for the rest", () => {
    const many = Array.from({ length: 5 }, (_, i) => call({ purpose: `create-order-${i}` }));
    const email = buildMyobDailyEmail(facts({ calls: many }), { ...OPTIONS, maxCallLines: 2 })!;
    expect(email.body).toContain("and 3 more calls: https://floorplan.example/admin/myob");
  });

  it("says when DEV_EMAIL_OVERRIDE redirected it", () => {
    expect(buildMyobDailyEmail(facts({ calls: [call()] }), { ...OPTIONS, overriddenFrom: "johanne@rp" })!.body).toContain("meant for johanne@rp");
  });
});

describe("companyFileOfPath", () => {
  it("reads the company file from a MYOB path, and none from an account-level one", () => {
    expect(companyFileOfPath(`/accountright/${DEMO.toUpperCase()}/Purchase/Order/Service?$filter=x`)).toBe(DEMO);
    expect(companyFileOfPath("/accountright/")).toBeNull();
    expect(companyFileOfPath("/oauth2/v1/authorize")).toBeNull();
  });
});
