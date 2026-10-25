/// <reference types="jest" />
import { HttpRequest, InvocationContext } from "@azure/functions";

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn() } };
});

jest.mock("../auth", () => {
  const actual = jest.requireActual("../auth");
  return {
    ...actual,
    errorResponse: jest.fn().mockReturnValue({ status: 500, jsonBody: { error: "Error" } }),
    extractToken: jest.fn().mockReturnValue("mock-token"),
    requireRole: jest.fn().mockResolvedValue(null),
    unauthorizedResponse: jest.fn().mockReturnValue({ status: 401, jsonBody: { error: "Unauthorized" } }),
    verifiedIdentityFromRequest: jest.fn().mockResolvedValue({ email: "c@rp.com", name: "Connor", oid: "oid-1" }),
  };
});

jest.mock("../db", () => {
  const actual = jest.requireActual("../db");
  return {
    ...actual,
    beginTransaction: jest.fn().mockResolvedValue(undefined),
    closeConnection: jest.fn(),
    commitTransaction: jest.fn().mockResolvedValue(undefined),
    createRequestConnection: jest.fn().mockResolvedValue({}),
    executeQuery: jest.fn().mockResolvedValue([]),
    rollbackTransaction: jest.fn().mockResolvedValue(undefined),
  };
});

jest.mock("../blob-storage", () => ({
  deleteBlob: jest.fn().mockResolvedValue(undefined),
  generateReadSasUrl: jest.fn((blobName: string) => `https://sas.example/${blobName}`),
  uploadBlob: jest.fn().mockResolvedValue({ blobName: "asset-7/abc.pdf", url: "https://blob.example/abc" }),
}));

jest.mock("../rateLimit", () => ({
  checkRateLimit: jest.fn().mockReturnValue({ allowed: true }),
}));

import { getAssetAttachments } from "./getAssetAttachments";
import { uploadAssetAttachment } from "./uploadAssetAttachment";
import { ASSET_BLOB_PREFIX } from "../assetRegister";
import { MAX_SIZE_BYTES } from "../upload-constants";

type Row = Record<string, unknown>;
type Route = { match: RegExp; rows?: Row[]; throws?: Error };
type SqlCall = [unknown, string, Array<{ name: string; value: unknown }>?];

const db = require("../db") as {
  beginTransaction: jest.Mock;
  closeConnection: jest.Mock;
  commitTransaction: jest.Mock;
  createRequestConnection: jest.Mock;
  executeQuery: jest.Mock;
  rollbackTransaction: jest.Mock;
};
const blobs = require("../blob-storage") as { deleteBlob: jest.Mock; uploadBlob: jest.Mock };
const rateLimit = require("../rateLimit") as { checkRateLimit: jest.Mock };

const context = new InvocationContext();

function route(routes: Route[]): void {
  db.executeQuery.mockImplementation(async (_connection: unknown, sql: string) => {
    const hit = routes.find((r) => r.match.test(sql));
    if (!hit) return [];
    if (hit.throws) throw hit.throws;
    return hit.rows ?? [];
  });
}
const queries = (match: RegExp): SqlCall[] =>
  (db.executeQuery.mock.calls as SqlCall[]).filter(([, sql]) => match.test(sql));
const paramsOf = (call: SqlCall): Row => Object.fromEntries((call[2] ?? []).map((p) => [p.name, p.value]));
const errorOf = (response: { jsonBody?: unknown }): string => (response.jsonBody as { error: string }).error;

const at = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

const ASSET_ROW = /SELECT AssetId, ArchivedAt FROM dbo\.Assets WHERE AssetId = @AssetId/;
const ATTACHMENT_INSERT = /INSERT INTO dbo\.Attachments/;
const JUNCTION_INSERT = /INSERT INTO dbo\.AssetAttachments/;
const FILES = /FROM dbo\.AssetAttachments aa/;

const listRequest = (query: string): HttpRequest => ({ query: new URLSearchParams(query) }) as unknown as HttpRequest;

function uploadRequest(fields: { assetId?: string; file?: File | null }): HttpRequest {
  const form = new FormData();
  if (fields.file) form.append("file", fields.file);
  if (fields.assetId !== undefined) form.append("assetId", fields.assetId);
  return { formData: async () => form, query: new URLSearchParams() } as unknown as HttpRequest;
}
const pdf = (name = "manual.pdf", type = "application/pdf"): File =>
  new File([Buffer.from("%PDF-1.4 test")], name, { type });

const liveAsset: Route = { match: ASSET_ROW, rows: [{ ArchivedAt: null, AssetId: 7 }] };

beforeEach(() => {
  jest.clearAllMocks();
  db.executeQuery.mockReset();
  db.executeQuery.mockResolvedValue([]);
  db.createRequestConnection.mockResolvedValue({});
  blobs.uploadBlob.mockResolvedValue({ blobName: "asset-7/abc.pdf", url: "https://blob.example/abc" });
  blobs.deleteBlob.mockResolvedValue(undefined);
  rateLimit.checkRateLimit.mockReturnValue({ allowed: true });
});

describe("getAssetAttachments", () => {
  it.each(["", "assetId=abc", "assetId=0"])("rejects ?%s", async (query) => {
    const response = await getAssetAttachments(listRequest(query), context);
    expect(response.status).toBe(400);
    expect(db.createRequestConnection).not.toHaveBeenCalled();
  });

  it("lists files newest first with a download link and the uploader's name", async () => {
    route([
      {
        match: FILES,
        rows: [
          { AssetId: 7, AttachedAt: at("2026-10-13"), BlobName: "asset-7/b.png", Comment: "Nameplate", ContentType: "image/png", Extension: "png", Id: 9, MyBuildingsConfirmedAt: null, OriginalName: "nameplate.png", SizeBytes: "512", UploadedAt: at("2026-10-13"), UploadedBy: "oid-1", UploadedByName: "Connor" },
          { AssetId: 7, AttachedAt: at("2026-10-01"), BlobName: "asset-7/a.pdf", Comment: null, ContentType: "application/pdf", Extension: "pdf", Id: 5, MyBuildingsConfirmedAt: null, OriginalName: "manual.pdf", SizeBytes: null, UploadedAt: at("2026-10-01"), UploadedBy: "oid-9", UploadedByName: null },
        ],
      },
    ]);
    const response = await getAssetAttachments(listRequest("assetId=7"), context);

    expect(response.status).toBe(200);
    const payload = response.jsonBody as { attachments: Row[]; count: number };
    expect(payload.count).toBe(2);
    expect(payload.attachments[0]).toMatchObject({
      comment: "Nameplate",
      contentType: "image/png",
      id: 9,
      originalName: "nameplate.png",
      sasUrl: "https://sas.example/asset-7/b.png",
      sizeBytes: 512,
      uploadedBy: "oid-1",
      uploadedByName: "Connor",
    });
    expect(payload.attachments[1]).toMatchObject({ sizeBytes: null, uploadedByName: null });
    const [select] = queries(FILES);
    expect(select[1]).toContain("ORDER BY aa.AttachedAt DESC");
    expect(select[1]).toContain("LEFT JOIN dbo.AppUsers u ON u.EntraOid = att.UploadedBy");
    expect(paramsOf(select)).toEqual({ AssetId: 7 });
  });

  it("returns an empty list for an asset with no files", async () => {
    const response = await getAssetAttachments(listRequest("assetId=7"), context);
    expect(response.jsonBody).toEqual({ attachments: [], count: 0 });
  });

  it("reports a failure as a 500 and closes the connection", async () => {
    route([{ match: FILES, throws: new Error("boom") }]);
    const response = await getAssetAttachments(listRequest("assetId=7"), context);
    expect(response.status).toBe(500);
    expect(db.closeConnection).toHaveBeenCalledTimes(1);
  });
});

describe("uploadAssetAttachment: rejected before anything is stored", () => {
  it("rate limits per caller", async () => {
    rateLimit.checkRateLimit.mockReturnValue({ allowed: false, retryAfterMs: 2500 });
    const response = await uploadAssetAttachment(uploadRequest({ assetId: "7", file: pdf() }), context);
    expect(response.status).toBe(429);
    expect(response.headers).toEqual({ "Retry-After": "3" });
    expect(rateLimit.checkRateLimit).toHaveBeenCalledWith("uploadAssetAttachment:oid-1", expect.any(Object));
    expect(blobs.uploadBlob).not.toHaveBeenCalled();
  });

  it("rejects a request that is not multipart", async () => {
    const request = { formData: async () => { throw new TypeError("not multipart"); }, query: new URLSearchParams() } as unknown as HttpRequest;
    const response = await uploadAssetAttachment(request, context);
    expect(response.status).toBe(400);
  });

  it.each([
    ["a missing file", { assetId: "7" }, "Missing 'file'"],
    ["a missing assetId", { file: pdf() }, "Missing 'assetId'"],
    ["a non-numeric assetId", { assetId: "seven", file: pdf() }, "assetId must be an integer"],
    ["a zero assetId", { assetId: "0", file: pdf() }, "Missing 'assetId'"],
  ])("rejects %s", async (_label, fields, message) => {
    const response = await uploadAssetAttachment(uploadRequest(fields), context);
    expect(response.status).toBe(400);
    expect(errorOf(response)).toContain(message);
    expect(blobs.uploadBlob).not.toHaveBeenCalled();
  });

  it("rejects file types that are not allowed", async () => {
    const exe = await uploadAssetAttachment(uploadRequest({ assetId: "7", file: pdf("x.exe", "application/x-msdownload") }), context);
    expect(exe.status).toBe(415);
    const svg = await uploadAssetAttachment(uploadRequest({ assetId: "7", file: pdf("x.svg", "image/svg+xml") }), context);
    expect(svg.status).toBe(415);
    expect(blobs.uploadBlob).not.toHaveBeenCalled();
  });

  it("rejects SVG smuggled in with a media-type parameter", async () => {
    const svg = await uploadAssetAttachment(uploadRequest({ assetId: "7", file: pdf("x.svg", "image/svg+xml; charset=utf-8") }), context);
    expect(svg.status).toBe(415);
    expect(blobs.uploadBlob).not.toHaveBeenCalled();
  });

  it("rejects bytes that do not match the declared image type", async () => {
    route([liveAsset]);
    const fake = new File([Buffer.from("<svg><script/></svg>")], "x.png", { type: "image/png" });
    const response = await uploadAssetAttachment(uploadRequest({ assetId: "7", file: fake }), context);
    expect(response.status).toBe(415);
    expect(blobs.uploadBlob).not.toHaveBeenCalled();
  });

  it("rejects files over the size limit", async () => {
    const big = pdf();
    Object.defineProperty(big, "size", { value: MAX_SIZE_BYTES + 1 });
    const response = await uploadAssetAttachment(uploadRequest({ assetId: "7", file: big }), context);
    expect(response.status).toBe(413);
    expect(blobs.uploadBlob).not.toHaveBeenCalled();
  });

  it("404s for an unknown asset without uploading the file", async () => {
    const response = await uploadAssetAttachment(uploadRequest({ assetId: "7", file: pdf() }), context);
    expect(response.status).toBe(404);
    expect(blobs.uploadBlob).not.toHaveBeenCalled();
    expect(queries(ATTACHMENT_INSERT)).toHaveLength(0);
  });

  it("refuses an archived asset without uploading the file", async () => {
    route([{ match: ASSET_ROW, rows: [{ ArchivedAt: at("2026-10-01"), AssetId: 7 }] }]);
    const response = await uploadAssetAttachment(uploadRequest({ assetId: "7", file: pdf() }), context);
    expect(response.status).toBe(409);
    expect(blobs.uploadBlob).not.toHaveBeenCalled();
  });
});

describe("uploadAssetAttachment: storing the file", () => {
  it("uploads under the asset prefix, then writes both rows in one transaction", async () => {
    route([
      liveAsset,
      { match: ATTACHMENT_INSERT, rows: [{ Id: 55, UploadedAt: at("2026-10-13") }] },
      { match: JUNCTION_INSERT, rows: [{ AttachedAt: at("2026-10-13") }] },
    ]);
    const response = await uploadAssetAttachment(uploadRequest({ assetId: "7", file: pdf() }), context);

    expect(response.status).toBe(200);
    expect(response.jsonBody).toEqual({
      attachment: {
        assetId: 7,
        attachedAt: "2026-10-13T00:00:00.000Z",
        comment: null,
        contentType: "application/pdf",
        extension: "pdf",
        id: 55,
        originalName: "manual.pdf",
        sasUrl: "https://sas.example/asset-7/abc.pdf",
        sizeBytes: 13,
        uploadedAt: "2026-10-13T00:00:00.000Z",
        uploadedBy: "oid-1",
        uploadedByName: "Connor",
      },
    });

    expect(blobs.uploadBlob).toHaveBeenCalledTimes(1);
    const [buffer, name, type, prefix] = blobs.uploadBlob.mock.calls[0];
    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect([name, type, prefix]).toEqual(["manual.pdf", "application/pdf", `${ASSET_BLOB_PREFIX}7`]);

    expect(paramsOf(queries(ATTACHMENT_INSERT)[0])).toMatchObject({
      BlobName: "asset-7/abc.pdf",
      ContentType: "application/pdf",
      Extension: "pdf",
      OriginalName: "manual.pdf",
      SizeBytes: 13,
      UploadedBy: "oid-1",
    });
    expect(paramsOf(queries(JUNCTION_INSERT)[0])).toEqual({ AssetId: 7, AttachedBy: "oid-1", AttachmentID: 55 });
    expect(db.beginTransaction).toHaveBeenCalledTimes(1);
    expect(db.commitTransaction).toHaveBeenCalledTimes(1);
    expect(db.rollbackTransaction).not.toHaveBeenCalled();
    expect(blobs.deleteBlob).not.toHaveBeenCalled();
  });

  it("rolls back and removes the blob when the link row cannot be written", async () => {
    route([
      liveAsset,
      { match: ATTACHMENT_INSERT, rows: [{ Id: 55, UploadedAt: at("2026-10-13") }] },
      { match: JUNCTION_INSERT, throws: new Error("FK violation") },
    ]);
    const response = await uploadAssetAttachment(uploadRequest({ assetId: "7", file: pdf() }), context);

    expect(response.status).toBe(500);
    expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(db.commitTransaction).not.toHaveBeenCalled();
    expect(blobs.deleteBlob).toHaveBeenCalledWith("asset-7/abc.pdf");
    expect(db.closeConnection).toHaveBeenCalledTimes(1);
  });

  it("removes the blob when the attachment row cannot be written", async () => {
    route([liveAsset, { match: ATTACHMENT_INSERT, throws: new Error("deadlock victim") }]);
    const response = await uploadAssetAttachment(uploadRequest({ assetId: "7", file: pdf() }), context);
    expect(response.status).toBe(500);
    expect(blobs.deleteBlob).toHaveBeenCalledWith("asset-7/abc.pdf");
  });

  it("does not try to delete a blob that was never stored", async () => {
    route([liveAsset]);
    blobs.uploadBlob.mockRejectedValue(new Error("storage unavailable"));
    const response = await uploadAssetAttachment(uploadRequest({ assetId: "7", file: pdf() }), context);
    expect(response.status).toBe(500);
    expect(blobs.deleteBlob).not.toHaveBeenCalled();
    expect(queries(ATTACHMENT_INSERT)).toHaveLength(0);
  });

  it("still reports the original failure if cleaning up the blob also fails", async () => {
    route([liveAsset, { match: ATTACHMENT_INSERT, throws: new Error("deadlock victim") }]);
    blobs.deleteBlob.mockRejectedValue(new Error("storage unavailable"));
    const response = await uploadAssetAttachment(uploadRequest({ assetId: "7", file: pdf() }), context);
    expect(response.status).toBe(500);
  });
});
