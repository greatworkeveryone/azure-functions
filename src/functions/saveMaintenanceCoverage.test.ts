import { HttpRequest, type InvocationContext } from "@azure/functions";
import { AppRole } from "../auth";
import { beginTransaction, commitTransaction, executeQuery, rollbackTransaction } from "../db";
import { saveMaintenanceCoverage } from "./saveMaintenanceCoverage";
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
  verifiedIdentityFromRequest: async () => ({ name: "Verified manager", oid: "manager-oid" }),
}));
jest.mock("../db", () => ({
  createRequestConnection: jest.fn(async () => ({})),
  closeConnection: jest.fn(),
  executeQuery: jest.fn(),
  beginTransaction: jest.fn().mockResolvedValue(undefined),
  commitTransaction: jest.fn().mockResolvedValue(undefined),
  rollbackTransaction: jest.fn().mockResolvedValue(undefined),
}));
const query = jest.mocked(executeQuery);
const context = { error: jest.fn() } as unknown as InvocationContext;
const trade = { trade: "Electrical", required: true, contractorIds: [10] };
const request = (patch: Record<string, unknown> = {}) =>
  new HttpRequest({
    method: "POST",
    url: "http://localhost/api/saveMaintenanceCoverage",
    headers: { "Content-Type": "application/json" },
    body: { string: JSON.stringify({ buildingId: -7, revision: 0, trades: [trade], ...patch }) },
  });
beforeEach(() => {
  jest.clearAllMocks();
  roles = [AppRole.FACILITIES_APPROVAL];
  query.mockImplementation(async (_c, sql) =>
    sql.includes("FROM dbo.Buildings")
      ? [{ BuildingID: -7 }]
      : sql.includes("FROM dbo.Contractors")
        ? [{ ContractorID: 10, Active: true, Suspended: false }]
        : [],
  );
});
it("rejects ordinary facilities staff before querying or writing", async () => {
  roles = [AppRole.FACILITIES];
  expect((await saveMaintenanceCoverage(request(), context)).status).toBe(403);
  expect(query).not.toHaveBeenCalled();
});
it("rejects invalid input before starting a transaction", async () => {
  expect((await saveMaintenanceCoverage(request({ revision: -1 }), context)).status).toBe(400);
  expect(beginTransaction).not.toHaveBeenCalled();
});
it("stores the coverage and verified audit identity in one transaction", async () => {
  expect((await saveMaintenanceCoverage(request({ actor: "forged" }), context)).status).toBe(200);
  expect(commitTransaction).toHaveBeenCalledTimes(1);
  const [, sql, params] = query.mock.calls.find(([, sql]) =>
    sql.startsWith("INSERT dbo.MaintenanceCoverageAudit"),
  )!;
  expect(sql).toContain("BeforeJson,AfterJson");
  expect(params).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: "Actor", value: "Verified manager" }),
      expect.objectContaining({ name: "Oid", value: "manager-oid" }),
    ]),
  );
});
it("rejects a stale revision without changing coverage or audit", async () => {
  query.mockImplementation(async (_c, sql) =>
    sql.includes("FROM dbo.Buildings") ? [{ BuildingID: -7 }] : [{ Revision: 2, PlanJson: "[]" }],
  );
  expect((await saveMaintenanceCoverage(request(), context)).status).toBe(409);
  expect(rollbackTransaction).toHaveBeenCalledTimes(1);
  expect(query.mock.calls.some(([, sql]) => /^(UPDATE|INSERT)/.test(sql))).toBe(false);
});
it("rolls back the coverage update when writing its audit fails", async () => {
  query.mockImplementation(async (_c, sql) => {
    if (sql.includes("FROM dbo.Buildings")) return [{ BuildingID: -7 }];
    if (sql.includes("FROM dbo.Contractors")) return [{ ContractorID: 10, Active: true, Suspended: false }];
    if (sql.startsWith("INSERT dbo.MaintenanceCoverageAudit")) throw new Error("audit failed");
    return [];
  });
  expect((await saveMaintenanceCoverage(request(), context)).status).toBe(500);
  expect(rollbackTransaction).toHaveBeenCalledTimes(1);
  expect(commitTransaction).not.toHaveBeenCalled();
});
it.each([
  ["Electrical", 200],
  ["Plumbing", 400],
])("retains a suspended contractor only for the same existing trade (%s)", async (tradeName, status) => {
  query.mockImplementation(async (_c, sql) =>
    sql.includes("FROM dbo.Buildings")
      ? [{ BuildingID: -7 }]
      : sql.includes("FROM dbo.MaintenanceCoverage WITH")
        ? [{ Revision: 1, PlanJson: JSON.stringify([trade]) }]
        : sql.includes("FROM dbo.Contractors")
          ? [{ ContractorID: 10, Active: true, Suspended: true }]
          : [],
  );
  expect(
    (
      await saveMaintenanceCoverage(
        request({ revision: 1, trades: [{ ...trade, trade: tradeName }] }),
        context,
      )
    ).status,
  ).toBe(status);
});
