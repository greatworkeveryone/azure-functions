/// <reference types="jest" />

jest.mock("../db", () => ({ executeQuery: jest.fn() }));
jest.mock("../ledger", () => ({ record: jest.fn().mockResolvedValue(undefined) }));
jest.mock("./floorplanRecords", () => ({ installFloorplanRecordLookup: jest.fn() }));
jest.mock("./draft", () => ({ buildDraft: jest.fn() }));
jest.mock("./proposalsStore", () => ({ getProposal: jest.fn(), latestVerifiedForUid: jest.fn(), updateProposal: jest.fn() }));
jest.mock("./sendSteps", () => ({ ...jest.requireActual("./sendSteps"), pushApproved: jest.fn() }));

import { approveAndSend, type SendDeps } from "./send";
import type { Person } from "./propose";
import type { ProposalRow } from "./proposalsStore";

const { executeQuery } = require("../db") as { executeQuery: jest.Mock };
const { installFloorplanRecordLookup } = require("./floorplanRecords") as { installFloorplanRecordLookup: jest.Mock };
const lookupInstalledOnLoad = installFloorplanRecordLookup.mock.calls.length;
const { record } = require("../ledger") as { record: jest.Mock };
const { buildDraft } = require("./draft") as { buildDraft: jest.Mock };
const store = require("./proposalsStore") as Record<string, jest.Mock>;
const { pushApproved } = require("./sendSteps") as { pushApproved: jest.Mock };

const CF = "0f9e8d7c-6b5a-4f3e-9d2c-1b0a99887766";
const UID = "44444444-2222-4333-8444-555555555555";
const NOW = new Date("2026-10-14T00:10:00Z");
const JOHANNE: Person = { ledger: { kind: "user", name: "Johanne", role: "cfo", userId: 12 }, name: "Johanne", oid: "cfo-oid" };
const RAY: Person = { ledger: { kind: "user", name: "Ray", role: "accounts_manager", userId: 3 }, name: "Ray", oid: "ray-oid" };

const proposal = (over: Partial<ProposalRow> = {}): ProposalRow =>
  ({
    companyFileId: CF, correlationId: "9b1f2c34-5d6e-4f70-8a91-0b2c3d4e5f60", jobId: 12, myobUid: null, operation: "orders.create",
    payload: { Number: "66Sm261014" }, proposalId: 5, proposedAt: "2026-10-14T00:00:00.000Z", proposedBy: "Ray", proposedByOid: "ray-oid",
    rowVersion: "v1", state: "proposed", subjectId: 9, subjectType: "purchase_order", targetUid: null, ...over,
  }) as ProposalRow;

const draft = (over: Record<string, unknown> = {}) => ({
  draft: {
    companyFileId: CF, mapping: { companyFile: { id: CF, mode: "write", name: "Demo Pty Ltd" } }, payload: { Number: "66Sm261014" },
    payloadHash: "h1", rendered: { sentence: "This creates Order 66Sm261014…" }, ...over,
  },
  ok: true,
});

const deps: SendDeps = { link: () => null, myob: {} as SendDeps["myob"], now: () => NOW, withTx: (work) => work({} as never) };
const send = (person = JOHANNE, over: Record<string, unknown> = {}) =>
  approveAndSend(deps, person, { expectedRowVersion: "v1", payloadHash: "h1", previewedAt: new Date("2026-10-14T00:08:00Z"), proposalId: 5, ...over });

const RP_FILE = "abcdef12-2222-4333-8444-5555555555ee";
const savedEnv = { ...process.env };
afterAll(() => {
  process.env = savedEnv;
});

let requireReview = true;
let demonstration: { IsDemonstration: boolean; Name: string } | null = { IsDemonstration: true, Name: "Demo Pty Ltd" };

beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...savedEnv, MYOB_RP_COMPANY_FILE_ID: RP_FILE };
  requireReview = true;
  demonstration = { IsDemonstration: true, Name: "Demo Pty Ltd" };
  executeQuery.mockImplementation(async (_c: unknown, sql: string) =>
    sql.includes("Escalations") ? [] : sql.includes("MyobCompanyFiles") ? (demonstration ? [demonstration] : []) : [{ RequireReview: requireReview }],
  );
  store.getProposal.mockResolvedValue(proposal());
  store.updateProposal.mockImplementation(async (_tx: unknown, _id: number, _v: string, fields: Record<string, unknown>) =>
    proposal({ myobUid: (fields.MyobUid as string) ?? null, rowVersion: "v2", state: (fields.State as ProposalRow["state"]) ?? "pushed" }),
  );
  buildDraft.mockResolvedValue(draft());
  pushApproved.mockResolvedValue({ diff: [], kind: "verified", linked: false, readBack: { Number: "66Sm261014", RowVersion: "7" }, uid: UID });
});

it("installs the Floorplan-record lookup when the send pipeline loads (without it every update is refused)", () => expect(lookupInstalledOnLoad).toBe(1));

describe("approve (inside Floorplan, before any MYOB call)", () => {
  it("refuses the proposer as reviewer while the control requires review", async () => {
    store.getProposal.mockResolvedValue(proposal({ proposedBy: "Johanne", proposedByOid: "cfo-oid" }));
    await expect(send()).rejects.toMatchObject({ status: 403 });
    expect(pushApproved).not.toHaveBeenCalled();
  });

  it("lets the proposer send when the CFO has review switched off for that operation", async () => {
    requireReview = false;
    store.getProposal.mockResolvedValue(proposal({ proposedBy: "Johanne", proposedByOid: "cfo-oid" }));
    await expect(send()).resolves.toMatchObject({ outcome: "verified" });
  });

  it.each([
    ["a stale version", () => send(JOHANNE, { expectedRowVersion: "old" }), 409],
    ["a proposal already verified", () => (store.getProposal.mockResolvedValue(proposal({ state: "verified" })), send()), 409],
    ["a preview whose hash no longer matches the record", () => send(JOHANNE, { payloadHash: "other" }), 409],
    ["a preview more than 10 minutes old", () => send(JOHANNE, { previewedAt: new Date("2026-10-13T23:50:00Z") }), 409],
    ["a file set to read only", () => (buildDraft.mockResolvedValue(draft({ mapping: { companyFile: { id: CF, mode: "read", name: "Demo" } } })), send()), 409],
    ["an unmapped record", () => (buildDraft.mockResolvedValue({ ok: false, reasons: ["Ask Johanne to add ACME to the supplier export"], status: 409 }), send()), 409],
  ])("refuses %s, sending nothing", async (_label, act, status) => {
    await expect((act as () => Promise<unknown>)()).rejects.toMatchObject({ status });
    expect(pushApproved).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it("refuses a second send while the first push is in flight, and allows one once a push can no longer be running", async () => {
    store.getProposal.mockResolvedValue(proposal({ pushedAt: "2026-10-14T00:09:00.000Z", state: "pushed" }));
    await expect(send()).rejects.toMatchObject({ message: expect.stringContaining("being sent to MYOB now"), status: 409 });
    expect(pushApproved).not.toHaveBeenCalled();
    store.getProposal.mockResolvedValue(proposal({ pushedAt: "2026-10-13T23:56:00.000Z", state: "pushed" })); // 14 minutes: a slow push can still be running
    await expect(send()).rejects.toMatchObject({ status: 409 });
    store.getProposal.mockResolvedValue(proposal({ pushedAt: "2026-10-13T23:50:00.000Z", state: "pushed" }));
    await expect(send()).resolves.toMatchObject({ outcome: "verified" });
  });

  it("refuses a record that changed since it was proposed (amount, supplier, account, tax code, number, description)", async () => {
    const doc = (over: Record<string, unknown> = {}, line: Record<string, unknown> = {}) => ({
      Date: "2026-10-14T00:00:00", Lines: [{ Account: { UID: "a" }, Description: "Fix the roof", TaxCode: { UID: "t" }, Total: 4840, Type: "Transaction", ...line }],
      Number: "66Sm261014", Supplier: { UID: "s" }, ...over,
    });
    store.getProposal.mockResolvedValue(proposal({ payload: doc() }));
    for (const changed of [doc({}, { Total: 48400 }), doc({ Supplier: { UID: "s2" } }), doc({}, { Account: { UID: "a2" } }), doc({}, { TaxCode: { UID: "t2" } }), doc({ Number: "66Sm261015" }), doc({}, { Description: "Fix the roof and gutters" })]) {
      buildDraft.mockResolvedValue(draft({ payload: changed }));
      await expect(send()).rejects.toMatchObject({ message: expect.stringContaining("changed since it was proposed: withdraw and propose again"), status: 409 });
    }
    expect(pushApproved).not.toHaveBeenCalled();
    expect(store.updateProposal).not.toHaveBeenCalled();
    // The approval date and the approver's attribution are the only things approval adds.
    buildDraft.mockResolvedValue(draft({ payload: doc({ Date: "2026-10-15T00:00:00", JournalMemo: "FP 66Sm261014 · proposed Ray · approved Johanne" }) }));
    await expect(send()).resolves.toMatchObject({ outcome: "verified" });
  });

  it("refuses any company file that isn't flagged as the demonstration file (no production writes this sprint)", async () => {
    demonstration = { IsDemonstration: false, Name: "Randazzo Properties" };
    await expect(send()).rejects.toMatchObject({ message: expect.stringContaining("demonstration file"), status: 409 });
    demonstration = null;
    await expect(send()).rejects.toMatchObject({ status: 409 });
    expect(pushApproved).not.toHaveBeenCalled();
    expect(store.updateProposal).not.toHaveBeenCalled();
  });

  it("sends nothing while MYOB_RP_COMPANY_FILE_ID is unset: Floorplan can't tell RP's own file from the demonstration file (M5 review)", async () => {
    for (const value of [undefined, "", "  "]) {
      if (value === undefined) delete process.env.MYOB_RP_COMPANY_FILE_ID;
      else process.env.MYOB_RP_COMPANY_FILE_ID = value;
      await expect(send()).rejects.toMatchObject({ message: expect.stringContaining("MYOB_RP_COMPANY_FILE_ID"), status: 409 });
    }
    expect(buildDraft).not.toHaveBeenCalled();
    expect(pushApproved).not.toHaveBeenCalled();
    expect(store.updateProposal).not.toHaveBeenCalled();
  });

  it("never sends to RP's own file, even one flagged as the demonstration file (M5 review)", async () => {
    store.getProposal.mockResolvedValue(proposal({ companyFileId: RP_FILE }));
    demonstration = { IsDemonstration: true, Name: "Randazzo Properties" };
    process.env.MYOB_RP_COMPANY_FILE_ID = ` ${RP_FILE.toUpperCase()} `;
    await expect(send()).rejects.toMatchObject({ message: "Randazzo Properties is RP's own company file. Floorplan sends only to the demonstration file until the test-data check and the money gate cover MYOB.", status: 409 });
    expect(pushApproved).not.toHaveBeenCalled();
    expect(store.updateProposal).not.toHaveBeenCalled();
  });

  it("refuses RP's file whatever case its stored id is in (M5 follow-up S06)", async () => {
    store.getProposal.mockResolvedValue(proposal({ companyFileId: RP_FILE.toUpperCase() }));
    demonstration = { IsDemonstration: true, Name: "Randazzo Properties" };
    await expect(send()).rejects.toMatchObject({ message: expect.stringContaining("is RP's own company file"), status: 409 });
    expect(pushApproved).not.toHaveBeenCalled();
  });

  it("rebuilds the payload with the reviewer as approver at the previewed time", async () => {
    await send();
    expect(buildDraft).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      approver: { at: new Date("2026-10-14T00:08:00Z"), name: "Johanne" },
      proposalId: 5,
      proposer: { at: new Date("2026-10-14T00:00:00.000Z"), name: "Ray" },
    }));
  });
});

describe("send and record", () => {
  it("approves, pushes, then records verified with MYOB's uid; ledgers approve and push", async () => {
    const outcome = await send();
    expect(outcome).toMatchObject({ outcome: "verified" });
    expect(store.updateProposal.mock.calls[0][3]).toMatchObject({ PushedAt: NOW, ReviewedBy: "Johanne", State: "pushed" });
    expect(store.updateProposal.mock.calls[1][3]).toMatchObject({ MyobRowVersion: "7", MyobUid: UID, State: "verified" });
    expect(record.mock.calls.map((c: unknown[]) => (c[1] as { action: string }).action)).toEqual(["myob.approve", "myob.push"]);
  });

  it("on a timeout records an exception and never a MYOB uid (nothing marked as in MYOB)", async () => {
    pushApproved.mockResolvedValue({ kind: "failed", message: "MYOB didn't answer clearly" });
    const outcome = await send();
    expect(outcome.outcome).toBe("failed");
    const final = store.updateProposal.mock.calls[1][3];
    expect(final).toMatchObject({ State: "exception" });
    expect(final.MyobUid).toBeUndefined();
    expect(record.mock.calls[1][1]).toMatchObject({ action: "myob.exception" });
  });

  it("returns the proposal to approved, ledgering no push, when Floorplan's controls refuse or it's a dry run", async () => {
    for (const kind of ["refused", "dry_run"]) {
      jest.clearAllMocks();
      buildDraft.mockResolvedValue(draft());
      store.getProposal.mockResolvedValue(proposal());
      pushApproved.mockResolvedValue({ kind, message: "x", reason: "controls" });
      const outcome = await send();
      expect(outcome.outcome).toBe(kind);
      expect(store.updateProposal).toHaveBeenCalledTimes(2);
      expect(store.updateProposal.mock.calls[1][3]).toEqual({ PushedAt: null, State: "approved" });
      expect(record.mock.calls.map((c: unknown[]) => (c[1] as { action: string }).action)).toEqual(["myob.approve"]);
    }
  });

  it("says a period refusal is the period rule, not the controls", async () => {
    pushApproved.mockResolvedValue({ kind: "refused", message: "dated 30/09/2026, outside the current period", reason: "outside_period" });
    const outcome = await send();
    expect(outcome.message).toContain("current-period rule");
    expect(outcome.message).not.toContain("controls");
  });

  it("checks RP's file at approval, before D9's test-record refusal at the push; with both clear of it a test record is still not sent", async () => {
    delete process.env.MYOB_RP_COMPANY_FILE_ID;
    await expect(send()).rejects.toMatchObject({ status: 409 });
    expect(pushApproved).not.toHaveBeenCalled();
    process.env.MYOB_RP_COMPANY_FILE_ID = RP_FILE;
    pushApproved.mockResolvedValue({ kind: "refused", message: "Test records never leave Floorplan", reason: "test_record" });
    const outcome = await send();
    expect(pushApproved).toHaveBeenCalledTimes(1);
    expect(outcome.message).toContain("Test records never go to MYOB");
  });

  it("records a read-back that differs from what was sent as an exception, never as verified", async () => {
    pushApproved.mockResolvedValue({ diff: [{ field: "total", myob: 5000, sent: 4840 }], kind: "differs", linked: false, readBack: { RowVersion: "7" }, uid: UID });
    const outcome = await send();
    expect(outcome.outcome).toBe("differs");
    expect(store.updateProposal.mock.calls[1][3]).toMatchObject({ MyobError: expect.stringContaining("different"), MyobUid: UID, State: "exception" });
    expect(record.mock.calls[1][1]).toMatchObject({ action: "myob.exception" });
  });

  it("refuses an update whose record moved in MYOB, recording the diff for reconciliation", async () => {
    store.getProposal.mockResolvedValue(proposal({ operation: "orders.update", targetUid: UID }));
    store.latestVerifiedForUid.mockResolvedValue(proposal({ myobRowVersion: "7", readBack: { Number: "66Sm261014" } } as Partial<ProposalRow>));
    pushApproved.mockResolvedValue({ diff: [{ field: "total", myob: 5000, sent: 4840 }], kind: "changed_in_myob", readBack: {} });
    const outcome = await send();
    expect(outcome.outcome).toBe("changed_in_myob");
    expect(store.updateProposal.mock.calls[1][3]).toMatchObject({ MyobError: expect.stringContaining("Changed in MYOB"), State: "exception" });
  });
});

it("blocks the MYOB push when a job has an open attribution dispute", async () => {
  const base = executeQuery.getMockImplementation();
  executeQuery.mockImplementation(async (...args: unknown[]) => /FROM dbo\.Escalations/.test(String(args[1])) ? [{ EscalationId: 7 }] : base?.(...args));
  await expect(send()).rejects.toMatchObject({ status: 409 });
  expect(pushApproved).not.toHaveBeenCalled();
});
