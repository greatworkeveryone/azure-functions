/// <reference types="jest" />

// The M3 reviewer's scenarios (14 Oct), kept in the suite: a second "Approve
// and send" while the first push is in flight, and a record that changed
// after it was proposed. Proposals live in a small in-memory store with row
// versions, so the race runs as it would against the table.

jest.mock("../db", () => ({
  executeQuery: jest.fn(async (_c: unknown, sql: string) =>
    sql.includes("MyobCompanyFiles") ? [{ IsDemonstration: true, Name: "Demo Pty Ltd" }] : [{ RequireReview: true }],
  ),
}));
jest.mock("../ledger", () => ({ record: jest.fn().mockResolvedValue(undefined) }));
jest.mock("./floorplanRecords", () => ({ installFloorplanRecordLookup: jest.fn() }));
jest.mock("./draft", () => ({ buildDraft: jest.fn() }));
jest.mock("./proposalsStore", () => ({ getProposal: jest.fn(), latestVerifiedForUid: jest.fn(), updateProposal: jest.fn() }));

import { approveAndSend, type SendDeps } from "./send";
import type { Person } from "./propose";
import type { ProposalRow } from "./proposalsStore";
import type { MyobPurchases } from "./sendSteps";

const { buildDraft } = require("./draft") as { buildDraft: jest.Mock };
const store = require("./proposalsStore") as Record<string, jest.Mock>;

const CF = "0f9e8d7c-6b5a-4f3e-9d2c-1b0a99887766";
const UID = "44444444-2222-4333-8444-555555555555";
// send.ts sends nothing while RP's own file isn't named (M5 review); these scenarios run on the demonstration file.
const savedEnv = { ...process.env };
beforeAll(() => {
  process.env = { ...savedEnv, MYOB_RP_COMPANY_FILE_ID: "abcdef12-2222-4333-8444-5555555555ee" };
});
afterAll(() => {
  process.env = savedEnv;
});
const JOHANNE: Person = { ledger: { kind: "user", name: "Johanne", role: "cfo", userId: 12 }, name: "Johanne", oid: "cfo-oid" };
const NOW = new Date("2026-10-14T00:10:00Z");
const doc = (total: number) => ({
  Date: "2026-10-14T00:00:00",
  JournalMemo: "FP 66Sm261014 · proposed Ray",
  Lines: [{ Account: { UID: "a" }, Description: "x", TaxCode: { UID: "t" }, Total: total, Type: "Transaction" }],
  Number: "66Sm261014",
  Supplier: { UID: "s" },
});

let row: ProposalRow;
let version = 1;
function memoryStore(initial: Partial<ProposalRow>) {
  version = 1;
  row = {
    companyFileId: CF, correlationId: "9b1f2c34-5d6e-4f70-8a91-0b2c3d4e5f60", jobId: 12, myobUid: null, operation: "orders.create",
    payload: doc(4840), payloadHash: "proposer-hash", proposalId: 5, proposedAt: "2026-10-14T00:00:00.000Z", proposedBy: "Ray",
    proposedByOid: "ray-oid", pushedAt: null, rowVersion: "v1", state: "proposed", subjectId: 9, subjectType: "purchase_order", targetUid: null,
    rendered: { sentence: "This creates Order 66Sm261014 for $4,840.00 inc GST" }, ...initial,
  } as ProposalRow;
  store.getProposal.mockImplementation(async () => ({ ...row }));
  store.updateProposal.mockImplementation(async (_tx: unknown, _id: number, rv: string, fields: Record<string, unknown>) => {
    if (rv !== row.rowVersion) return null;
    version += 1;
    const pushedAt = "PushedAt" in fields ? (fields.PushedAt instanceof Date ? fields.PushedAt.toISOString() : null) : row.pushedAt;
    row = {
      ...row, myobUid: (fields.MyobUid as string) ?? row.myobUid, payload: fields.Payload ? JSON.parse(String(fields.Payload)) : row.payload,
      pushedAt, rowVersion: `v${version}`, state: (fields.State as ProposalRow["state"]) ?? row.state,
    };
    return { ...row };
  });
}

const deps = (myob: MyobPurchases): SendDeps => ({ link: () => null, myob, now: () => NOW, withTx: (work) => work({} as never) });
const input = (expectedRowVersion: string) => ({ expectedRowVersion, payloadHash: "h1", previewedAt: new Date("2026-10-14T00:08:00Z"), proposalId: 5 });
const drafted = (total: number, sentence = "s") =>
  ({ draft: { companyFileId: CF, mapping: { companyFile: { id: CF, mode: "write", name: "Demo" } }, payload: doc(total), payloadHash: "h1", rendered: { sentence } }, ok: true });

describe("A: a second Approve and send while the first push is still in flight", () => {
  it("is refused: the proposal is pushed from the moment it is approved, and MYOB gets one record", async () => {
    memoryStore({});
    buildDraft.mockResolvedValue(drafted(4840));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const myob = {
      create: jest.fn().mockImplementationOnce(async () => { await gate; return UID; }).mockResolvedValue("55555555-2222-4333-8444-555555555555"),
      find: jest.fn().mockResolvedValue(null),
      get: jest.fn().mockResolvedValue({ ...doc(4840), RowVersion: "7" }),
      put: jest.fn(),
    } as unknown as MyobPurchases & Record<string, jest.Mock>;

    const first = approveAndSend(deps(myob), JOHANNE, input("v1"));
    await new Promise((r) => setTimeout(r, 20));
    expect(row.state).toBe("pushed");
    const second = approveAndSend(deps(myob), JOHANNE, input(row.rowVersion)); // a second tab reloaded the queue
    await expect(second).rejects.toMatchObject({ status: 409 });
    release();
    await expect(first).resolves.toMatchObject({ outcome: "verified" });
    expect((myob as unknown as Record<string, jest.Mock>).create).toHaveBeenCalledTimes(1);
    expect(row.state).toBe("verified");
  });

  it("lets a push that has been 'pushed' longer than a push can take be sent again, and the lookup by number links it", async () => {
    memoryStore({ pushedAt: "2026-10-13T23:50:00.000Z", state: "pushed" });
    buildDraft.mockResolvedValue(drafted(4840));
    const myob = {
      create: jest.fn(),
      find: jest.fn().mockResolvedValue({ ...doc(4840), JournalMemo: "FP 66Sm261014 · proposed Ray", UID }),
      get: jest.fn().mockResolvedValue({ ...doc(4840), RowVersion: "7" }),
      put: jest.fn(),
    } as unknown as MyobPurchases & Record<string, jest.Mock>;
    await expect(approveAndSend(deps(myob), JOHANNE, input("v1"))).resolves.toMatchObject({ outcome: "verified" });
    expect((myob as unknown as Record<string, jest.Mock>).create).not.toHaveBeenCalled();
    expect(row).toMatchObject({ myobUid: UID, state: "verified" });
  });
});

describe("B: the record changed after it was proposed", () => {
  it("is refused at approval: the CFO can only send what was proposed", async () => {
    memoryStore({}); // proposed at $4,840
    buildDraft.mockResolvedValue(drafted(48400, "This creates Order 66Sm261014 for $48,400.00 inc GST"));
    const myob = { create: jest.fn(), find: jest.fn(), get: jest.fn(), put: jest.fn() } as unknown as MyobPurchases & Record<string, jest.Mock>;
    await expect(approveAndSend(deps(myob), JOHANNE, input("v1"))).rejects.toMatchObject({
      message: expect.stringContaining("changed since it was proposed"),
      status: 409,
    });
    expect((myob as unknown as Record<string, jest.Mock>).find).not.toHaveBeenCalled();
    expect((myob as unknown as Record<string, jest.Mock>).create).not.toHaveBeenCalled();
    expect(row).toMatchObject({ payload: doc(4840), state: "proposed" });
  });
});
