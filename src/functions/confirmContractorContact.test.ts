/// <reference types="jest" />
import { HttpRequest, InvocationContext } from "@azure/functions";

jest.mock("@azure/functions", () => ({ ...jest.requireActual("@azure/functions"), app: { http: jest.fn() } }));
jest.mock("../assetRegisterSupport", () => {
  const actual = jest.requireActual("../assetRegisterSupport");
  return { ...actual, authorizeWrite: jest.fn(), inTransaction: jest.fn(async (_c: unknown, fn: () => Promise<unknown>) => fn()) };
});
jest.mock("../db", () => ({ closeConnection: jest.fn(), createRequestConnection: jest.fn().mockResolvedValue({}), executeQuery: jest.fn() }));
jest.mock("../escalation/approvals/raise", () => ({ concludeApproval: jest.fn().mockResolvedValue(1), raiseApproval: jest.fn() }));
jest.mock("../ledger", () => ({ record: jest.fn().mockResolvedValue(undefined) }));
jest.mock("../ledger/actor", () => ({ resolveLedgerActor: jest.fn().mockResolvedValue({ kind: "user", name: "Casey", role: "accounts_manager", userId: 3 }) }));

jest.mock("../auth", () => ({ ...jest.requireActual("../auth"), rolesForRequest: jest.fn().mockResolvedValue(["accounts_manager"]) }));
const support = require("../assetRegisterSupport") as { authorizeWrite: jest.Mock };
const db = require("../db") as { executeQuery: jest.Mock };
const raise = require("../escalation/approvals/raise") as { concludeApproval: jest.Mock };
const ledger = require("../ledger") as { record: jest.Mock };
const { confirmContractorContact } = require("./confirmContractorContact") as { confirmContractorContact: (r: HttpRequest, c: InvocationContext) => Promise<{ jsonBody?: any; status?: number }> };

const req = (body: unknown) => ({ json: jest.fn().mockResolvedValue(body) }) as unknown as HttpRequest;
const ctx = { error: jest.fn() } as unknown as InvocationContext;
const changed = (over: Record<string, unknown> = {}) => ({ ContactChangedAt: new Date(), ContactChangedBy: "Sam Lee", ContactChangedByOid: "oid-sam", ContactConfirmedAt: null, ContractorName: "Acme", ...over });

beforeEach(() => {
  jest.clearAllMocks();
  support.authorizeWrite.mockResolvedValue({ caller: { name: "Casey", oid: "oid-casey" }, ok: true, token: "t" });
});

describe("confirmContractorContact (SECA-04)", () => {
  it("lets a second person confirm, and ledgers it", async () => {
    db.executeQuery.mockResolvedValueOnce([changed()]).mockResolvedValue([]);
    const res = await confirmContractorContact(req({ contractorId: 8 }), ctx);
    expect(res.status).toBe(200);
    expect(ledger.record).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "contractor.contact_confirm" }));
    expect(db.executeQuery.mock.calls.some((c: unknown[]) => /ContactConfirmedAt = SYSUTCDATETIME/.test(String(c[1])))).toBe(true);
  });

  it("ends the notice to accounts managers when a second person confirms, and not when it refuses", async () => {
    db.executeQuery.mockResolvedValueOnce([changed()]).mockResolvedValue([]);
    await confirmContractorContact(req({ contractorId: 8 }), ctx);
    expect(raise.concludeApproval).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ policyKeys: ["contractor.contact_changed"], subjectId: "8", subjectType: "contractor" }));
    raise.concludeApproval.mockClear();
    support.authorizeWrite.mockResolvedValue({ caller: { name: "Sam Lee", oid: "oid-sam" }, ok: true, token: "t" });
    db.executeQuery.mockResolvedValueOnce([changed()]);
    await confirmContractorContact(req({ contractorId: 8 }), ctx);
    expect(raise.concludeApproval).not.toHaveBeenCalled();
  });

  it("refuses admin, who passes the gate by hierarchy", async () => {
    (require("../auth") as { rolesForRequest: jest.Mock }).rolesForRequest.mockResolvedValueOnce(["admin"]);
    expect((await confirmContractorContact(req({ contractorId: 8 }), ctx)).status).toBe(403);
    expect(db.executeQuery).not.toHaveBeenCalled();
  });

  it("refuses the person who made the change", async () => {
    support.authorizeWrite.mockResolvedValue({ caller: { name: "Sam Lee", oid: "oid-sam" }, ok: true, token: "t" });
    db.executeQuery.mockResolvedValueOnce([changed()]);
    const res = await confirmContractorContact(req({ contractorId: 8 }), ctx);
    expect(res.status).toBe(403);
    expect(ledger.record).not.toHaveBeenCalled();
  });

  it("is a 409 when there is nothing to confirm or it is already confirmed", async () => {
    db.executeQuery.mockResolvedValueOnce([changed({ ContactChangedAt: null })]);
    expect((await confirmContractorContact(req({ contractorId: 8 }), ctx)).status).toBe(409);
    db.executeQuery.mockResolvedValueOnce([changed({ ContactConfirmedAt: new Date() })]);
    expect((await confirmContractorContact(req({ contractorId: 8 }), ctx)).status).toBe(409);
  });
});
