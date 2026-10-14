/// <reference types="jest" />
import { HttpRequest, InvocationContext } from "@azure/functions";

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn(), storageQueue: jest.fn(), timer: jest.fn() } };
});
jest.mock("../db", () => ({
  closeConnection: jest.fn(),
  createRequestConnection: jest.fn().mockResolvedValue({}),
  executeQuery: jest.fn(),
}));
jest.mock("../auth", () => {
  const actual = jest.requireActual("../auth");
  return {
    ...actual,
    errorResponse: jest.fn().mockReturnValue({ status: 500, jsonBody: { error: "Error" } }),
    extractToken: jest.fn().mockReturnValue("mock-token"),
    oidFromToken: jest.fn().mockReturnValue("caller-oid"),
    requireRole: jest.fn().mockResolvedValue(null),
    rolesForRequest: jest.fn().mockResolvedValue(["facilities"]),
    unauthorizedResponse: jest.fn().mockReturnValue({ status: 401, jsonBody: { error: "Unauthorized" } }),
    verifiedIdentityFromRequest: jest.fn().mockResolvedValue({ email: "f@rp", name: "Fay", oid: "caller-oid" }),
  };
});
jest.mock("../blob-storage", () => ({
  deleteBlob: jest.fn().mockResolvedValue(undefined),
  generateReadSasUrl: jest.fn((name: string) => `https://sas/${name}`),
  uploadBlob: jest.fn(),
}));
jest.mock("../mybuildings-client", () => ({ uploadAttachment: jest.fn() }));

type Handler = (req: HttpRequest, ctx: InvocationContext) => Promise<{ status?: number; jsonBody?: any }>;

const db = require("../db") as { executeQuery: jest.Mock };
const auth = require("../auth") as { extractToken: jest.Mock; rolesForRequest: jest.Mock };
const blob = require("../blob-storage") as { deleteBlob: jest.Mock; generateReadSasUrl: jest.Mock };
const { app } = require("@azure/functions") as { app: { http: jest.Mock } };
require("./attachments");

const registered = (name: string): Handler => {
  const hit = app.http.mock.calls.find((c: unknown[]) => c[0] === name);
  if (!hit) throw new Error(`handler ${name} not registered`);
  return (hit[1] as { handler: Handler }).handler;
};
const claimEmailAttachment = registered("claimEmailAttachment");
const deleteAttachment = registered("deleteAttachment");
const getAttachments = registered("getAttachments");

const UUID = "3f2c9a10-5b7e-4d21-9c8a-0e1f2a3b4c5d";
const EMAIL_BLOB = `email-attachments/AAMkAGI2_T-VSAAA=/${UUID}.pdf`;
const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;

function post(body: unknown): HttpRequest {
  return { headers: { get: () => null }, json: jest.fn().mockResolvedValue(body), query: new URLSearchParams() } as unknown as HttpRequest;
}
function get(query: Record<string, string>): HttpRequest {
  return { headers: { get: () => null }, query: new URLSearchParams(query) } as unknown as HttpRequest;
}
const sqlCalls = () => db.executeQuery.mock.calls.map((c: unknown[]) => String(c[1]));

beforeEach(() => {
  jest.clearAllMocks();
  auth.extractToken.mockReturnValue("mock-token");
  auth.rolesForRequest.mockResolvedValue(["facilities"]);
  db.executeQuery.mockReset().mockResolvedValue([]);
});

describe("claimEmailAttachment", () => {
  it("returns 401 without a token", async () => {
    auth.extractToken.mockReturnValueOnce(null);
    const res = await claimEmailAttachment(post({ BlobName: EMAIL_BLOB, JobID: 12 }), ctx);
    expect(res.status).toBe(401);
  });

  it.each([
    "emails/x/../../../key-photos/keys/a.jpg",
    "emails/x/../../attachments/jobs/12/a.pdf",
    `email-attachments/x/../../attachments/jobs/12/${UUID}.pdf`,
    `email-attachments/x/${UUID}.pdf/../../../key-photos/keys/a.jpg`,
    `attachments/jobs/12/${UUID}.pdf`,
  ])("refuses %s with 400 and touches nothing", async (name) => {
    const res = await claimEmailAttachment(post({ BlobName: name, FileName: "a.pdf", JobID: 12 }), ctx);
    expect(res.status).toBe(400);
    expect(db.executeQuery).not.toHaveBeenCalled();
    expect(blob.generateReadSasUrl).not.toHaveBeenCalled();
  });

  it("claims a genuine mail-sync attachment", async () => {
    db.executeQuery.mockResolvedValueOnce([{ Id: 5, BlobName: EMAIL_BLOB }]);
    const res = await claimEmailAttachment(post({ BlobName: EMAIL_BLOB, FileName: "quote.pdf", JobID: 12 }), ctx);
    expect(res.status).toBe(200);
    expect(res.jsonBody.attachment.sasUrl).toBe(`https://sas/${EMAIL_BLOB}`);
    const params = db.executeQuery.mock.calls[0][2] as { name: string; value: unknown }[];
    expect(params).toEqual(expect.arrayContaining([{ name: "BlobName", type: expect.anything(), value: EMAIL_BLOB }]));
  });
});

describe("deleteAttachment only deletes blobs the row owns", () => {
  const row = (BlobName: string, UploadedBy = "caller-oid") => [{ BlobName, MyBuildingsConfirmedAt: null, UploadedBy, JobID: 12 }];

  it("deletes the blob of a file uploaded to the job", async () => {
    db.executeQuery.mockResolvedValueOnce(row(`attachments/jobs/12/${UUID}.pdf`));
    const res = await deleteAttachment(post({ AttachmentID: 5 }), ctx);
    expect(res.status).toBe(200);
    expect(blob.deleteBlob).toHaveBeenCalledWith(`attachments/jobs/12/${UUID}.pdf`);
  });

  it.each([
    ["a claimed email attachment (the email owns it)", EMAIL_BLOB],
    ["an inspection photo copied to a raised job", `inspections/${UUID}.jpg`],
    ["a legacy traversal name", "emails/x/../../../key-photos/keys/a.jpg"],
  ])("keeps the blob for %s and removes only the row", async (_label, name) => {
    auth.rolesForRequest.mockResolvedValue(["admin"]);
    db.executeQuery.mockResolvedValueOnce(row(name, "someone-else"));
    const res = await deleteAttachment(post({ AttachmentID: 5 }), ctx);
    expect(res.status).toBe(200);
    expect(blob.deleteBlob).not.toHaveBeenCalled();
    expect(sqlCalls().some((s: string) => /DELETE FROM Attachments/.test(s))).toBe(true);
  });
});

describe("getAttachments", () => {
  it("signs genuine names and leaves a malformed legacy name unsigned instead of failing the list", async () => {
    db.executeQuery.mockResolvedValueOnce([
      { Id: 1, BlobName: `attachments/jobs/12/${UUID}.pdf`, MyBuildingsConfirmedAt: null },
      { Id: 2, BlobName: "emails/x/../../../key-photos/keys/a.jpg", MyBuildingsConfirmedAt: null },
    ]);
    const res = await getAttachments(get({ jobId: "12" }), ctx);
    expect(res.status).toBe(200);
    expect(res.jsonBody.attachments.map((a: { sasUrl: string | null }) => a.sasUrl)).toEqual([
      `https://sas/attachments/jobs/12/${UUID}.pdf`,
      null,
    ]);
    expect(blob.generateReadSasUrl).toHaveBeenCalledTimes(1);
  });
});
