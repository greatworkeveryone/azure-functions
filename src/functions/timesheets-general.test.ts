/// <reference types="jest" />
import { app, HttpRequest, type InvocationContext } from "@azure/functions";
import { executeQuery } from "../db";
import { loadPeople } from "../peopleWorkflow";

// Plain staff (role user) keep hours in the "general" group, approved by their reporting manager,
// or by an accounts manager when none is on record. A save names the revision it loaded.

jest.mock("@azure/functions", () => ({ ...jest.requireActual("@azure/functions"), app: { http: jest.fn() } }));
jest.mock("../db", () => ({ closeConnection: jest.fn(), createRequestConnection: jest.fn(async () => ({})), executeQuery: jest.fn() }));
jest.mock("../rateLimit", () => ({ checkRateLimit: () => ({ allowed: true }) }));
jest.mock("../peopleWorkflow", () => ({ loadPeople: jest.fn() }));

const mockRoles: { current: string[] } = { current: ["user"] };
const mockIdentity: { current: { name: string; oid: string } | null } = { current: { name: "Una User", oid: "una-oid" } };
jest.mock("../auth", () => ({
  ...jest.requireActual("../auth"),
  extractToken: () => "token",
  requireRole: async () => null,
  rolesForRequest: async () => mockRoles.current,
  verifiedIdentityFromRequest: async () => mockIdentity.current,
}));

require("./timesheets");
const handlers = new Map(jest.mocked(app.http).mock.calls.map((call) => [call[0], call[1].handler!]));
const post = (name: string, body: unknown) =>
  handlers.get(name)!(
    new HttpRequest({ method: "POST", url: "http://localhost/api/x", headers: { "Content-Type": "application/json" }, body: { string: JSON.stringify(body) } }),
    { error: jest.fn(), log: jest.fn() } as unknown as InvocationContext,
  );
const get = (name: string, qs: string) =>
  handlers.get(name)!(new HttpRequest({ method: "GET", url: `http://localhost/api/x?${qs}` }), { error: jest.fn(), log: jest.fn() } as unknown as InvocationContext);
const query = jest.mocked(executeQuery);
const sqls = (): string[] => query.mock.calls.map(([, sql]) => sql);

const DATA = { monday: [{ type: "work", startTime: "08:00", endTime: "16:00", breakMinutes: 30, comment: "" }] };
const staff = [
  { id: 1, name: "Una User", oid: "una-oid", role: "user" },
  { id: 2, name: "Dee Director", oid: "dee-oid", role: "director" },
  { id: 3, name: "Ann Accounts", oid: "ann-oid", role: "accounts_manager" },
];

beforeEach(() => {
  jest.resetAllMocks();
  mockRoles.current = ["user"];
  mockIdentity.current = { name: "Una User", oid: "una-oid" };
  jest.mocked(loadPeople).mockResolvedValue({ links: [], revision: 1, staff, updatedAt: "", updatedBy: "" } as never);
});

describe("plain staff timesheets", () => {
  it("saves a first week as the general group instead of refusing", async () => {
    query.mockResolvedValueOnce([]).mockResolvedValueOnce([{ TimesheetID: 1 }]).mockResolvedValueOnce([{ TimesheetID: 1 }]);
    const res = await post("upsertTimesheet", { weekStart: "2026-11-16", data: DATA, revision: null });
    expect(res!.status).toBe(200);
    const insert = query.mock.calls.find(([, sql]) => sql.includes("INSERT INTO dbo.Timesheets"))!;
    expect(insert[2]?.find((p) => p.name === "Role")?.value).toBe("general");
  });

  it("keeps them in general even when the body names another group", async () => {
    query.mockResolvedValueOnce([]).mockResolvedValueOnce([{ TimesheetID: 1 }]).mockResolvedValueOnce([{ TimesheetID: 1 }]);
    await post("upsertTimesheet", { weekStart: "2026-11-16", data: DATA, revision: null, role: "facilities" });
    const insert = query.mock.calls.find(([, sql]) => sql.includes("INSERT INTO dbo.Timesheets"))!;
    expect(insert[2]?.find((p) => p.name === "Role")?.value).toBe("general");
  });

  it("tells them their named manager approves", async () => {
    jest.mocked(loadPeople).mockResolvedValue({ links: [{ managerId: 2, userId: 1 }], revision: 1, staff } as never);
    query.mockResolvedValueOnce([]);
    const res = await get("getTimesheet", "weekStart=2026-11-16");
    expect(((res as { jsonBody: unknown }).jsonBody as { approver: unknown }).approver).toEqual({ kind: "manager", name: "Dee Director" });
  });

  it("tells them an accounts manager approves when no manager is on record", async () => {
    query.mockResolvedValueOnce([]);
    const res = await get("getTimesheet", "weekStart=2026-11-16");
    expect(((res as { jsonBody: unknown }).jsonBody as { approver: unknown }).approver).toEqual({ kind: "accounts" });
  });
});

describe("approving a general sheet", () => {
  const sheet = { UserID: "una-oid", Role: "general", SentToMyobDate: null, Data: JSON.stringify(DATA) };

  it("an accounts manager approves when the person has no manager on record", async () => {
    mockRoles.current = ["accounts_manager"];
    mockIdentity.current = { name: "Ann Accounts", oid: "ann-oid" };
    query.mockResolvedValueOnce([sheet]).mockResolvedValueOnce([]).mockResolvedValueOnce([{ TimesheetID: 3 }]);
    expect((await post("approveTimesheet", { timesheetId: 3, approve: true }))!.status).toBe(200);
  });

  it("an accounts manager may not approve once the person has a named manager", async () => {
    jest.mocked(loadPeople).mockResolvedValue({ links: [{ managerId: 2, userId: 1 }], revision: 1, staff } as never);
    mockRoles.current = ["accounts_manager"];
    mockIdentity.current = { name: "Ann Accounts", oid: "ann-oid" };
    query.mockResolvedValueOnce([sheet]);
    const res = await post("approveTimesheet", { timesheetId: 3, approve: true });
    expect(res!.status).toBe(403);
    expect(sqls().some((sql) => /UPDATE/.test(sql))).toBe(false);
  });

  it("a facilities manager never approves general sheets", async () => {
    mockRoles.current = ["facilities_manager"];
    mockIdentity.current = { name: "Fay", oid: "fay-oid" };
    query.mockResolvedValueOnce([sheet]);
    expect((await post("approveTimesheet", { timesheetId: 3, approve: true }))!.status).toBe(403);
  });

  it("a director approves without a lookup", async () => {
    mockRoles.current = ["director"];
    mockIdentity.current = { name: "Dee Director", oid: "dee-oid" };
    query.mockResolvedValueOnce([sheet]).mockResolvedValueOnce([]).mockResolvedValueOnce([{ TimesheetID: 3 }]);
    expect((await post("approveTimesheet", { timesheetId: 3, approve: true }))!.status).toBe(200);
    expect(loadPeople).not.toHaveBeenCalled();
  });
});

describe("a stale timesheet save", () => {
  const existing = { TimesheetID: 7, Role: "general", ReadyForApproval: false, Approved: false, Revision: 3 };
  const save = (revision: unknown) => post("upsertTimesheet", { weekStart: "2026-11-16", data: DATA, revision });

  it("answers 409 with the current sheet when the revision is behind, writing nothing", async () => {
    query.mockResolvedValueOnce([existing]).mockResolvedValueOnce([{ TimesheetID: 7, Revision: 3 }]);
    const res = await save(2);
    expect(res!.status).toBe(409);
    expect(((res as { jsonBody: unknown }).jsonBody as { code: string }).code).toBe("stale_timesheet");
    expect(sqls().some((sql) => /UPDATE/.test(sql))).toBe(false);
  });

  it("answers 409 when the client loaded no sheet but one now exists", async () => {
    query.mockResolvedValueOnce([existing]).mockResolvedValueOnce([{ TimesheetID: 7, Revision: 3 }]);
    expect((await save(null))!.status).toBe(409);
    expect(sqls().some((sql) => /UPDATE/.test(sql))).toBe(false);
  });

  it("saves at the current revision and adds one", async () => {
    query.mockResolvedValueOnce([existing]).mockResolvedValueOnce([{ TimesheetID: 7 }]).mockResolvedValueOnce([{ TimesheetID: 7, Revision: 4 }]);
    const res = await save(3);
    expect(res!.status).toBe(200);
    const update = query.mock.calls.find(([, sql]) => sql.includes("UPDATE dbo.Timesheets"))!;
    expect(update[1]).toMatch(/Revision = Revision \+ 1/);
    expect(update[1]).toMatch(/Revision = @Revision/);
    expect(update[2]?.find((p) => p.name === "Revision")?.value).toBe(3);
  });

  it("answers 409 when another save lands between the check and the write", async () => {
    query.mockResolvedValueOnce([existing]).mockResolvedValueOnce([]).mockResolvedValueOnce([{ TimesheetID: 7, Revision: 4 }]);
    expect((await save(3))!.status).toBe(409);
  });
});
