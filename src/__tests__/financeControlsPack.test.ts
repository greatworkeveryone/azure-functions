jest.mock("@azure/functions", () => ({ app: { http: jest.fn() } }));
jest.mock("../auth", () => ({ extractToken: jest.fn(() => "token"), rolesForRequest: jest.fn(async () => ["cfo"]), userInfoFromToken: jest.fn(() => ({ email: "cfo@review.invalid" })), unauthorizedResponse: () => ({ status: 401 }) }));
jest.mock("../db", () => ({ executeQuery: jest.fn(async () => []), createRequestConnection: jest.fn(async () => ({})), beginTransaction: jest.fn(), commitTransaction: jest.fn(), rollbackTransaction: jest.fn(), closeConnection: jest.fn() }));
import { loadDirectorThreshold } from "../approvalAuthority-db";
import { effectiveDirectorThreshold, financeControlsSnapshot } from "../financeControlsPack";
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

describe("the director threshold in the pack", () => {
  const FACT = (value: unknown) => [{ FactKey: "director_approval_threshold", FactValue: value }];
  const saved = process.env.DIRECTOR_APPROVAL_THRESHOLD;
  const withEnv = (value: string | undefined) => {
    if (value === undefined) delete process.env.DIRECTOR_APPROVAL_THRESHOLD;
    else process.env.DIRECTOR_APPROVAL_THRESHOLD = value;
  };
  beforeEach(() => jest.spyOn(console, "warn").mockImplementation(() => undefined));
  afterEach(() => {
    withEnv(saved);
    jest.restoreAllMocks();
  });

  const CASES: [string, unknown[], string | undefined, number | null, string][] = [
    ["a stored figure wins over the env setting", FACT(7500), "5000", 7500, "stored"],
    ["a stored figure arriving as text is read as a number", FACT("7500"), undefined, 7500, "stored"],
    ["with no stored figure, a valid env setting applies", [], "5000", 5000, "env"],
    ["with no stored figure, a bad env setting is ignored", [], "lots", null, "none"],
    ["with neither, there is no figure", [], undefined, null, "none"],
    ["a stored figure that is not a number is ignored, and so is the env setting, as at the gate", FACT("abc"), "5000", null, "stored_invalid"],
    ["a stored zero is ignored", FACT(0), "5000", null, "stored_invalid"],
    ["a stored row with no value is ignored", FACT(null), "5000", null, "stored_invalid"],
  ];

  it.each(CASES)("%s", async (_name, facts, env, value, source) => {
    expect(effectiveDirectorThreshold(facts as never, env)).toEqual({ source, value });

    // And it is the figure /getApprovalLimits and the approval gate use.
    withEnv(env);
    query.mockImplementation(async (_c, sql: string) => (sql.includes("ApprovalFacts") ? facts : []));
    expect(await loadDirectorThreshold({} as never)).toBe(value);
  });

  it("puts the effective figure and its source in the pack, never the raw fact or env string", async () => {
    withEnv("5000");
    query.mockImplementation(async (_c, sql: string) => (sql.includes("ApprovalFacts") ? FACT("abc") : []));
    const { snapshot } = await financeControlsSnapshot({} as never);
    expect(snapshot.directorThreshold).toBeNull();
    expect(snapshot.directorThresholdSource).toBe("stored_invalid");

    query.mockImplementation(async () => []);
    const fromEnv = await financeControlsSnapshot({} as never);
    expect(fromEnv.snapshot.directorThreshold).toBe(5000);
    expect(fromEnv.snapshot.directorThresholdSource).toBe("env");
  });
});
