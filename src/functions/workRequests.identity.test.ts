/// <reference types="jest" />
import { HttpRequest, InvocationContext } from "@azure/functions";

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn(), storageQueue: jest.fn(), timer: jest.fn() } };
});
jest.mock("../db", () => ({
  closeConnection: jest.fn(),
  createRequestConnection: jest.fn().mockResolvedValue({}),
  executeQuery: jest.fn().mockResolvedValue([]),
}));
jest.mock("../auth", () => ({
  ...jest.requireActual("../auth"),
  errorResponse: jest.fn().mockReturnValue({ status: 500, jsonBody: { error: "Error" } }),
  extractToken: jest.fn().mockReturnValue("mock-token"),
  requireRole: jest.fn().mockResolvedValue(null),
  unauthorizedResponse: jest.fn().mockReturnValue({ status: 401, jsonBody: { error: "Unauthorized" } }),
  verifiedIdentityFromRequest: jest.fn().mockResolvedValue({ email: "m@rp", name: "Mia Manager", oid: "mia-oid" }),
}));
jest.mock("../mybuildings-client", () => ({}));

type Handler = (req: HttpRequest, ctx: InvocationContext) => Promise<{ status?: number; jsonBody?: unknown }>;
const db = require("../db") as { executeQuery: jest.Mock };
const auth = require("../auth") as { verifiedIdentityFromRequest: jest.Mock };
const { app } = require("@azure/functions") as { app: { http: jest.Mock } };
require("./workRequests");
const hit = app.http.mock.calls.find((c: unknown[]) => c[0] === "updateWorkRequestLocal");
const updateWorkRequestLocal = (hit![1] as { handler: Handler }).handler;

const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;
const post = (body: unknown) =>
  ({ headers: { get: () => null }, json: jest.fn().mockResolvedValue(body), query: new URLSearchParams() }) as unknown as HttpRequest;

beforeEach(() => jest.clearAllMocks());

describe("updateWorkRequestLocal (SEC-23)", () => {
  it("stamps UpdatedBy from the verified token and ignores the body", async () => {
    db.executeQuery.mockResolvedValueOnce([]).mockResolvedValueOnce([{ WorkRequestID: 4 }]);
    const res = await updateWorkRequestLocal(post({ WorkRequestID: 4, Priority: "High", UpdatedBy: "Mallory" }), ctx);

    expect(res.status).toBe(200);
    const params = db.executeQuery.mock.calls[0][2] as { name: string; value: unknown }[];
    expect(params.find((p) => p.name === "UpdatedBy")?.value).toBe("Mia Manager");
  });

  it("returns 401 when the token cannot be verified", async () => {
    auth.verifiedIdentityFromRequest.mockResolvedValueOnce(null);

    const res = await updateWorkRequestLocal(post({ WorkRequestID: 4, Priority: "High" }), ctx);

    expect(res.status).toBe(401);
    expect(db.executeQuery).not.toHaveBeenCalled();
  });
});
