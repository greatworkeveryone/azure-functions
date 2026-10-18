/// <reference types="jest" />

import { activityCsv, callView, proposalView } from "./activityView";

const CF = "0f9e8d7c-6b5a-4f3e-9d2c-1b0a99887766";
const RP = "11111111-2222-4333-8444-555555555555";
const FILES = new Map([[CF, "Demo Pty Ltd"]]);
const API = "https://api.myob.com/accountright";
const P = {
  CompanyFileId: CF, Discrepancy: JSON.stringify({ fields: [{ label: "Memo" }, { label: "Amount" }], missing: false }), FileName: "Demo Pty Ltd", LastReadBackAt: new Date("2026-10-16T22:30:00Z"),
  MyobError: null, MyobNumber: "66Sm261014", Operation: "orders.create", ProposalId: 5, ProposedAt: new Date("2026-10-14T00:00:00Z"), ProposedBy: "=Ray",
  PushedAt: new Date("2026-10-14T00:35:00Z"), Rendered: JSON.stringify({ amount: "$4,840.00 inc GST", document: "Order", number: "66Sm261014", supplier: "ACME" }),
  ReviewedAt: new Date("2026-10-14T00:34:00Z"), ReviewedBy: "Johanne", State: "verified",
};
const C = (over: Record<string, unknown>) => ({
  ActorKind: "user", ActorName: "Johanne", DurationMs: 420, ErrorMessage: null, HttpStatus: 201, LogId: 9, Method: "POST", OccurredAt: new Date("2026-10-14T00:35:00Z"),
  Path: `/accountright/${CF}/Purchase/Order/Service`, Phase: "response", ProposalId: 5, Purpose: "create-order", ...over,
});

describe("proposalView", () => {
  it("says what was proposed, by whom, approved by whom, sent when, and MYOB's answer", () => {
    const view = proposalView([P, { ...P, Discrepancy: null, MyobError: "MYOB refused: supplier inactive", ProposalId: 6, State: "exception" }, { ...P, ProposalId: 7, PushedAt: null, ReviewedAt: null, ReviewedBy: null, State: "proposed" }]);
    expect(view.columns.map((c) => c.label)).toEqual(["Proposal", "Record", "Company file", "What", "Proposed by", "Approved by", "Sent", "MYOB's answer"]);
    expect(view.rows[0].values).toMatchObject({ answer: "In MYOB · differs: Memo, Amount", approved: "Johanne · 14/10 10:04", proposed: "=Ray · 14/10 09:30", record: "Order 66Sm261014 · ACME · $4,840.00 inc GST", sent: "14/10 10:05", what: "Create order" });
    expect(view.rows[1].values.answer).toBe("Exception: MYOB refused: supplier inactive");
    expect(view.rows[2].values).toMatchObject({ answer: "Waiting for the CFO", approved: "", sent: "" });
  });
});

describe("callView", () => {
  it("lists each call with who and what MYOB said, only for registered files or the account, with unregistered ids withheld", () => {
    const view = callView(
      [
        C({}),
        C({ ErrorMessage: `MYOB is off for company file ${RP}`, HttpStatus: null, LogId: 10, Method: "GET", Path: "/accountright/", Phase: "error", ProposalId: null, Purpose: "test-connection" }),
        C({ LogId: 11, Path: `/accountright/${RP}/Purchase/Order/Service`, ProposalId: null }),
      ],
      FILES,
      API,
    );
    expect(view.rows.map((r) => r.id)).toEqual(["9", "10"]);
    expect(view.rows[0].values).toMatchObject({ file: "Demo Pty Ltd", outcome: "HTTP 201", proposal: "#5", request: "POST create-order", who: "Johanne" });
    expect(view.rows[1].values).toMatchObject({ file: "MYOB account", outcome: "Refused or failed: MYOB is off for a company file Floorplan isn't set up for" });
  });

  it("keeps only one file's calls when filtered", () => {
    expect(callView([C({}), C({ LogId: 10, Path: "/accountright/" })], FILES, API, CF).rows.map((r) => r.id)).toEqual(["9"]);
  });
});

describe("activityCsv", () => {
  it("exports the same rows with formulas defused and a dated name", () => {
    const csv = activityCsv(proposalView([P]), "proposals", new Date("2026-10-16T23:00:00Z"));
    expect(csv.filename).toBe("floorplan-myob-proposals-2026-10-17.csv");
    expect(csv.text.split("\r\n")[0]).toBe("Proposal,Record,Company file,What,Proposed by,Approved by,Sent,MYOB's answer");
    expect(csv.text).toContain(",'=Ray · 14/10 09:30,");
  });
});
