/// <reference types="jest" />

jest.mock("../ledger", () => ({ record: jest.fn().mockResolvedValue(undefined) }));
jest.mock("./draft", () => ({ buildDraft: jest.fn() }));
jest.mock("./proposalsStore", () => ({ insertProposal: jest.fn(), proposalsForSubject: jest.fn() }));

import { propose } from "./propose";

const { record } = require("../ledger") as { record: jest.Mock };
const { buildDraft } = require("./draft") as { buildDraft: jest.Mock };
const store = require("./proposalsStore") as Record<string, jest.Mock>;

const CF = "0f9e8d7c-6b5a-4f3e-9d2c-1b0a99887766";
const NOW = new Date("2026-10-14T00:10:00Z");
const RAY = { ledger: { kind: "user" as const, name: "Ray", role: "accounts_manager", userId: 3 }, name: "Ray", oid: "ray-oid" };
const INPUT = { operation: "orders.create" as const, payloadHash: "h1", previewedAt: new Date("2026-10-14T00:09:00Z"), subjectId: 9, subjectType: "purchase_order" as const };
const CORRELATION = "9b1f2c34-5d6e-4f70-8a91-0b2c3d4e5f60";

const draft = (mode = "write") => ({
  draft: {
    companyFileId: CF, facts: { jobId: 12 }, idempotencyKey: "k", mapping: { companyFile: { id: CF, mode, name: "Demo Pty Ltd" } },
    payload: { Number: "66Sm261014" }, payloadHash: "h1", rendered: { number: "66Sm261014", sentence: "This creates Order…" }, target: null,
  },
  ok: true,
});

beforeEach(() => {
  jest.clearAllMocks();
  buildDraft.mockResolvedValue(draft());
  store.proposalsForSubject.mockResolvedValue([]);
  store.insertProposal.mockImplementation(async (_tx: unknown, row: Record<string, unknown>) => ({ ...row, proposalId: 5 }));
});

describe("propose", () => {
  it("records exactly the previewed payload as a proposal, sends nothing, and ledgers myob.propose", async () => {
    const row = await propose({} as never, RAY, INPUT, CORRELATION, NOW);
    expect(row).toMatchObject({ companyFileId: CF, payloadHash: "h1", proposedBy: "Ray", proposedByOid: "ray-oid" });
    expect(buildDraft).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ proposer: { at: INPUT.previewedAt, name: "Ray" } }));
    expect(record).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "myob.propose", subject: { id: 5, type: "myob_proposal" } }));
  });

  it.each([
    ["a changed record (hash differs)", () => propose({} as never, RAY, { ...INPUT, payloadHash: "stale" }, CORRELATION, NOW)],
    ["a file switched off", () => (buildDraft.mockResolvedValue(draft("off")), propose({} as never, RAY, INPUT, CORRELATION, NOW))],
    ["a second open proposal", () => (store.proposalsForSubject.mockResolvedValue([{ operation: "orders.create", state: "proposed" }]), propose({} as never, RAY, INPUT, CORRELATION, NOW))],
    ["a proposal while one is being sent", () => (store.proposalsForSubject.mockResolvedValue([{ operation: "orders.create", state: "pushed" }]), propose({} as never, RAY, INPUT, CORRELATION, NOW))],
    ["an unmapped contractor", () => (buildDraft.mockResolvedValue({ ok: false, reasons: ["Ask Johanne to add ACME Air to the supplier export"], status: 409 }), propose({} as never, RAY, INPUT, CORRELATION, NOW))],
  ])("refuses %s with 409, recording nothing", async (_label, act) => {
    await expect((act as () => Promise<unknown>)()).rejects.toMatchObject({ status: 409 });
    expect(store.insertProposal).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it("answers 409, not 500, when two proposals land at the same moment and the database's unique index refuses the second", async () => {
    store.insertProposal.mockRejectedValue(Object.assign(new Error("Cannot insert duplicate key row ... UX_MyobProposals_OpenSubject"), { number: 2601 }));
    await expect(propose({} as never, RAY, INPUT, CORRELATION, NOW)).rejects.toMatchObject({
      message: expect.stringContaining("already an open MYOB proposal"),
      status: 409,
    });
    expect(record).not.toHaveBeenCalled();
    store.insertProposal.mockRejectedValue(Object.assign(new Error("deadlock"), { number: 1205 }));
    await expect(propose({} as never, RAY, INPUT, CORRELATION, NOW)).rejects.not.toHaveProperty("status");
  });

  it("passes the plain reason for an unmapped contractor through", async () => {
    buildDraft.mockResolvedValue({ ok: false, reasons: ["Ask Johanne to add ACME Air to the supplier export"], status: 409 });
    await expect(propose({} as never, RAY, INPUT, CORRELATION, NOW)).rejects.toMatchObject({ reasons: ["Ask Johanne to add ACME Air to the supplier export"] });
  });
});
