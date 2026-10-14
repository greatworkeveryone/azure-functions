/// <reference types="jest" />

jest.mock("../ledger", () => ({ record: jest.fn().mockResolvedValue(undefined) }));
jest.mock("./proposalsStore", () => ({ getProposal: jest.fn(), updateProposal: jest.fn() }));

import { withdrawProposal } from "./withdraw";
import type { ProposalRow } from "./proposalsStore";

const { record } = require("../ledger") as { record: jest.Mock };
const store = require("./proposalsStore") as Record<string, jest.Mock>;

const NOW = new Date("2026-10-14T00:10:00Z");
const RAY = { ledger: { kind: "user" as const, name: "Ray", role: "accounts_manager", userId: 3 }, name: "Ray", oid: "ray-oid" };
const ANA = { ledger: { kind: "user" as const, name: "Ana", role: "accounts_manager", userId: 4 }, name: "Ana", oid: "ana-oid" };
const proposal = (over: Partial<ProposalRow> = {}) =>
  ({ correlationId: "c", jobId: 12, proposalId: 5, proposedBy: "Ray", proposedByOid: "ray-oid", rowVersion: "v1", state: "proposed", ...over }) as ProposalRow;
const withdraw = (person = RAY, isController = false, over: Record<string, unknown> = {}) =>
  withdrawProposal({} as never, person, isController, { expectedRowVersion: "v1", proposalId: 5, reason: "Wrong supplier", ...over }, NOW);

beforeEach(() => {
  jest.clearAllMocks();
  store.getProposal.mockResolvedValue(proposal());
  store.updateProposal.mockImplementation(async () => proposal({ state: "withdrawn" }));
});

describe("withdrawProposal", () => {
  it("lets the proposer withdraw with a reason, keeping the row, and ledgers it", async () => {
    await expect(withdraw()).resolves.toMatchObject({ state: "withdrawn" });
    expect(store.updateProposal.mock.calls[0][3]).toMatchObject({ State: "withdrawn", WithdrawnBy: "Ray", WithdrawReason: "Wrong supplier" });
    expect(record).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "myob.withdraw", reason: "Wrong supplier" }));
  });

  it("lets the CFO withdraw anyone's, and refuses someone else", async () => {
    await expect(withdraw(ANA, true)).resolves.toBeTruthy();
    await expect(withdraw(ANA, false)).rejects.toMatchObject({ status: 403 });
  });

  it.each(["approved", "verified", "withdrawn"])("refuses a proposal that is %s", async (state) => {
    store.getProposal.mockResolvedValue(proposal({ state: state as ProposalRow["state"] }));
    await expect(withdraw()).rejects.toMatchObject({ status: 409 });
    expect(store.updateProposal).not.toHaveBeenCalled();
  });

  it("409s on a stale version", async () => {
    await expect(withdraw(RAY, false, { expectedRowVersion: "old" })).rejects.toMatchObject({ status: 409 });
  });
});
