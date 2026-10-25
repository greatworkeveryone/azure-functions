/// <reference types="jest" />
// Jobs plan A1 (database-safety rule 1: files follow their record): the file a
// decision request is about stays while the request does. deleteAttachment refuses
// it, the foreign key on JobDecisionRequests.SourceAttachmentId being only the
// backstop, and a database that has not had migration 137 applied yet deletes
// files as it always did.
import { HttpRequest, InvocationContext } from "@azure/functions";

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn(), storageQueue: jest.fn(), timer: jest.fn() } };
});
jest.mock("../db", () => ({
  beginTransaction: jest.fn().mockResolvedValue(undefined),
  closeConnection: jest.fn(),
  commitTransaction: jest.fn().mockResolvedValue(undefined),
  createRequestConnection: jest.fn().mockResolvedValue({}),
  executeQuery: jest.fn(),
  rollbackTransaction: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../auth", () => ({
  ...jest.requireActual("../auth"),
  extractToken: jest.fn().mockReturnValue("tok"),
  requireRole: jest.fn().mockResolvedValue(null),
  rolesForRequest: jest.fn().mockResolvedValue(["accounts"]),
  verifiedIdentityFromRequest: jest.fn().mockResolvedValue({ email: "alana@rp", name: "Alana", oid: "alana-oid" }),
}));
jest.mock("../blob-storage", () => ({ deleteBlob: jest.fn(), generateReadSasUrl: jest.fn().mockReturnValue("sas"), uploadBlob: jest.fn() }));
jest.mock("../mybuildings-client", () => ({ uploadAttachment: jest.fn() }));
jest.mock("../rateLimit", () => ({ checkRateLimit: jest.fn().mockReturnValue({ allowed: true, retryAfterMs: 0 }) }));

type Handler = (req: HttpRequest, ctx: InvocationContext) => Promise<{ status?: number; jsonBody?: any }>;
const db = jest.requireMock("../db") as { executeQuery: jest.Mock };
const blob = jest.requireMock("../blob-storage") as { deleteBlob: jest.Mock };
require("./attachments");
const { app } = jest.requireMock("@azure/functions") as { app: { http: jest.Mock } };
const registered = new Map<string, Handler>(app.http.mock.calls.map((c: [string, { handler: Handler }]) => [c[0], c[1].handler]));
const deleteAttachment = registered.get("deleteAttachment") as Handler;

const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;
const post = (body: unknown) => ({ headers: { get: () => null }, json: async () => body, query: new URLSearchParams() }) as unknown as HttpRequest;

const ABOUT_THE_FILE = /FROM dbo\.JobDecisionRequests WHERE SourceAttachmentId = @AttachmentId/;
let requests: { JobId: number; RequestId: number; State: string }[];
let aboutFileError: Error | null;

beforeEach(() => {
  jest.clearAllMocks();
  requests = [];
  aboutFileError = null;
  db.executeQuery.mockImplementation(async (_c: unknown, sql: string) => {
    if (/FROM Attachments a\s+LEFT JOIN Jobs/.test(sql)) {
      return [{ BlobName: "attachments/jobs/12/3f2b6c1e-8a4d-4f7e-9b21-6c0d5e7a9f10.pdf", JobID: 12, MyBuildingsConfirmedAt: null, UploadedBy: "alana-oid" }];
    }
    if (ABOUT_THE_FILE.test(sql.replace(/\s+/g, " "))) {
      if (aboutFileError) throw aboutFileError;
      return requests;
    }
    return [];
  });
});

const ran = (pattern: RegExp) => db.executeQuery.mock.calls.some((c: unknown[]) => pattern.test(String(c[1])));

describe("deleteAttachment and the file a decision request is about", () => {
  it.each(["pending", "answered", "withdrawn"])("refuses (422) a file a %s request is about; nothing is deleted", async (State) => {
    requests = [{ JobId: 12, RequestId: 7, State }];

    const res = await deleteAttachment(post({ AttachmentID: 7 }), ctx);

    expect(res.status).toBe(422);
    expect(res.jsonBody.error).toBe(
      "This file is what a decision request on this job is about, so it stays with the request. Withdraw the request first if it was raised by mistake.",
    );
    expect(blob.deleteBlob).not.toHaveBeenCalled();
    expect(ran(/DELETE FROM Attachments/)).toBe(false);
  });

  it("asks about that one file, by id", async () => {
    await deleteAttachment(post({ AttachmentID: 7 }), ctx);
    const call = db.executeQuery.mock.calls.find((c: unknown[]) => ABOUT_THE_FILE.test(String(c[1]).replace(/\s+/g, " ")));
    expect(call?.[2]).toEqual([expect.objectContaining({ name: "AttachmentId", value: 7 })]);
  });

  it("still deletes a file no request is about", async () => {
    const res = await deleteAttachment(post({ AttachmentID: 7 }), ctx);

    expect(res.status).toBe(200);
    expect(blob.deleteBlob).toHaveBeenCalledWith("attachments/jobs/12/3f2b6c1e-8a4d-4f7e-9b21-6c0d5e7a9f10.pdf");
    expect(ran(/DELETE FROM Attachments WHERE Id = @Id/)).toBe(true);
  });

  it("deletes files as it always did where migration 137 has not been applied (no table, so no request)", async () => {
    aboutFileError = Object.assign(new Error("Invalid object name 'dbo.JobDecisionRequests'."), { number: 208 });

    const res = await deleteAttachment(post({ AttachmentID: 7 }), ctx);

    expect(res.status).toBe(200);
    expect(ran(/DELETE FROM Attachments WHERE Id = @Id/)).toBe(true);
  });

  it("does not delete anything when the check itself fails for another reason", async () => {
    aboutFileError = Object.assign(new Error("Timeout expired"), { number: -2 });

    const res = await deleteAttachment(post({ AttachmentID: 7 }), ctx);

    expect(res.status).toBe(500);
    expect(blob.deleteBlob).not.toHaveBeenCalled();
    expect(ran(/DELETE FROM Attachments/)).toBe(false);
  });

  it("refuses before it touches the blob", async () => {
    requests = [{ JobId: 12, RequestId: 7, State: "pending" }];
    await deleteAttachment(post({ AttachmentID: 7 }), ctx);
    expect(blob.deleteBlob).not.toHaveBeenCalled();
  });
});
