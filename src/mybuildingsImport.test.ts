/// <reference types="jest" />
import { runMyBuildingsImport, type ImportDeps, type ImportOptions } from "./mybuildingsImport";

jest.mock("./db", () => ({ executeQuery: jest.fn() }));
const db = require("./db") as { executeQuery: jest.Mock };

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const conn = {} as any;
const names = new Map([["Alpha House", 5]]);
const opts = (over: Partial<ImportOptions> = {}): ImportOptions => ({
  attachmentLimit: 25, buildingId: null, dryRun: false, recheckAttachments: false, since: "1 Jan 2026", startedBy: "ada@rp", ...over,
});
const deps = (): jest.Mocked<ImportDeps> => ({
  downloadAttachment: jest.fn().mockResolvedValue({ bytes: PNG, contentType: "image/png" }),
  fetchAttachments: jest.fn().mockResolvedValue([]),
  storeBlob: jest.fn().mockResolvedValue("attachments/workRequests/1/x.png"),
  upsertWorkRequest: jest.fn().mockResolvedValue(undefined),
});
const wr = (id: number, extra = {}) => ({ WorkRequestID: id, BuildingName: "Alpha House", LastModifiedDate: "2026-10-01", ...extra });
const sql = () => db.executeQuery.mock.calls.map((c: unknown[]) => String(c[1]));

beforeEach(() => {
  db.executeQuery.mockReset().mockImplementation(async (_c: unknown, text: string) => {
    if (/INSERT INTO dbo\.MyBuildingsImportRuns/.test(text)) return [{ RunId: 9 }];
    if (/INSERT INTO dbo\.Attachments/.test(text)) return [{ Id: 100 }];
    return [];
  });
});

describe("dry run", () => {
  it("writes and downloads nothing, but counts what it would do", async () => {
    const d = deps();
    d.fetchAttachments.mockResolvedValue([{ AttachmentID: 1, Attachment_Name: "a.png", Attachment_URL: "https://x/a.png" }]);
    const r = await runMyBuildingsImport(conn, [wr(1), wr(2)], names, d, opts({ dryRun: true }));
    expect(r.totals).toMatchObject({ inserted: 2, attachmentsImported: 2 });
    expect(r.runId).toBeNull();
    expect(d.upsertWorkRequest).not.toHaveBeenCalled();
    expect(d.downloadAttachment).not.toHaveBeenCalled();
    expect(d.storeBlob).not.toHaveBeenCalled();
    expect(sql().filter((s: string) => /^\s*(INSERT|UPDATE|MERGE|DELETE)/i.test(s))).toEqual([]);
  });
});

describe("real run", () => {
  it("inserts new, updates changed, leaves unchanged, counts per building", async () => {
    db.executeQuery.mockImplementation(async (_c: unknown, text: string) => {
      if (/INSERT INTO dbo\.MyBuildingsImportRuns/.test(text)) return [{ RunId: 9 }];
      if (/FROM dbo\.WorkRequests wr LEFT JOIN/.test(text)) {
        return [{ WorkRequestID: 2, LastModifiedDate: "2026-09-01" }, { WorkRequestID: 3, LastModifiedDate: "2026-10-01" }];
      }
      return [];
    });
    const d = deps();
    const r = await runMyBuildingsImport(conn, [wr(1), wr(2), wr(3)], names, d, opts());
    expect(r.byBuilding["Alpha House"]).toMatchObject({ seen: 3, inserted: 1, updated: 1, unchanged: 1 });
    expect(d.upsertWorkRequest.mock.calls.map((c) => c[1].WorkRequestID)).toEqual([1, 2]);
    expect(r.runId).toBe(9);
  });

  it("flags a request it cannot map instead of guessing, and never deletes", async () => {
    const d = deps();
    const r = await runMyBuildingsImport(conn, [wr(1, { BuildingName: "Nowhere" }), { BuildingName: "Alpha House" }], names, d, opts());
    expect(r.flags.map((f) => f.kind).sort()).toEqual(["building", "id"]);
    expect(d.upsertWorkRequest).not.toHaveBeenCalled();
    expect(sql().some((s: string) => /\bDELETE\b|\bDROP\b|\bTRUNCATE\b/i.test(s))).toBe(false);
  });

  it("downloads an attachment into blob storage and records its source", async () => {
    const d = deps();
    d.fetchAttachments.mockResolvedValue([{ AttachmentID: 7, Attachment_Name: "leak.png", Attachment_URL: "https://x/leak.png" }]);
    const r = await runMyBuildingsImport(conn, [wr(1)], names, d, opts());
    expect(d.storeBlob).toHaveBeenCalledWith(PNG, "leak.png", "image/png", "attachments/workRequests/1");
    expect(r.totals.attachmentsImported).toBe(1);
    expect(sql().some((s: string) => /INSERT INTO dbo\.MyBuildingsImportAttachments/.test(s))).toBe(true);
    const params = db.executeQuery.mock.calls.find((c: unknown[]) => /INSERT INTO dbo\.Attachments/.test(String(c[1])))![2];
    expect(params.find((p: any) => p.name === "By").value).toBe("myBuildings import");
  });

  it("does not copy an attachment it already holds", async () => {
    db.executeQuery.mockImplementation(async (_c: unknown, text: string) => {
      if (/INSERT INTO dbo\.MyBuildingsImportRuns/.test(text)) return [{ RunId: 9 }];
      if (/MyBuildingsImportAttachments WHERE/.test(text)) return [{ Found: 1 }];
      return [];
    });
    const d = deps();
    d.fetchAttachments.mockResolvedValue([{ AttachmentID: 7, Attachment_Name: "leak.png", Attachment_URL: "https://x/leak.png" }]);
    const r = await runMyBuildingsImport(conn, [wr(1)], names, d, opts());
    expect(r.totals).toMatchObject({ attachmentsSkipped: 1, attachmentsImported: 0 });
    expect(d.downloadAttachment).not.toHaveBeenCalled();
  });

  it("flags a file it refuses and leaves the request unchecked for the next run", async () => {
    const d = deps();
    d.fetchAttachments.mockResolvedValue([{ AttachmentID: 7, Attachment_Name: "x.png", Attachment_URL: "https://x/x.png" }]);
    d.downloadAttachment.mockResolvedValue({ bytes: Buffer.from("<svg/>"), contentType: "image/png" });
    const r = await runMyBuildingsImport(conn, [wr(1)], names, d, opts());
    expect(r.totals.attachmentsFlagged).toBe(1);
    expect(d.storeBlob).not.toHaveBeenCalled();
    expect(sql().some((s: string) => /MERGE dbo\.MyBuildingsImportRequests/.test(s))).toBe(false);
  });

  it("flags an unavailable attachment listing without failing the run", async () => {
    const d = deps();
    d.fetchAttachments.mockRejectedValue(new Error("404"));
    const r = await runMyBuildingsImport(conn, [wr(1)], names, d, opts());
    expect(r.flags[0].kind).toBe("attachment_listing");
    expect(d.upsertWorkRequest).toHaveBeenCalledTimes(1);
  });

  it("bounds attachment work per call and reports what is pending", async () => {
    const d = deps();
    const r = await runMyBuildingsImport(conn, [wr(1), wr(2), wr(3)], names, d, opts({ attachmentLimit: 1 }));
    expect(d.fetchAttachments).toHaveBeenCalledTimes(1);
    expect(r.attachmentsPending).toBe(2);
  });
});
