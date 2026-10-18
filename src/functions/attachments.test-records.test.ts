/// <reference types="jest" />
// D9 review: a test job's file never reaches myBuildings. It is still kept in
// Floorplan (blob and Attachments row); only the push to the work request is refused.
import { HttpRequest, InvocationContext } from "@azure/functions";

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn(), storageQueue: jest.fn(), timer: jest.fn() } };
});
jest.mock("../db", () => ({ closeConnection: jest.fn(), createRequestConnection: jest.fn().mockResolvedValue({}), executeQuery: jest.fn() }));
jest.mock("../auth", () => ({
  ...jest.requireActual("../auth"),
  extractToken: jest.fn().mockReturnValue("tok"),
  requireRole: jest.fn().mockResolvedValue(null),
  verifiedIdentityFromRequest: jest.fn().mockResolvedValue({ email: "f@rp", name: "Fay", oid: "fay-oid" }),
}));
jest.mock("../blob-storage", () => ({
  generateReadSasUrl: jest.fn((name: string) => `https://sas/${name}`),
  uploadBlob: jest.fn().mockResolvedValue({ blobName: "attachments/jobs/12/x.pdf" }),
}));
jest.mock("../mybuildings-client", () => ({ uploadAttachment: jest.fn().mockResolvedValue(undefined) }));
jest.mock("../test-data", () => ({ ...jest.requireActual("../test-data"), readIsTest: jest.fn() }));

type Handler = (req: HttpRequest, ctx: InvocationContext) => Promise<{ status?: number; jsonBody?: any }>;

const db = require("../db") as { executeQuery: jest.Mock };
const mybuildings = require("../mybuildings-client") as { uploadAttachment: jest.Mock };
const testData = require("../test-data") as { readIsTest: jest.Mock };
const { app } = require("@azure/functions") as { app: { http: jest.Mock } };
require("./attachments");
const upload = (app.http.mock.calls.find((c: unknown[]) => c[0] === "uploadAttachment")?.[1] as { handler: Handler }).handler;

const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;
const file = { arrayBuffer: async () => new ArrayBuffer(4), name: "quote.pdf", size: 4, type: "application/pdf" };
const request = (fields: Record<string, unknown>) =>
  ({ formData: async () => new Map(Object.entries({ file, ...fields })), headers: { get: () => null } }) as unknown as HttpRequest;

beforeEach(() => {
  jest.clearAllMocks();
  db.executeQuery.mockResolvedValue([{ Id: 5 }]);
});

describe("uploadAttachment and test records", () => {
  it("keeps a test job's file in Floorplan and never pushes it to myBuildings", async () => {
    testData.readIsTest.mockResolvedValue(true);
    const res = await upload(request({ jobId: "12", workRequestId: "88" }), ctx);
    expect(res.status).toBe(200);
    expect(testData.readIsTest).toHaveBeenCalledWith(expect.anything(), "job", 12);
    expect(mybuildings.uploadAttachment).not.toHaveBeenCalled();
    expect(db.executeQuery.mock.calls.some((c: unknown[]) => /INSERT INTO Attachments/.test(String(c[1])))).toBe(true);
    expect(res.jsonBody.myBuildings).toBe("Not sent: test record");
  });

  it("pushes a real job's file, saying what it is about", async () => {
    testData.readIsTest.mockResolvedValue(false);
    await upload(request({ jobId: "12", workRequestId: "88" }), ctx);
    expect(mybuildings.uploadAttachment).toHaveBeenCalledWith({ isTest: false }, expect.objectContaining({ WorkRequestID: 88 }));
  });

  it("refuses the push when the job's flag can't be read, keeping nothing half-sent", async () => {
    testData.readIsTest.mockRejectedValue(new Error("db down"));
    const res = await upload(request({ jobId: "12", workRequestId: "88" }), ctx);
    expect(mybuildings.uploadAttachment).not.toHaveBeenCalled();
    expect(res.status).toBe(500);
  });

  it("a work request with no job yet is not a record D9 flags", async () => {
    await upload(request({ workRequestId: "88" }), ctx);
    expect(testData.readIsTest).not.toHaveBeenCalled();
    expect(mybuildings.uploadAttachment).toHaveBeenCalledWith("not-a-record", expect.objectContaining({ WorkRequestID: 88 }));
  });
});
