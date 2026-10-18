jest.mock("@azure/functions", () => ({ app: { http: jest.fn() } }));
jest.mock("../auth", () => ({ extractToken: jest.fn(() => "token"), rolesForRequest: jest.fn(async () => ["cfo"]), userInfoFromToken: jest.fn(() => ({ email: "cfo@review.invalid" })), unauthorizedResponse: () => ({ status: 401 }) }));
jest.mock("../db", () => ({ executeQuery: jest.fn(), createRequestConnection: jest.fn(async () => ({})), beginTransaction: jest.fn(), commitTransaction: jest.fn(), rollbackTransaction: jest.fn(async () => undefined), closeConnection: jest.fn() }));
import { setProcedureEndorsement } from "../functions/setProcedureEndorsement";
import { rolesForRequest } from "../auth";
import { executeQuery, commitTransaction, rollbackTransaction } from "../db";
const query = executeQuery as jest.Mock;
const context = { error: jest.fn() } as never;
const body = { slug: "inspections", authority: "executive", expectedAuthority: "team", expectedVersion: 2 };
const request = (value: unknown) => ({ json: async () => value } as never);
beforeEach(() => {
  jest.clearAllMocks();
  (rolesForRequest as jest.Mock).mockResolvedValue(["cfo"]);
  query.mockResolvedValue([{ Slug: "inspections" }]);
});
it.each(["admin", "accounts_manager", "facilities_manager", "accounts"])("refuses %s before opening the database", async role => {
  (rolesForRequest as jest.Mock).mockResolvedValue([role]);
  expect((await setProcedureEndorsement(request(body), context)).status).toBe(403);
  expect(query).not.toHaveBeenCalled();
});
it("rejects a stale version even when the previous authority matches again", async () => {
  query.mockResolvedValue([]);
  expect((await setProcedureEndorsement(request(body), context)).status).toBe(409);
  expect(query.mock.calls[0][1]).toContain("EndorsementVersion = @ExpectedVersion");
  expect(rollbackTransaction).toHaveBeenCalled();
  expect(commitTransaction).not.toHaveBeenCalled();
  expect(query.mock.calls).toHaveLength(1);
});
it("increments the version and audits the actual actor in the same transaction", async () => {
  expect((await setProcedureEndorsement(request(body), context)).status).toBe(200);
  expect(query.mock.calls[0][1]).toContain("EndorsementVersion = EndorsementVersion + 1");
  expect(query.mock.calls[0][2]).toEqual(expect.arrayContaining([expect.objectContaining({ name: "ExpectedVersion", value: 2 })]));
  expect(query.mock.calls[1][1]).toContain("ProcedureEndorsementAudit");
  expect(query.mock.calls[1][2]).toEqual(expect.arrayContaining([expect.objectContaining({ name: "Actor", value: "cfo@review.invalid" })]));
  expect(commitTransaction).toHaveBeenCalledTimes(1);
});
it("rolls back the policy change if the audit cannot be written", async () => {
  query.mockResolvedValueOnce([{ Slug: "inspections" }]).mockRejectedValueOnce(new Error("audit unavailable"));
  expect((await setProcedureEndorsement(request(body), context)).status).toBe(500);
  expect(rollbackTransaction).toHaveBeenCalled();
  expect(commitTransaction).not.toHaveBeenCalled();
});
it("requires a non-negative integer version", async () => {
  expect((await setProcedureEndorsement(request({ ...body, expectedVersion: -1 }), context)).status).toBe(400);
  expect(query).not.toHaveBeenCalled();
});
