/// <reference types="jest" />
import { app, HttpRequest, type InvocationContext } from "@azure/functions";
import { executeQuery } from "../db";

// Who may write, submit and approve whose timesheet: the subject of a write by
// someone else must be a real AppUsers row, managers stay inside their role
// groups on write/submit/recall as on read/approve, and self-approval is
// judged on the verified oid.

jest.mock("@azure/functions", () => ({ ...jest.requireActual("@azure/functions"), app: { http: jest.fn() } }));
jest.mock("../db", () => ({ closeConnection: jest.fn(), createRequestConnection: jest.fn(async () => ({})), executeQuery: jest.fn() }));
jest.mock("../rateLimit", () => ({ checkRateLimit: () => ({ allowed: true }) }));

const mockRoles: { current: string[] } = { current: ["facilities_manager"] };
const mockIdentity: { current: { name: string; oid: string } | null } = { current: { name: "Fay Manager", oid: "fay-oid" } };
jest.mock("../auth", () => ({
  ...jest.requireActual("../auth"),
  extractToken: () => "token",
  // The unsigned token's oid must never be what approveTimesheet trusts.
  oidFromToken: () => "forged-oid",
  nameFromToken: () => "Forged Name",
  requireRole: async () => null,
  rolesForRequest: async () => mockRoles.current,
  verifiedIdentityFromRequest: async () => mockIdentity.current,
}));

require("./timesheets");
const handlers = new Map(jest.mocked(app.http).mock.calls.map((call) => [call[0], call[1].handler!]));
const run = (name: string, body: unknown) =>
  handlers.get(name)!(
    new HttpRequest({ method: "POST", url: "http://localhost/api/x", headers: { "Content-Type": "application/json" }, body: { string: JSON.stringify(body) } }),
    { error: jest.fn(), log: jest.fn() } as unknown as InvocationContext,
  );
const query = jest.mocked(executeQuery);
const sqls = (): string[] => query.mock.calls.map(([, sql]) => sql);

const DATA = { monday: [{ type: "work", startTime: "08:00", endTime: "16:00", breakMinutes: 30, comment: "" }] };
const WRITE = { weekStart: "2026-10-12", data: DATA };

beforeEach(() => {
  jest.resetAllMocks();
  mockRoles.current = ["facilities_manager"];
  mockIdentity.current = { name: "Fay Manager", oid: "fay-oid" };
});

describe("upsertTimesheet for another user", () => {
  it("refuses a fabricated userId that is not an active AppUsers row, writing nothing", async () => {
    query.mockResolvedValueOnce([]);

    const res = await run("upsertTimesheet", { ...WRITE, userId: "fay-oidx", userDisplayName: "Fay Manager" });

    expect(res!.status).toBe(404);
    expect(sqls().some((sql) => /INSERT|UPDATE/.test(sql))).toBe(false);
  });

  it("looks the subject up by EntraOid among active users, and stores the name and role from that row", async () => {
    query
      .mockResolvedValueOnce([{ DisplayName: "Real Name", Role: "facilities" }]) // subject
      .mockResolvedValueOnce([]) // no existing sheet
      .mockResolvedValueOnce([{ TimesheetID: 5 }])
      .mockResolvedValueOnce([{ TimesheetID: 5 }]);

    const res = await run("upsertTimesheet", { ...WRITE, userId: "emp-oid", userDisplayName: "Spoofed", role: "accounts" });

    expect(res!.status).toBe(200);
    expect(sqls()[0]).toMatch(/FROM dbo\.AppUsers WHERE EntraOid = @Oid AND IsActive = 1/);
    const insert = query.mock.calls.find(([, sql]) => sql.includes("INSERT INTO dbo.Timesheets"))!;
    const param = (name: string) => insert[2]?.find((p) => p.name === name)?.value;
    expect(param("UserID")).toBe("emp-oid");
    expect(param("UserDisplayName")).toBe("Real Name");
    expect(param("Role")).toBe("facilities");
  });

  it("refuses a facilities manager writing for an accounts user, writing nothing", async () => {
    query.mockResolvedValueOnce([{ DisplayName: "Ann Accounts", Role: "accounts" }]);

    const res = await run("upsertTimesheet", { ...WRITE, userId: "ann-oid" });

    expect(res!.status).toBe(403);
    expect(sqls().some((sql) => /INSERT|UPDATE/.test(sql))).toBe(false);
  });

  it("refuses editing an existing sheet whose stored role is outside the manager's groups", async () => {
    query
      .mockResolvedValueOnce([{ DisplayName: "Pat", Role: "facilities" }])
      .mockResolvedValueOnce([{ TimesheetID: 9, Role: "accounts", ReadyForApproval: false, Approved: false }]);

    const res = await run("upsertTimesheet", { ...WRITE, userId: "pat-oid" });

    expect(res!.status).toBe(403);
    expect(sqls().some((sql) => /UPDATE/.test(sql))).toBe(false);
  });

  it("lets a director write for either group", async () => {
    mockRoles.current = ["director"];
    query
      .mockResolvedValueOnce([{ DisplayName: "Ann Accounts", Role: "accounts_manager" }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ TimesheetID: 6 }])
      .mockResolvedValueOnce([{ TimesheetID: 6 }]);

    expect((await run("upsertTimesheet", { ...WRITE, userId: "ann-oid" }))!.status).toBe(200);
  });

  it("does not look anyone up when writing the caller's own sheet", async () => {
    query.mockResolvedValueOnce([]).mockResolvedValueOnce([{ TimesheetID: 1 }]).mockResolvedValueOnce([{ TimesheetID: 1 }]);

    expect((await run("upsertTimesheet", WRITE))!.status).toBe(200);
    expect(sqls().some((sql) => sql.includes("dbo.AppUsers"))).toBe(false);
  });
});

describe("submitTimesheetForApproval for another user", () => {
  const sheet = (role: string) => ({ UserID: "emp-oid", Role: role, Approved: false, ReadyForApproval: false, Data: JSON.stringify(DATA) });

  it("refuses a sheet outside the manager's role groups", async () => {
    query.mockResolvedValueOnce([sheet("accounts")]);

    const res = await run("submitTimesheetForApproval", { timesheetId: 3, submit: true });

    expect(res!.status).toBe(403);
    expect(sqls().some((sql) => /UPDATE/.test(sql))).toBe(false);
  });

  it("refuses recalling a sheet outside the manager's role groups", async () => {
    query.mockResolvedValueOnce([sheet("accounts")]);
    expect((await run("submitTimesheetForApproval", { timesheetId: 3, submit: false }))!.status).toBe(403);
  });

  it("allows a sheet inside them", async () => {
    query.mockResolvedValueOnce([sheet("facilities")]).mockResolvedValueOnce([]).mockResolvedValueOnce([{ TimesheetID: 3 }]);
    expect((await run("submitTimesheetForApproval", { timesheetId: 3, submit: true }))!.status).toBe(200);
  });
});

describe("approveTimesheet", () => {
  it("compares against the verified oid, not the token's unsigned one", async () => {
    // The sheet belongs to the verified caller; the unsigned token claims someone else.
    query.mockResolvedValueOnce([{ UserID: "fay-oid", Role: "facilities", SentToMyobDate: null, Data: JSON.stringify(DATA) }]);

    const res = await run("approveTimesheet", { timesheetId: 3, approve: true });

    expect(res!.status).toBe(403);
    expect(sqls().some((sql) => /UPDATE/.test(sql))).toBe(false);
  });

  it("stamps the verified oid and name as approver", async () => {
    query
      .mockResolvedValueOnce([{ UserID: "emp-oid", Role: "facilities", SentToMyobDate: null, Data: JSON.stringify(DATA) }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ TimesheetID: 3 }]);

    const res = await run("approveTimesheet", { timesheetId: 3, approve: true });

    expect(res!.status).toBe(200);
    const update = query.mock.calls.find(([, sql]) => sql.includes("UPDATE dbo.Timesheets"))!;
    const param = (name: string) => update[2]?.find((p) => p.name === name)?.value;
    expect(param("ApprovedBy")).toBe("fay-oid");
    expect(param("ApprovedByName")).toBe("Fay Manager");
  });

  it("answers 401 when the identity cannot be verified", async () => {
    mockIdentity.current = null;
    expect((await run("approveTimesheet", { timesheetId: 3, approve: true }))!.status).toBe(401);
  });
});
