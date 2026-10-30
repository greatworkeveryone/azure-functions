/// <reference types="jest" />
// TR6: an upload for a work request stays in Floorplan when pushing is off.
import type { HttpRequest, InvocationContext } from "@azure/functions";

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn(), storageQueue: jest.fn(), timer: jest.fn() } };
});
jest.mock("../db", () => ({
  closeConnection: jest.fn(),
  createRequestConnection: jest.fn().mockResolvedValue({}),
  executeQuery: jest.fn().mockResolvedValue([{ Id: 1 }]),
  inTransaction: jest.fn(),
}));
jest.mock("../auth", () => ({
  ...jest.requireActual("../auth"),
  errorResponse: jest.fn().mockReturnValue({ status: 500, jsonBody: { error: "Error" } }),
  extractToken: jest.fn().mockReturnValue("t"),
  oidFromToken: jest.fn().mockReturnValue("oid"),
  requireRole: jest.fn().mockResolvedValue(null),
  verifiedIdentityFromRequest: jest.fn().mockResolvedValue({ email: "f@rp", name: "Fay", oid: "oid" }),
}));
jest.mock("../blob-storage", () => ({
  deleteBlob: jest.fn(),
  generateReadSasUrl: jest.fn(() => "https://sas"),
  uploadBlob: jest.fn().mockResolvedValue({ blobName: "x/y.png", url: "u" }),
}));
jest.mock("../mybuildings-client", () => ({ uploadAttachment: jest.fn() }));

const mb = require("../mybuildings-client") as { uploadAttachment: jest.Mock };
const { app } = require("@azure/functions") as { app: { http: jest.Mock } };
require("./attachments");
const upload = (app.http.mock.calls.find((c: unknown[]) => c[0] === "uploadAttachment")![1] as { handler: (r: HttpRequest, c: InvocationContext) => Promise<{ status?: number; jsonBody?: any }> }).handler;
const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const req = () => {
  const form = new FormData();
  form.set("file", new File([PNG], "a.png", { type: "image/png" }));
  form.set("workRequestId", "40");
  return { formData: async () => form, headers: { get: () => null }, query: new URLSearchParams() } as unknown as HttpRequest;
};

const OLD = { ...process.env };
afterEach(() => { process.env = { ...OLD }; });

it("keeps the file in Floorplan when push is off", async () => {
  process.env.MYBUILDINGS_PUSH_ENABLED = "false";
  const res = await upload(req(), ctx);
  expect(res.status).toBe(200);
  expect(res.jsonBody.myBuildings).toMatch(/switched off/);
  expect(mb.uploadAttachment).not.toHaveBeenCalled();
});

it("still pushes by default", async () => {
  mb.uploadAttachment.mockClear();
  const res = await upload(req(), ctx);
  expect(res.status).toBe(200);
  expect(mb.uploadAttachment).toHaveBeenCalledTimes(1);
});
