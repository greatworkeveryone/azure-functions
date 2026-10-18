/// <reference types="jest" />

// The m4c reviewer's scenario (18 Oct), kept in the suite, now asserting the
// fix: after the CFO accepted MYOB's record as the baseline, "Update in MYOB"
// would build its PUT from Floorplan's own payload and overwrite what she
// accepted. Until a PUT built on the accepted record is proven, the update is
// refused in plain words.

jest.mock("./subjects", () => ({ loadSubject: jest.fn() }));
jest.mock("./mappings", () => ({ resolveMapping: jest.fn() }));
jest.mock("./proposalsStore", () => ({ latestVerifiedForUid: jest.fn(), proposalsForSubject: jest.fn() }));
jest.mock("./activity/acceptedBaseline", () => ({ baselineAccepted: jest.fn() }));

import { buildDraft } from "./draft";

const { loadSubject } = require("./subjects") as { loadSubject: jest.Mock };
const { resolveMapping } = require("./mappings") as { resolveMapping: jest.Mock };
const store = require("./proposalsStore") as Record<string, jest.Mock>;
const { baselineAccepted } = require("./activity/acceptedBaseline") as { baselineAccepted: jest.Mock };
const CF = "0f9e8d7c-6b5a-4f3e-9d2c-1b0a99887766";
const UID = "44444444-2222-4333-8444-555555555555";
const FACTS = { amount: 4840, buildingId: 3, chargeCode: "m", contractorId: 7, contractorName: "ACME Air", description: "66Sm261014 · Floorplan job #12",
  jobId: 12, notReady: null, reference: "66Sm261014", subjectId: 9, subjectType: "purchase_order" };
const MAPPING = { account: { label: "6-1100 Repairs", uid: "acct" }, companyFile: { id: CF, mode: "write", name: "Demo Pty Ltd" },
  supplier: { name: "ACME Air Pty Ltd", uid: "sup" }, taxCode: { code: "GST", uid: "gst" } };
const SENT = { Comment: "FP 66Sm261014 · proposed Ray", Date: "2026-10-14T00:00:00", IsTaxInclusive: true, JournalMemo: "FP 66Sm261014 · proposed Ray",
  Lines: [{ Account: { UID: "acct" }, Description: "66Sm261014 · Floorplan job #12", TaxCode: { UID: "gst" }, Total: 4840, Type: "Transaction" }], Number: "66Sm261014", Supplier: { UID: "sup" } };
const ACCEPTED = { ...SENT, JournalMemo: "Johanne: hold until the roof report", Lines: [{ ...SENT.Lines[0], Description: "Roof - hold for report" }], PromisedDate: "2026-10-30T00:00:00", RowVersion: "9", Status: "Open" };
const created = { companyFileId: CF, correlationId: "c-1", myobNumber: "66Sm261014", myobUid: UID, operation: "orders.create", payload: SENT, proposalId: 3, readBack: { ...SENT, RowVersion: "7" }, state: "verified" };
const update = () => buildDraft({} as never, { operation: "orders.update", proposer: { at: new Date("2026-10-15T00:00:00Z"), name: "Ray" }, subjectId: 9, subjectType: "purchase_order" });

beforeEach(() => {
  jest.clearAllMocks();
  loadSubject.mockResolvedValue(FACTS);
  resolveMapping.mockResolvedValue({ ok: true, value: MAPPING });
  store.proposalsForSubject.mockResolvedValue([created]);
  store.latestVerifiedForUid.mockResolvedValue({ ...created, myobRowVersion: "9", readBack: ACCEPTED });
});

it("refuses Update in MYOB on a record whose MYOB version the CFO accepted, so nothing she accepted is overwritten", async () => {
  baselineAccepted.mockResolvedValue(true);
  const result = await update();
  expect(result).toMatchObject({ ok: false, reasons: [expect.stringContaining("accepted MYOB's record")], status: 409 });
  expect(baselineAccepted).toHaveBeenCalledWith(expect.anything(), "c-1");
});

it("still builds the update when no baseline was accepted", async () => {
  baselineAccepted.mockResolvedValue(false);
  expect((await update()).ok).toBe(true);
});

// The re-review's note (18 Oct): a fresh "Propose to MYOB" for the same record would mint a new
// correlation id that baselineAccepted doesn't know, and its create would bypass the acceptance.
it("refuses a fresh create for a record Floorplan already created in MYOB, so the acceptance can't be bypassed", async () => {
  baselineAccepted.mockResolvedValue(true);
  const result = await buildDraft({} as never, { operation: "orders.create", proposer: { at: new Date("2026-10-15T00:00:00Z"), name: "Ray" }, subjectId: 9, subjectType: "purchase_order" });
  expect(result).toMatchObject({ ok: false, reasons: [expect.stringContaining("already created this Order in MYOB")], status: 409 });
});
