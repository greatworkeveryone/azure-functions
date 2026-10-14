/// <reference types="jest" />

// The MYOB half of "Approve and send", against a fake MYOB.

import { MyobRequestRefusedError, MyobTimeoutError } from "../myob-api-log";
import { MyobPurchaseError } from "../myob-purchase-order";
import { canonicalJson } from "./hash";
import { pushApproved, type MyobPurchases } from "./sendSteps";
import type { ProposalRow } from "./proposalsStore";

const CF = "0f9e8d7c-6b5a-4f3e-9d2c-1b0a99887766";
const UID = "44444444-2222-4333-8444-555555555555";
const ACTOR = { kind: "user" as const, name: "Johanne", oid: "cfo" };
const PAYLOAD = {
  Date: "2026-10-14T00:00:00",
  JournalMemo: "FP 66Sm261014 · proposed Ray 14/10 09:00 · approved Johanne 14/10 09:10",
  Lines: [{ Account: { UID: "a" }, Description: "x", TaxCode: { UID: "t" }, Total: 4840, Type: "Transaction" }],
  Number: "66Sm261014",
  Supplier: { UID: "s" },
};

const proposal = (over: Partial<ProposalRow> = {}) =>
  ({ companyFileId: CF, correlationId: "c", operation: "orders.create", payload: PAYLOAD, targetUid: null, ...over }) as ProposalRow;

function fakeMyob(over: Partial<Record<keyof MyobPurchases, jest.Mock>> = {}) {
  const myob = {
    create: jest.fn().mockResolvedValue(UID),
    find: jest.fn().mockResolvedValue(null),
    get: jest.fn().mockResolvedValue({ ...PAYLOAD, RowVersion: "7", UID }),
    put: jest.fn().mockResolvedValue(undefined),
    ...over,
  };
  return myob as unknown as MyobPurchases & Record<keyof MyobPurchases, jest.Mock>;
}

const push = (myob: MyobPurchases, over: Partial<ProposalRow> = {}, lastSeen: { myobRowVersion: string | null; readBack: Record<string, unknown> | null } | null = null) =>
  pushApproved(myob, { actor: ACTOR, lastSeen, proposal: proposal(over) });

describe("create", () => {
  it("posts the exact approved bytes, reads the record back and finds it matches", async () => {
    const myob = fakeMyob();
    const result = await push(myob);
    expect(myob.create).toHaveBeenCalledWith("Order", CF, canonicalJson(PAYLOAD), ACTOR, "c");
    expect(result).toMatchObject({ kind: "verified", linked: false, uid: UID });
  });

  it("links instead of duplicating when an earlier try already created it (Floorplan's attribution)", async () => {
    const myob = fakeMyob({ find: jest.fn().mockResolvedValue({ ...PAYLOAD, UID: UID.toUpperCase() }) });
    const result = await push(myob);
    expect(myob.create).not.toHaveBeenCalled();
    expect(result).toMatchObject({ kind: "verified", linked: true, uid: UID });
  });

  it("never adopts a record with that number that a person made in MYOB", async () => {
    const myob = fakeMyob({ find: jest.fn().mockResolvedValue({ JournalMemo: "keyed by hand", Number: "66Sm261014", UID }) });
    const result = await push(myob);
    expect(myob.create).not.toHaveBeenCalled();
    expect(result).toMatchObject({ kind: "not_ours" });
  });

  it("reports a field-level difference when MYOB holds a different amount", async () => {
    const myob = fakeMyob({ get: jest.fn().mockResolvedValue({ ...PAYLOAD, Lines: [{ ...PAYLOAD.Lines[0], Total: 4900 }], UID }) });
    expect(await push(myob)).toMatchObject({ diff: [{ field: "total", myob: 4900, sent: 4840 }], kind: "differs" });
  });

  it("turns a timeout mid-push into a failure that claims nothing was sent", async () => {
    const myob = fakeMyob({ create: jest.fn().mockRejectedValue(new MyobTimeoutError()) });
    const result = await push(myob);
    expect(result).toMatchObject({ kind: "failed", message: expect.stringContaining("hasn't marked it as sent") });
  });

  it("keeps MYOB's own words when it says no", async () => {
    const myob = fakeMyob({ create: jest.fn().mockRejectedValue(new MyobPurchaseError(400, "MYOB refused to create the order (HTTP 400): Supplier is inactive")) });
    expect(await push(myob)).toMatchObject({ kind: "failed", message: expect.stringContaining("Supplier is inactive") });
  });

  it.each([
    ["dry_run", new MyobRequestRefusedError("dry_run", "Dry run (CFO control)")],
    ["refused", new MyobRequestRefusedError("controls", "orders.create is switched off")],
  ])("reports a %s refusal from inside Floorplan", async (kind, error) => {
    const myob = fakeMyob({ find: jest.fn().mockRejectedValue(error) });
    expect(await push(myob)).toMatchObject({ kind });
  });
});

describe("update", () => {
  const update = { operation: "orders.update" as const, targetUid: UID };

  it("refuses, sending nothing, when MYOB's RowVersion moved since Floorplan last saw it", async () => {
    const myob = fakeMyob({ get: jest.fn().mockResolvedValue({ ...PAYLOAD, Lines: [{ ...PAYLOAD.Lines[0], Total: 5000 }], RowVersion: "9", UID }) });
    const result = await push(myob, update, { myobRowVersion: "7", readBack: PAYLOAD });
    expect(myob.put).not.toHaveBeenCalled();
    expect(result).toMatchObject({ diff: [{ field: "total", myob: 5000, sent: 4840 }], kind: "changed_in_myob" });
  });

  it("refuses when Floorplan has no version to compare with", async () => {
    const myob = fakeMyob();
    expect(await push(myob, update, null)).toMatchObject({ kind: "changed_in_myob" });
    expect(myob.put).not.toHaveBeenCalled();
  });

  it("puts the approved document with the record's identity and current version, then reads it back", async () => {
    const myob = fakeMyob();
    const result = await push(myob, update, { myobRowVersion: "7", readBack: PAYLOAD });
    expect(myob.put).toHaveBeenCalledWith("Order", CF, UID, canonicalJson({ ...PAYLOAD, RowVersion: "7", UID }), ACTOR, "c");
    expect(result).toMatchObject({ kind: "verified", uid: UID });
  });
});
