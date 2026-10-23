/// <reference types="jest" />
import { HttpRequest, InvocationContext } from "@azure/functions";

// Upload type allowlist: parameterised SVG, spoofed bytes and what gets stored.

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn(), storageQueue: jest.fn(), timer: jest.fn() } };
});
jest.mock("../db", () => ({
  closeConnection: jest.fn(),
  createRequestConnection: jest.fn().mockResolvedValue({}),
  executeQuery: jest.fn(),
  inTransaction: jest.fn(),
}));
jest.mock("../auth", () => ({
  ...jest.requireActual("../auth"),
  errorResponse: jest.fn().mockReturnValue({ status: 500, jsonBody: { error: "Error" } }),
  extractToken: jest.fn().mockReturnValue("mock-token"),
  oidFromToken: jest.fn().mockReturnValue("oid"),
  requireRole: jest.fn().mockResolvedValue(null),
  unauthorizedResponse: jest.fn().mockReturnValue({ status: 401, jsonBody: { error: "Unauthorized" } }),
  verifiedIdentityFromRequest: jest.fn().mockResolvedValue({ email: "f@rp", name: "Fay", oid: "oid" }),
}));
jest.mock("../blob-storage", () => ({
  deleteBlob: jest.fn(),
  generateReadSasUrl: jest.fn(() => "https://sas"),
  uploadBlob: jest.fn().mockResolvedValue({ blobName: "x/y.pdf", url: "u" }),
}));
jest.mock("../mybuildings-client", () => ({ uploadAttachment: jest.fn() }));

type Handler = (req: HttpRequest, ctx: InvocationContext) => Promise<{ status?: number; jsonBody?: any }>;
const db = require("../db") as { executeQuery: jest.Mock };
const blob = require("../blob-storage") as { uploadBlob: jest.Mock };
const { app } = require("@azure/functions") as { app: { http: jest.Mock } };
require("./attachments");
require("./tenancyAttachments");
const registered = (name: string): Handler =>
  (app.http.mock.calls.find((c: unknown[]) => c[0] === name)![1] as { handler: Handler }).handler;
const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;

function upload(file: File, extra: Record<string, string>): HttpRequest {
  const form = new FormData();
  form.set("file", file);
  for (const [k, v] of Object.entries(extra)) form.set(k, v);
  return { formData: async () => form, headers: { get: () => null }, query: new URLSearchParams() } as unknown as HttpRequest;
}

const cases: [string, string, Record<string, string>][] = [
  ["uploadAttachment", "oid-a", { jobId: "12" }],
  ["uploadTenancyAttachment", "oid-b", { tenantId: "3" }],
];

describe.each(cases)("%s content-type gate", (name, _label, extra) => {
  const handler = registered(name);
  beforeEach(() => {
    blob.uploadBlob.mockClear();
    db.executeQuery.mockReset().mockResolvedValue([{ Id: 1 }]);
  });

  it.each(["image/svg+xml", "image/svg+xml; charset=utf-8", "text/html"])("415s %s before storing", async (type) => {
    const res = await handler(upload(new File(["<svg/>"], "a.svg", { type }), extra), ctx);
    expect(res.status).toBe(415);
    expect(blob.uploadBlob).not.toHaveBeenCalled();
  });

  it("415s SVG bytes declared as image/png", async () => {
    const res = await handler(upload(new File(["<svg><script/></svg>"], "a.png", { type: "image/png" }), extra), ctx);
    expect(res.status).toBe(415);
    expect(blob.uploadBlob).not.toHaveBeenCalled();
  });

  it("stores the normalised type, not the raw header", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await handler(upload(new File([png], "a.png", { type: "Image/PNG; foo=bar" }), extra), ctx);
    expect(blob.uploadBlob).toHaveBeenCalledTimes(1);
    expect(blob.uploadBlob.mock.calls[0][2]).toBe("image/png");
  });
});
