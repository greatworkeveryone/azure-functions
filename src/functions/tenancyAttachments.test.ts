/// <reference types="jest" />
import { HttpRequest, InvocationContext } from "@azure/functions";

// A tenant's document list shows every row: one stored name that was never
// minted (a legacy upload) gets no link instead of failing the whole list.

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn(), storageQueue: jest.fn(), timer: jest.fn() } };
});
jest.mock("../db", () => ({
  closeConnection: jest.fn(),
  createRequestConnection: jest.fn().mockResolvedValue({}),
  executeQuery: jest.fn(),
}));
jest.mock("../auth", () => ({
  ...jest.requireActual("../auth"),
  errorResponse: jest.fn().mockReturnValue({ status: 500, jsonBody: { error: "Error" } }),
  extractToken: jest.fn().mockReturnValue("mock-token"),
  requireRole: jest.fn().mockResolvedValue(null),
  unauthorizedResponse: jest.fn().mockReturnValue({ status: 401, jsonBody: { error: "Unauthorized" } }),
}));
jest.mock("../blob-storage", () => ({
  generateReadSasUrl: jest.fn((name: string) => `https://sas/${name}`),
  uploadBlob: jest.fn(),
}));

type Handler = (req: HttpRequest, ctx: InvocationContext) => Promise<{ status?: number; jsonBody?: any }>;
const db = require("../db") as { executeQuery: jest.Mock };
const auth = require("../auth") as { extractToken: jest.Mock };
const blob = require("../blob-storage") as { generateReadSasUrl: jest.Mock };
const { app } = require("@azure/functions") as { app: { http: jest.Mock } };
require("./tenancyAttachments");
const hit = app.http.mock.calls.find((c: unknown[]) => c[0] === "getTenancyAttachments");
const getTenancyAttachments = (hit![1] as { handler: Handler }).handler;

const UUID = "3f2c9a10-5b7e-4d21-9c8a-0e1f2a3b4c5d";
const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;
const get = (tenantId: string) =>
  ({ headers: { get: () => null }, query: new URLSearchParams({ tenantId }) }) as unknown as HttpRequest;

beforeEach(() => jest.clearAllMocks());

describe("getTenancyAttachments", () => {
  it("signs minted names and leaves a legacy name unsigned rather than failing the list", async () => {
    db.executeQuery.mockResolvedValueOnce([
      { Id: 1, BlobName: `tenancy-4/${UUID}.pdf`, MyBuildingsConfirmedAt: null },
      { Id: 2, BlobName: `tenancy-4/${UUID}.lease agreement`, MyBuildingsConfirmedAt: null },
      { Id: 3, BlobName: "../key-photos/keys/a.jpg", MyBuildingsConfirmedAt: null },
    ]);

    const res = await getTenancyAttachments(get("4"), ctx);

    expect(res.status).toBe(200);
    expect(res.jsonBody.attachments.map((a: { sasUrl: string | null }) => a.sasUrl)).toEqual([
      `https://sas/tenancy-4/${UUID}.pdf`,
      null,
      null,
    ]);
    expect(blob.generateReadSasUrl).toHaveBeenCalledTimes(1);
  });

  it("returns 401 without a token and 400 without a tenant", async () => {
    auth.extractToken.mockReturnValueOnce(null);
    expect((await getTenancyAttachments(get("4"), ctx)).status).toBe(401);
    expect((await getTenancyAttachments(get(""), ctx)).status).toBe(400);
  });
});
