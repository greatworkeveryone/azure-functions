/// <reference types="jest" />
import { HttpRequest, InvocationContext } from "@azure/functions";

jest.mock("@azure/functions", () => ({ ...jest.requireActual("@azure/functions"), app: { http: jest.fn() } }));
jest.mock("../assetRegisterSupport", () => {
  const actual = jest.requireActual("../assetRegisterSupport");
  return { ...actual, authorizeWrite: jest.fn(), inTransaction: jest.fn(async (_c: unknown, fn: () => Promise<unknown>) => fn()) };
});
jest.mock("../db", () => ({ closeConnection: jest.fn(), createRequestConnection: jest.fn().mockResolvedValue({}), executeQuery: jest.fn() }));
jest.mock("../ledger", () => ({ record: jest.fn().mockResolvedValue(undefined) }));
jest.mock("../ledger/actor", () => ({ resolveLedgerActor: jest.fn().mockResolvedValue({ kind: "user", name: "Connor", role: "admin", userId: 1 }) }));
jest.mock("../escalation/policies", () => ({ ...jest.requireActual("../escalation/policies"), invalidatePolicyCache: jest.fn() }));

import { ACTION_ROLES } from "../action-roles";
const support = require("../assetRegisterSupport") as { authorizeWrite: jest.Mock };
const db = require("../db") as { executeQuery: jest.Mock };
const ledger = require("../ledger") as { record: jest.Mock };
const cache = require("../escalation/policies") as { invalidatePolicyCache: jest.Mock };
const { getEscalationPolicies, setEscalationPolicy } = require("./escalationPolicies") as Record<string, (r: HttpRequest, c: InvocationContext) => Promise<{ jsonBody?: any; status?: number }>>;

const req = (body: unknown) => ({ json: jest.fn().mockResolvedValue(body) }) as unknown as HttpRequest;
const ctx = { error: jest.fn() } as unknown as InvocationContext;
const ROW = { Active: false, AutoReescalate: "yes", Clock: "business", Kind: "authority", Ladder: '[{"userTarget":true,"slaHours":16},{"role":"cfo","slaHours":16},{"role":"director"}]', PolicyKey: "leave.decision", UpdatedAt: null, UpdatedBy: null, Urgent: false };

beforeEach(() => {
  jest.clearAllMocks();
  support.authorizeWrite.mockResolvedValue({ caller: { name: "Connor", oid: "oid-c" }, ok: true, token: "t" });
});

it("is admin only, exactly", () => {
  expect(ACTION_ROLES.manageEscalationPolicies.gate).toEqual(["admin"]);
  expect(ACTION_ROLES.manageEscalationPolicies.match).toBe("exact");
  expect(ACTION_ROLES.manageEscalationPolicies.routes).toEqual(["getEscalationPolicies", "setEscalationPolicy"]);
});

describe("getEscalationPolicies", () => {
  it("lists each policy with its words, who is told in order, and whether it is on", async () => {
    db.executeQuery.mockResolvedValueOnce([ROW]);
    const res = await getEscalationPolicies(req(null), ctx);
    expect(res.jsonBody.policies[0]).toMatchObject({ active: false, description: expect.stringMatching(/Leave was asked for/), policyKey: "leave.decision", tellsInOrder: "The person named (16 business hours), then CFO (16 business hours), then Director" });
  });

  it("says plainly when a policy has no description, and when its row is unreadable", async () => {
    db.executeQuery.mockResolvedValueOnce([{ ...ROW, Ladder: "nope", PolicyKey: "x.new" }]);
    const p = (await getEscalationPolicies(req(null), ctx)).jsonBody.policies[0];
    expect(p.description).toMatch(/No description yet/);
    expect(p.tellsInOrder).toBe("");
  });

  it("is refused to anyone the gate refuses", async () => {
    support.authorizeWrite.mockResolvedValue({ ok: false, response: { status: 403 } });
    expect((await getEscalationPolicies(req(null), ctx)).status).toBe(403);
    expect(db.executeQuery).not.toHaveBeenCalled();
  });
});

describe("setEscalationPolicy", () => {
  const body = { active: true, policyKey: "leave.decision", wasActive: false };

  it("switches it, ledgers who and when, and drops the cache", async () => {
    db.executeQuery.mockResolvedValueOnce([ROW]).mockResolvedValue([]);
    const res = await setEscalationPolicy(req(body), ctx);
    expect(res.status).toBe(200);
    expect(res.jsonBody.policy).toMatchObject({ active: true, updatedBy: "Connor" });
    const update = db.executeQuery.mock.calls.find((c: unknown[]) => /UPDATE dbo\.EscalationPolicies/.test(String(c[1])));
    expect(update).toBeDefined();
    expect(ledger.record).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "escalation.policy_switch", after: { active: true }, before: { active: false }, subject: { id: "leave.decision", type: "escalation_policy" } }));
    expect(cache.invalidatePolicyCache).toHaveBeenCalled();
  });

  it("is a 409 when the screen was stale, and writes nothing", async () => {
    db.executeQuery.mockResolvedValueOnce([{ ...ROW, Active: true }]);
    expect((await setEscalationPolicy(req(body), ctx)).status).toBe(409);
    expect(ledger.record).not.toHaveBeenCalled();
  });

  it("is a 404 for a policy that does not exist and a 400 for a malformed request", async () => {
    db.executeQuery.mockResolvedValueOnce([]);
    expect((await setEscalationPolicy(req(body), ctx)).status).toBe(404);
    expect((await setEscalationPolicy(req({ ...body, policyKey: "x'; DROP" }), ctx)).status).toBe(400);
    expect((await setEscalationPolicy(req({ ...body, active: "yes" }), ctx)).status).toBe(400);
    expect((await setEscalationPolicy(req({ active: true, policyKey: "leave.decision" }), ctx)).status).toBe(400);
  });

  it("does nothing when it is already in the state asked for", async () => {
    db.executeQuery.mockResolvedValueOnce([ROW]);
    const res = await setEscalationPolicy(req({ ...body, active: false }), ctx);
    expect(res.status).toBe(200);
    expect(ledger.record).not.toHaveBeenCalled();
  });
});
