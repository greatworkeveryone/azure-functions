import { HttpRequest, type InvocationContext } from "@azure/functions";
import { AppRole } from "../auth";
import { commitTransaction, executeQuery, rollbackTransaction } from "../db";
import { record } from "../ledger";
import { createOrUpdateContractors, fetchContractorById } from "../mybuildings-client";
import { parseContractorDetails, updateContractorDetails } from "./updateContractorDetails";

jest.mock("@azure/functions", () => ({ ...jest.requireActual("@azure/functions"), app: { http: jest.fn() } }));
let roles: string[] = [AppRole.FACILITIES_APPROVAL];
jest.mock("../auth", () => ({
  ...jest.requireActual("../auth"),
  extractToken: () => "token",
  requireRole: async (_r: unknown, allowed: string[]) => (jest.requireActual("../auth").rolesPassGate(roles, allowed) ? null : { status: 403 }),
  verifiedIdentityFromRequest: async () => ({ name: "Verified manager", oid: "manager-oid" }),
}));
jest.mock("../db", () => ({
  beginTransaction: jest.fn().mockResolvedValue(undefined),
  closeConnection: jest.fn(),
  commitTransaction: jest.fn().mockResolvedValue(undefined),
  createRequestConnection: jest.fn(async () => ({})),
  executeQuery: jest.fn(),
  rollbackTransaction: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../escalation/approvals/raise", () => ({ concludeApproval: jest.fn(), raiseApproval: jest.fn().mockResolvedValue(null) }));
jest.mock("../ledger", () => ({ record: jest.fn().mockResolvedValue(undefined) }));
jest.mock("../ledger/actor", () => ({ resolveLedgerActor: jest.fn(async () => ({ name: "Verified manager", oid: "manager-oid" })) }));
jest.mock("../mybuildings-client", () => ({ createOrUpdateContractors: jest.fn(), fetchContractorById: jest.fn() }));

const raiseNotice = (jest.requireMock("../escalation/approvals/raise") as { raiseApproval: jest.Mock }).raiseApproval;
const query = jest.mocked(executeQuery);
const push = jest.mocked(createOrUpdateContractors);
const fetchOne = jest.mocked(fetchContractorById);
const context = { error: jest.fn(), log: jest.fn() } as unknown as InvocationContext;
const ROW = { ABN: null, ContactFirstName: "Sam", ContactLastName: null, ContractorID: 7, ContractorName: "Arjays", EmailAddress: "old@arjays.test", MobileNumber: null, PhoneNumber: "0889 000 111", Version: "2026-11-10T01:00:00" };
const BODY = { ContractorName: "Arjays Electrical", EmailAddress: "jobs@arjays.test", PhoneNumber: "0889 000 222", contractorId: 7, version: ROW.Version };
const request = (patch: Record<string, unknown> = {}) =>
  new HttpRequest({ body: { string: JSON.stringify({ ...BODY, ...patch }) }, headers: { "Content-Type": "application/json" }, method: "PUT", url: "http://localhost/api/updateContractorDetails" });
const updates = () => query.mock.calls.filter(([, sql]) => sql.startsWith("UPDATE"));

beforeEach(() => {
  jest.clearAllMocks();
  roles = [AppRole.FACILITIES_APPROVAL];
  delete process.env.MYBUILDINGS_CONTRACTOR_PUSH;
  query.mockImplementation(async (_c, sql) => (sql.includes("WITH (UPDLOCK") ? [ROW] : sql.startsWith("SELECT") ? [{ Version: "2026-11-15T02:00:00" }] : []));
  fetchOne.mockResolvedValue({ ContractorCategory: "Electrical", ContractorComments: "Keeps the after-hours key", ContractorID: 7, ContractorName: "Arjays", Contractor_SpareField1: "kept" });
  push.mockResolvedValue({});
});

it("refuses ordinary facilities staff before touching the database", async () => {
  roles = [AppRole.FACILITIES];
  expect((await updateContractorDetails(request(), context)).status).toBe(403);
  expect(query).not.toHaveBeenCalled();
});

it("checks the details before writing: a name, a whole email, an 11-digit ABN", () => {
  expect(parseContractorDetails({ ...BODY, ContractorName: " " })).toMatchObject({ ok: false });
  expect(parseContractorDetails({ ...BODY, EmailAddress: "jobs@" })).toMatchObject({ ok: false });
  expect(parseContractorDetails({ ...BODY, ABN: "12 345" })).toMatchObject({ ok: false });
  expect(parseContractorDetails({ ...BODY, ABN: "51 824 753 556" })).toMatchObject({ details: { ABN: "51824753556" }, ok: true });
});

it("saves in Floorplan and in myBuildings together, sending myBuildings its own record with only the edits changed", async () => {
  const response = await updateContractorDetails(request(), context);
  expect(response.status).toBe(200);
  expect(response.jsonBody).toEqual({ myBuildingsUpdated: true, version: "2026-11-15T02:00:00" });
  expect(updates()).toHaveLength(1);
  expect(push).toHaveBeenCalledWith([expect.objectContaining({ ContractorComments: "Keeps the after-hours key", ContractorID: 7, ContractorName: "Arjays Electrical", Contractor_SpareField1: "kept", EmailAddress: "jobs@arjays.test" })]);
  expect(record).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "contractor.update", after: expect.objectContaining({ EmailAddress: "jobs@arjays.test" }), before: expect.objectContaining({ EmailAddress: "old@arjays.test" }) }));
  expect(commitTransaction).toHaveBeenCalledTimes(1);
});

it("writes nothing when someone else changed the contractor first", async () => {
  const response = await updateContractorDetails(request({ version: "2026-11-01T00:00:00" }), context);
  expect(response.status).toBe(409);
  expect(updates()).toHaveLength(0);
  expect(push).not.toHaveBeenCalled();
  expect(commitTransaction).not.toHaveBeenCalled();
});

it("keeps Floorplan unchanged when myBuildings refuses, so the next sync cannot undo a half-saved edit", async () => {
  push.mockRejectedValue(new Error("myBuildings API error 500"));
  const response = await updateContractorDetails(request(), context);
  expect(response.status).toBe(502);
  expect(rollbackTransaction).toHaveBeenCalledTimes(1);
  expect(commitTransaction).not.toHaveBeenCalled();
});

it("saves in Floorplan alone once the myBuildings push is switched off", async () => {
  process.env.MYBUILDINGS_CONTRACTOR_PUSH = "false";
  const response = await updateContractorDetails(request(), context);
  expect(response.status).toBe(200);
  expect(response.jsonBody).toMatchObject({ myBuildingsUpdated: false });
  expect(fetchOne).not.toHaveBeenCalled();
  expect(push).not.toHaveBeenCalled();
  expect(commitTransaction).toHaveBeenCalledTimes(1);
});

it("an email change starts the hold on purchase orders to that contractor, and is ledgered (SECA-04)", async () => {
  await updateContractorDetails(request(), context);
  const sql = updates()[0]?.[1] as string;
  expect(sql).toMatch(/ContactChangedAt=SYSUTCDATETIME\(\)/);
  expect(sql).toMatch(/ContactConfirmedAt=NULL, ContactConfirmedBy=NULL/);
  expect(record).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ after: expect.objectContaining({ contactHeldForSecondPerson: true }) }));
});

it("a change that leaves the email and ABN alone does not start it", async () => {
  await updateContractorDetails(request({ EmailAddress: "old@arjays.test" }), context);
  expect(updates()[0]?.[1] as string).not.toMatch(/ContactChangedAt/);
});

it("tells accounts managers when the email changes, after the commit, and not when only the phone changes (SECA-04)", async () => {
  expect((await updateContractorDetails(request(), context)).status).toBe(200);
  expect(raiseNotice).toHaveBeenCalledTimes(1);
  expect(raiseNotice).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ policyKey: "contractor.contact_changed", subjectId: "7", subjectType: "contractor" }));
  expect(jest.mocked(commitTransaction).mock.invocationCallOrder[0]).toBeLessThan(raiseNotice.mock.invocationCallOrder[0]);
  raiseNotice.mockClear();
  expect((await updateContractorDetails(request({ EmailAddress: ROW.EmailAddress, PhoneNumber: "0889 111 111" }), context)).status).toBe(200);
  expect(raiseNotice).not.toHaveBeenCalled();
});
