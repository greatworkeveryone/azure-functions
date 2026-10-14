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

let requireReview = true;

beforeEach(() => {
  jest.clearAllMocks();
  requireReview = true;
  executeQuery.mockImplementation(async () => [{ RequireReview: requireReview }]);
  store.getProposal.mockResolvedValue(proposal());
  store.updateProposal.mockImplementation(async (_tx: unknown, _id: number, _v: string, fields: Record<string, unknown>) =>
    proposal({ myobUid: (fields.MyobUid as string) ?? null, rowVersion: "v2", state: (fields.State as ProposalRow["state"]) ?? "approved" }),
  );
  buildDraft.mockResolvedValue(draft());
  pushApproved.mockResolvedValue({ diff: [], kind: "verified", linked: false, readBack: { Number: "66Sm261014", RowVersion: "7" }, uid: UID });
});

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
    expect(store.updateProposal.mock.calls[0][3]).toMatchObject({ ReviewedBy: "Johanne", State: "approved" });
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

  it("leaves the proposal approved, with no outcome row, when Floorplan's controls refuse or it's a dry run", async () => {
    for (const kind of ["refused", "dry_run"]) {
      jest.clearAllMocks();
      buildDraft.mockResolvedValue(draft());
      store.getProposal.mockResolvedValue(proposal());
      pushApproved.mockResolvedValue({ kind, message: "x" });
      const outcome = await send();
      expect(outcome.outcome).toBe(kind);
      expect(store.updateProposal).toHaveBeenCalledTimes(1);
    }
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
