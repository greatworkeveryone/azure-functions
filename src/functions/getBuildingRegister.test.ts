import { HttpRequest, type InvocationContext } from "@azure/functions";
import { AppRole } from "../auth";
import { executeQuery } from "../db";
import { getBuildingRegister } from "./getBuildingRegister";
jest.mock("@azure/functions", () => ({
  ...jest.requireActual("@azure/functions"),
  app: { http: jest.fn() },
}));
let roles: string[] = [AppRole.FACILITIES];
jest.mock("../auth", () => ({
  ...jest.requireActual("../auth"),
  extractToken: () => "token",
  requireRole: async (_r: unknown, allowed: string[]) =>
    jest.requireActual("../auth").rolesPassGate(roles, allowed) ? null : { status: 403 },
}));
jest.mock("../db", () => ({
  createRequestConnection: jest.fn(async () => ({})),
  closeConnection: jest.fn(),
  executeQuery: jest.fn(),
}));
const query = jest.mocked(executeQuery),
  ctx = { error: jest.fn() } as unknown as InvocationContext;
const request = (id = "-7") =>
  new HttpRequest({ url: `http://localhost/api/getBuildingRegister?buildingId=${id}`, method: "GET" });
beforeEach(() => {
  jest.clearAllMocks();
  roles = [AppRole.FACILITIES];
  query.mockResolvedValue([]);
});
it("refuses the baseline user before querying building facts", async () => {
  roles = [AppRole.USER];
  expect((await getBuildingRegister(request(), ctx)).status).toBe(403);
  expect(query).not.toHaveBeenCalled();
});
it("returns no invented lots, contacts or areas for a building without a profile", async () => {
  query.mockImplementation(async (_c, sql) =>
    sql.includes("FROM dbo.Buildings") ? [{ BuildingID: -7 }] : [],
  );
  const result = await getBuildingRegister(request(), ctx);
  expect(result.status).toBe(200);
  expect(result.jsonBody).toEqual(
    expect.objectContaining({
      revision: 0,
      profile: expect.objectContaining({ lots: [], contacts: [], landAreaSqm: null }),
    }),
  );
});
it("returns 404 for a building that does not exist", async () =>
  expect((await getBuildingRegister(request(), ctx)).status).toBe(404));
it.each(["0", "NaN", "2147483648", "1.2"])("rejects invalid IDs before querying (%s)", async (id) => {
  expect((await getBuildingRegister(request(id), ctx)).status).toBe(400);
  expect(query).not.toHaveBeenCalled();
});
