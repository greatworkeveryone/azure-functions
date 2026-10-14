/// <reference types="jest" />

jest.mock("./subjects", () => ({ loadSubject: jest.fn() }));
jest.mock("./mappings", () => ({ resolveMapping: jest.fn() }));
jest.mock("./proposalsStore", () => ({ latestVerifiedForUid: jest.fn(), proposalsForSubject: jest.fn() }));

import { buildDraft } from "./draft";
import { payloadHash } from "./hash";

const { loadSubject } = require("./subjects") as { loadSubject: jest.Mock };
const { resolveMapping } = require("./mappings") as { resolveMapping: jest.Mock };
const store = require("./proposalsStore") as Record<string, jest.Mock>;

const CF = "0f9e8d7c-6b5a-4f3e-9d2c-1b0a99887766";
const UID = "44444444-2222-4333-8444-555555555555";
const AT = new Date("2026-10-13T23:42:00Z"); // 14/10 09:12 Darwin
const FACTS = {
  amount: 4840, buildingId: 3, chargeCode: "m", contractorId: 7, contractorName: "ACME Air", description: "66Sm261014 · Floorplan job #12",
  jobId: 12, notReady: null, reference: "66Sm261014", subjectId: 9, subjectType: "purchase_order",
};
const MAPPING = {
  account: { label: "6-1100 Repairs", uid: "acct" }, companyFile: { id: CF, mode: "write", name: "Demo Pty Ltd" },
  supplier: { name: "ACME Air Pty Ltd", uid: "sup" }, taxCode: { code: "GST", uid: "gst" },
};
const draft = (over: Record<string, unknown> = {}) =>
  buildDraft({} as never, { operation: "orders.create", proposer: { at: AT, name: "Ray" }, subjectId: 9, subjectType: "purchase_order", ...over });

beforeEach(() => {
  jest.clearAllMocks();
  loadSubject.mockResolvedValue(FACTS);
  resolveMapping.mockResolvedValue({ ok: true, value: MAPPING });
  store.proposalsForSubject.mockResolvedValue([]);
});

describe("buildDraft for a create", () => {
  it("builds the order dated today in Darwin with the attribution, and renders it in the CFO's words", async () => {
    const result = await draft({ approver: { at: new Date("2026-10-14T00:05:00Z"), name: "Johanne" }, proposalId: 5 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.draft.payload).toMatchObject({
      Date: "2026-10-14T00:00:00",
      JournalMemo: "FP 66Sm261014 · proposed Ray 14/10 09:12 · approved Johanne 14/10 09:35",
      Number: "66Sm261014",
      Supplier: { UID: "sup" },
    });
    expect(result.draft.payloadHash).toBe(payloadHash(result.draft.payload));
    expect(result.draft.rendered.sentence).toBe(
      "This creates Order 66Sm261014 for $4,840.00 inc GST to ACME Air Pty Ltd in Demo Pty Ltd, dated 14/10/2026. Nothing else in MYOB changes.",
    );
  });

  it("gives the same hash for the same inputs, and a different one when the record changes", async () => {
    const a = await draft();
    const b = await draft();
    loadSubject.mockResolvedValue({ ...FACTS, amount: 4900 });
    const c = await draft();
    expect(a.ok && b.ok && c.ok).toBe(true);
    if (!a.ok || !b.ok || !c.ok) return;
    expect(a.draft.payloadHash).toBe(b.draft.payloadHash);
    expect(c.draft.payloadHash).not.toBe(a.draft.payloadHash);
  });

  it.each([
    ["bills (off until the CFO approves the conversion path)", { operation: "bills.create" }, "Bills stay off"],
    ["an operation that doesn't fit the record", { operation: "quotes.create" }, "doesn't apply"],
  ])("refuses %s", async (_label, over, text) => {
    await expect(draft(over)).resolves.toMatchObject({ ok: false, reasons: [expect.stringContaining(text)] });
  });

  it("refuses a record that isn't ready, a number MYOB would reject, and an unmapped one", async () => {
    loadSubject.mockResolvedValueOnce({ ...FACTS, notReady: "This purchase order has no amount" });
    await expect(draft()).resolves.toMatchObject({ ok: false, reasons: ["This purchase order has no amount"] });
    loadSubject.mockResolvedValueOnce({ ...FACTS, reference: "SMITH-ST-2026-0001" });
    await expect(draft()).resolves.toMatchObject({ ok: false, reasons: [expect.stringContaining("Reference code missing")] });
    resolveMapping.mockResolvedValueOnce({ ok: false, reasons: ["Ask Johanne to add ACME Air to the supplier export"] });
    await expect(draft()).resolves.toMatchObject({ ok: false, reasons: ["Ask Johanne to add ACME Air to the supplier export"], status: 409 });
  });

  it("404s a record that no longer exists", async () => {
    loadSubject.mockResolvedValueOnce(null);
    await expect(draft()).resolves.toMatchObject({ ok: false, status: 404 });
  });
});

describe("buildDraft for an update", () => {
  it("is refused when Floorplan never created the record in MYOB", async () => {
    await expect(draft({ operation: "orders.update" })).resolves.toMatchObject({ ok: false, reasons: [expect.stringContaining("hasn't created")] });
  });

  it("targets Floorplan's record, keeps its MYOB date, and shows what changes", async () => {
    const created = { companyFileId: CF, myobUid: UID, operation: "orders.create", payload: { Date: "2026-10-02T00:00:00" }, readBack: null, state: "verified" };
    store.proposalsForSubject.mockResolvedValue([created]);
    store.latestVerifiedForUid.mockResolvedValue({
      myobRowVersion: "7",
      readBack: { Date: "2026-10-02T00:00:00", Lines: [{ Account: { UID: "acct" }, TaxCode: { UID: "gst" }, Total: 4400, Type: "Transaction" }], Number: "66Sm261014", Supplier: { UID: "sup" } },
    });
    const result = await draft({ operation: "orders.update" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.draft.target).toEqual({ myobRowVersion: "7", uid: UID });
    expect(result.draft.payload.Date).toBe("2026-10-02T00:00:00");
    expect(result.draft.rendered.changes).toEqual([{ after: "$4,840.00 inc GST", before: "$4,400.00 inc GST", field: "Amount" }]);
    expect(result.draft.rendered.sentence).toContain("This updates Order 66Sm261014 in Demo Pty Ltd: Amount $4,400.00 inc GST → $4,840.00 inc GST");
  });

  it("keeps the creator's attribution in the memo and comment and appends the updater's", async () => {
    const creatorMemo = "FP 66Sm261014 · proposed Ana 02/10 10:00 · approved Johanne 02/10 11:00";
    const created = {
      companyFileId: CF, myobUid: UID, operation: "orders.create",
      payload: { Comment: `${creatorMemo} · proposal #3 · https://floorplan/jobs/12`, Date: "2026-10-02T00:00:00", JournalMemo: creatorMemo },
      readBack: null, state: "verified",
    };
    store.proposalsForSubject.mockResolvedValue([created]);
    store.latestVerifiedForUid.mockResolvedValue({ myobRowVersion: "7", readBack: { ...created.payload, JournalMemo: `${creatorMemo} · updated Someone 05/10 08:00` } });
    const result = await draft({ approver: { at: new Date("2026-10-13T23:50:00Z"), name: "Johanne" }, operation: "orders.update", proposalId: 8 });
    if (!result.ok) throw new Error("expected a draft");
    expect(result.draft.payload.JournalMemo).toBe(`${creatorMemo} · updated Ray 14/10 09:12 · approved Johanne 14/10 09:20`);
    expect(String(result.draft.payload.Comment)).toMatch(new RegExp(`^${creatorMemo} · updated Ray 14/10 09:12 · approved Johanne 14/10 09:20 · proposal #8`));
    expect(String(result.draft.payload.JournalMemo).length).toBeLessThanOrEqual(255);
  });
});
