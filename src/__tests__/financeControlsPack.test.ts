jest.mock("@azure/functions", () => ({ app: { http: jest.fn() } }));
jest.mock("../auth", () => ({ extractToken: jest.fn(() => "token"), rolesForRequest: jest.fn(async () => ["cfo"]), userInfoFromToken: jest.fn(() => ({ email: "cfo@review.invalid" })), unauthorizedResponse: () => ({ status: 401 }) }));
jest.mock("../db", () => ({ executeQuery: jest.fn(async () => []), createRequestConnection: jest.fn(async () => ({})), beginTransaction: jest.fn(), commitTransaction: jest.fn(), rollbackTransaction: jest.fn(), closeConnection: jest.fn() }));
import { financeControlsSnapshot } from "../financeControlsPack";
import { signFinanceControlsPack } from "../functions/signFinanceControlsPack";
import { rolesForRequest } from "../auth";
import { executeQuery, commitTransaction, rollbackTransaction } from "../db";
const query = executeQuery as jest.Mock;
const context = { error: jest.fn() } as never;
const request = (body: unknown) => ({ json: async () => body } as never);
beforeEach(() => { jest.clearAllMocks(); (rolesForRequest as jest.Mock).mockResolvedValue(["cfo"]); query.mockResolvedValue([]); });
it("changes the assurance hash when money controls change", async () => {
  query.mockImplementation(async (_c, sql: string) => sql.includes("ApprovalLimits") ? [{ RoleName: "accounts", MaxApprovalAmount: 5000 }] : []);
  const first = await financeControlsSnapshot({} as never);
  query.mockImplementation(async (_c, sql: string) => sql.includes("ApprovalLimits") ? [{ RoleName: "accounts", MaxApprovalAmount: 6000 }] : []);
  expect((await financeControlsSnapshot({} as never)).controlsHash).not.toBe(first.controlsHash);
});
it("refuses a stale pack without storing a sign-off", async () => {
  const res = await signFinanceControlsPack(request({ controlsHash: "old", reviewed: true, note: "Checked" }), context);
  expect(res.status).toBe(409);
  expect(rollbackTransaction).toHaveBeenCalled();
  expect(commitTransaction).not.toHaveBeenCalled();
  expect(query.mock.calls.some(call => String(call[1]).startsWith("INSERT"))).toBe(false);
});
it.each(["admin", "director", "accounts_manager"])("does not let %s sign for the CFO", async role => {
  (rolesForRequest as jest.Mock).mockResolvedValue([role]);
  expect((await signFinanceControlsPack(request({}), context)).status).toBe(403);
  expect(query).not.toHaveBeenCalled();
});
it("records the CFO and exact snapshot without enabling any MYOB control", async () => {
  const { controlsHash } = await financeControlsSnapshot({} as never);
  query.mockClear();
  expect((await signFinanceControlsPack(request({ controlsHash, reviewed: true, note: "Reviewed with limitations" }), context)).status).toBe(200);
  const insert = query.mock.calls.find(call => String(call[1]).startsWith("INSERT"));
  expect(insert?.[1]).toContain("dbo.FinanceControlsSignoffs");
  expect(insert?.[2]).toEqual(expect.arrayContaining([expect.objectContaining({ name: "Signer", value: "cfo@review.invalid" })]));
  expect(query.mock.calls.some(call => /UPDATE|MERGE/.test(String(call[1])))).toBe(false);
  expect(commitTransaction).toHaveBeenCalled();
});
