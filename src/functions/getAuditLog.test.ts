import { HttpRequest, type InvocationContext } from "@azure/functions";
import { AppRole } from "../auth";
import { executeQuery } from "../db";
import { AUDIT_UNION_SQL, fullAuditAccess, OPERATIONAL_AUDIT_ACTIONS } from "../auditLog";
import { getAuditLog } from "./getAuditLog";
jest.mock("@azure/functions", () => ({
  ...jest.requireActual("@azure/functions"),
  app: { http: jest.fn() },
}));
let roles: string[] = [AppRole.FACILITIES_APPROVAL];
jest.mock("../auth", () => ({
  ...jest.requireActual("../auth"),
  extractToken: () => "token",
  requireRole: async (_r: unknown, allowed: string[]) =>
    jest.requireActual("../auth").rolesPassGate(roles, allowed) ? null : { status: 403 },
  rolesForRequest: async () => roles,
}));
jest.mock("../test-data", () => ({
  showTestParam: async () => ({ name: "ShowTest", type: require("tedious").TYPES.Bit, value: false }),
}));
jest.mock("../db", () => ({
  createRequestConnection: jest.fn(async () => ({})),
  closeConnection: jest.fn(),
  executeQuery: jest.fn(),
}));
const query = jest.mocked(executeQuery),
  context = { error: jest.fn() } as unknown as InvocationContext;
const req = (query = "") =>
  new HttpRequest({ method: "GET", url: `http://localhost/api/getAuditLog${query}` });
beforeEach(() => {
  jest.clearAllMocks();
  roles = [AppRole.FACILITIES_APPROVAL];
  query.mockImplementation(async (_c, sql) =>
    sql.includes("COUNT_BIG")
      ? [{ Total: 1 }]
      : [
          {
            AuditKey: "building:1",
            OccurredAt: new Date("2026-10-21T00:00:00Z"),
            ActorName: "Manager",
            Action: "building.details_changed",
            Area: "facilities",
            SubjectType: "building",
            SubjectId: "33532",
            BuildingId: 33532,
            JobId: null,
            Before: "secret financial payload",
            ActorOid: "private",
          },
        ],
  );
});
it.each([AppRole.USER, AppRole.FACILITIES, AppRole.ACCOUNTS, AppRole.ACCOUNTS_APPROVAL])(
  "rejects %s before querying",
  async (role) => {
    roles = [role];
    expect((await getAuditLog(req(), context)).status).toBe(403);
    expect(query).not.toHaveBeenCalled();
  },
);
it("binds Facilities scope on both records and count regardless of requested scope", async () => {
  const response = await getAuditLog(req("?scope=all&area=finance"), context);
  expect(response.status).toBe(200);
  expect((response.jsonBody as any).scope).toBe("facilities");
  for (const call of query.mock.calls)
    expect(call[2]).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "Full", value: false })]),
    );
});
it.each([AppRole.CFO, AppRole.DIRECTOR, AppRole.ADMIN])(
  "allows the full audit scope for %s",
  async (role) => {
    roles = [role];
    expect((await getAuditLog(req(), context)).status).toBe(200);
    expect(query.mock.calls[0][2]).toContainEqual(expect.objectContaining({ name: "Full", value: true }));
  },
);
it("never returns raw snapshots, OIDs or free-text ledger reasons", async () => {
  const body = (await getAuditLog(req(), context)).jsonBody;
  expect(JSON.stringify(body)).not.toMatch(/secret financial payload|ActorOid|private/);
  expect((body as any).items[0]).toEqual(expect.objectContaining({ action: "building.details_changed" }));
});
it.each([
  "?page=0",
  "?buildingId=1%20OR%201=1",
  "?from=2026-02-30",
  "?from=2026-12-02&to=2026-12-01",
  "?format=csv",
  "?area=payroll",
])("rejects malformed or unsupported filters %s", async (queryString) => {
  expect((await getAuditLog(req(queryString), context)).status).toBe(400);
  expect(query).not.toHaveBeenCalled();
});
it("binds wildcard search literally and uses stable pagination for the same scoped feed", async () => {
  expect((await getAuditLog(req("?search=service_schedule&page=2"), context)).status).toBe(200);
  expect(query.mock.calls[0][2]).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: "Search", value: "%service\\_schedule%" }),
      expect.objectContaining({ name: "Offset", value: 50 }),
    ]),
  );
  expect(query.mock.calls[1][1]).toContain(AUDIT_UNION_SQL);
});
it("keeps unknown ledger actions, money and tenancy records out of the positive Facilities list", () => {
  expect(OPERATIONAL_AUDIT_ACTIONS).not.toContain("invoice.approve");
  expect(OPERATIONAL_AUDIT_ACTIONS).not.toContain("schedule.manual_edit");
  expect(AUDIT_UNION_SQL).toContain("l.FinancialImpact IS NULL");
  expect(AUDIT_UNION_SQL).toContain("l.TenantId IS NULL");
  expect(AUDIT_UNION_SQL).toContain("WHERE @Full=1 OR e.Domain='operational'");
  expect(fullAuditAccess(["accounts_manager"])).toBe(false);
});
