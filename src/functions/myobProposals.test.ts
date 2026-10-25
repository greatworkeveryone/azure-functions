/// <reference types="jest" />

// The MYOB proposal endpoints: who may preview, propose, approve and send,
// withdraw and read; what they need from the preview; how refusals answer.

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn(), storageQueue: jest.fn(), timer: jest.fn() } };
});
jest.mock("../moneyGate", () => ({ requireMoneyContext: jest.fn().mockResolvedValue(null) }));
jest.mock("../db", () => ({
  beginTransaction: jest.fn().mockResolvedValue(undefined),
  closeConnection: jest.fn(),
  commitTransaction: jest.fn().mockResolvedValue(undefined),
  createRequestConnection: jest.fn().mockResolvedValue({}),
  rollbackTransaction: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../auth", () => ({
  ...jest.requireActual("../auth"),
  extractToken: jest.fn().mockReturnValue("token"),
  rolesForRequest: jest.fn().mockResolvedValue(["cfo"]),
  verifiedIdentityFromRequest: jest.fn().mockResolvedValue({ email: "j@rp", name: "Johanne", oid: "cfo-oid" }),
}));
jest.mock("../ledger/actor", () => ({ resolveLedgerActor: jest.fn().mockResolvedValue({ kind: "user", name: "Johanne", role: "cfo", userId: 12 }) }));
jest.mock("../myob/draft", () => ({ buildDraft: jest.fn() }));
jest.mock("../myob/propose", () => ({ propose: jest.fn() }));
jest.mock("../myob/send", () => ({ approveAndSend: jest.fn() }));
jest.mock("../myob/withdraw", () => ({ withdrawProposal: jest.fn() }));
jest.mock("../myob/proposalsStore", () => ({ getProposal: jest.fn(), openProposals: jest.fn(), proposalsForSubject: jest.fn() }));

import type { HttpRequest, InvocationContext } from "@azure/functions";
import { ProposalError } from "../myob/proposalErrors";
import { approveAndSendToMyob } from "./approveAndSendToMyob";
import { getMyobProposals } from "./getMyobProposals";
import { previewMyobProposal } from "./previewMyobProposal";
import { proposeToMyob } from "./proposeToMyob";
import { withdrawMyobProposal } from "./withdrawMyobProposal";

const auth = require("../auth") as Record<string, jest.Mock>;
const db = require("../db") as Record<string, jest.Mock>;
const { buildDraft } = require("../myob/draft") as { buildDraft: jest.Mock };
const { propose } = require("../myob/propose") as { propose: jest.Mock };
const { approveAndSend } = require("../myob/send") as { approveAndSend: jest.Mock };
const { withdrawProposal } = require("../myob/withdraw") as { withdrawProposal: jest.Mock };
const store = require("../myob/proposalsStore") as Record<string, jest.Mock>;

const HASH = "a".repeat(64);
const ctx = { error: jest.fn(), log: jest.fn() } as unknown as InvocationContext;
const post = (body: unknown) => ({ json: async () => body, query: new URLSearchParams() }) as unknown as HttpRequest;
const get = (query: string) => ({ json: async () => null, query: new URLSearchParams(query) }) as unknown as HttpRequest;
const as = (...roles: string[]) => auth.rolesForRequest.mockResolvedValue(roles);

const SUBJECT = { operation: "orders.create", subjectId: 9, subjectType: "purchase_order" };
const DRAFT = { draft: { companyFileId: "cf", mapping: { companyFile: { mode: "write", name: "Demo" } }, payloadHash: HASH, rendered: { sentence: "This creates…" } }, ok: true };

beforeEach(() => {
  jest.clearAllMocks();
  as("cfo");
  buildDraft.mockResolvedValue(DRAFT);
  propose.mockResolvedValue({ proposalId: 5 });
  approveAndSend.mockResolvedValue({ message: "Sent to MYOB and read back: it matches.", outcome: "verified", proposal: { proposalId: 5 } });
  withdrawProposal.mockResolvedValue({ proposalId: 5, state: "withdrawn" });
  store.getProposal.mockResolvedValue({ jobId: 12, operation: "orders.create", proposalId: 5, proposedAt: "2026-10-14T00:00:00Z", proposedBy: "Ray", subjectId: 9, subjectType: "purchase_order" });
  store.proposalsForSubject.mockResolvedValue([]);
  store.openProposals.mockResolvedValue([]);
});

describe("previewMyobProposal", () => {
  it("shows a proposer the record, its hash and the preview time, calling nothing in MYOB", async () => {
    as("accounts_manager");
    const res = await previewMyobProposal(post(SUBJECT), ctx);
    expect(res.status).toBe(200);
    expect(res.jsonBody).toMatchObject({ companyFile: { name: "Demo" }, payloadHash: HASH, rendered: { sentence: "This creates…" } });
  });

  it("answers a refusal with its plain reasons", async () => {
    as("accounts_manager");
    buildDraft.mockResolvedValue({ ok: false, reasons: ["Ask Johanne to add ACME Air to the supplier export"], status: 409 });
    const res = await previewMyobProposal(post(SUBJECT), ctx);
    expect(res).toMatchObject({ jsonBody: { reasons: ["Ask Johanne to add ACME Air to the supplier export"] }, status: 409 });
  });

  it("lets only the CFO preview a send, and nobody but the listed roles preview a proposal", async () => {
    as("accounts_manager");
    expect((await previewMyobProposal(post({ proposalId: 5 }), ctx)).status).toBe(403);
    as("admin");
    expect((await previewMyobProposal(post(SUBJECT), ctx)).status).toBe(403);
    as("facilities");
    expect((await previewMyobProposal(post(SUBJECT), ctx)).status).toBe(403);
  });

  it("previews a send with the CFO as approver", async () => {
    await previewMyobProposal(post({ proposalId: 5 }), ctx);
    expect(buildDraft).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ approver: expect.objectContaining({ name: "Johanne" }), proposalId: 5 }));
  });

  it("401s an unverified caller", async () => {
    auth.verifiedIdentityFromRequest.mockResolvedValueOnce(null);
    expect((await previewMyobProposal(post(SUBJECT), ctx)).status).toBe(401);
  });
});

describe("proposeToMyob", () => {
  it("records the proposal in a transaction for a proposer", async () => {
    as("facilities_manager");
    const res = await proposeToMyob(post({ ...SUBJECT, payloadHash: HASH, previewedAt: "2026-10-14T00:00:00Z" }), ctx);
    expect(res.status).toBe(200);
    expect(propose).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ name: "Johanne" }), expect.objectContaining({ payloadHash: HASH, subjectId: 9 }), expect.any(String), expect.any(Date));
    expect(db.commitTransaction).toHaveBeenCalled();
  });

  it("400s without the preview, 403s admin, and maps a refusal to its status, rolling back", async () => {
    as("accounts_manager");
    expect((await proposeToMyob(post(SUBJECT), ctx)).status).toBe(400);
    as("admin");
    expect((await proposeToMyob(post({ ...SUBJECT, payloadHash: HASH, previewedAt: "2026-10-14T00:00:00Z" }), ctx)).status).toBe(403);
    as("accounts_manager");
    propose.mockRejectedValue(new ProposalError(409, "The record changed since you previewed it. Preview again."));
    const res = await proposeToMyob(post({ ...SUBJECT, payloadHash: HASH, previewedAt: "2026-10-14T00:00:00Z" }), ctx);
    expect(res).toMatchObject({ jsonBody: { error: "The record changed since you previewed it. Preview again." }, status: 409 });
    expect(db.rollbackTransaction).toHaveBeenCalled();
  });
});

describe("approveAndSendToMyob", () => {
  const body = { expectedRowVersion: "v1", payloadHash: HASH, previewedAt: "2026-10-14T00:00:00Z", proposalId: 5 };

  it("sends for the CFO and answers with what MYOB returned", async () => {
    const res = await approveAndSendToMyob(post(body), ctx);
    expect(res).toMatchObject({ jsonBody: { outcome: "verified" }, status: 200 });
    expect(approveAndSend).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ oid: "cfo-oid" }), expect.objectContaining({ expectedRowVersion: "v1", proposalId: 5 }));
  });

  it.each(["admin", "director", "accounts_manager"])("403s %s: only the CFO approves and sends", async (role) => {
    as(role);
    expect((await approveAndSendToMyob(post(body), ctx)).status).toBe(403);
    expect(approveAndSend).not.toHaveBeenCalled();
  });

  it("400s without the preview hash or version", async () => {
    expect((await approveAndSendToMyob(post({ proposalId: 5 }), ctx)).status).toBe(400);
  });
});

describe("withdrawMyobProposal and getMyobProposals", () => {
  it("withdraws with a reason, and 400s without one", async () => {
    as("accounts_manager");
    expect((await withdrawMyobProposal(post({ expectedRowVersion: "v1", proposalId: 5, reason: "Wrong PO" }), ctx)).status).toBe(200);
    expect((await withdrawMyobProposal(post({ expectedRowVersion: "v1", proposalId: 5 }), ctx)).status).toBe(400);
  });

  it("lists a record's proposals or the open queue, with the caller's powers", async () => {
    as("accounts_manager");
    const res = await getMyobProposals(get("subjectType=purchase_order&subjectId=9"), ctx);
    expect(res).toMatchObject({ jsonBody: { canPropose: true, canSend: false, proposals: [] }, status: 200 });
    as("cfo");
    expect((await getMyobProposals(get("queue=open"), ctx)).jsonBody).toMatchObject({ canSend: true });
    expect((await getMyobProposals(get(""), ctx)).status).toBe(400);
    as("facilities");
    expect((await getMyobProposals(get("queue=open"), ctx)).status).toBe(403);
  });
});
