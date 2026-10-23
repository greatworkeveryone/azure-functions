/// <reference types="jest" />
import { HttpRequest, InvocationContext } from "@azure/functions";
import ExcelJS from "exceljs";
import { TYPES } from "tedious";

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn(), storageQueue: jest.fn(), timer: jest.fn() } };
});
jest.mock("../db", () => ({
  beginTransaction: jest.fn().mockResolvedValue(undefined),
  closeConnection: jest.fn(),
  commitTransaction: jest.fn().mockResolvedValue(undefined),
  createRequestConnection: jest.fn().mockResolvedValue({}),
  createServiceConnection: jest.fn().mockResolvedValue({}),
  executeQuery: jest.fn(),
  rollbackTransaction: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../auth", () => ({
  ...jest.requireActual("../auth"),
  errorResponse: jest.fn().mockReturnValue({ status: 500, jsonBody: { error: "Error" } }),
  extractToken: jest.fn().mockReturnValue("tok"),
  oidFromToken: jest.fn().mockReturnValue("oid-1"),
  requireRole: jest.fn().mockResolvedValue(null),
  unauthorizedResponse: jest.fn().mockReturnValue({ status: 401, jsonBody: {} }),
}));
jest.mock("../blob-storage", () => ({
  keyPhotoReadSasUrl: jest.fn(() => "https://sas"),
  uploadKeyPhotoBlob: jest.fn().mockResolvedValue({ blobName: "keys/x.png", url: "u" }),
}));

type Handler = (req: HttpRequest, ctx: InvocationContext) => Promise<{ status?: number; jsonBody?: any }>;
const db = require("../db") as { executeQuery: jest.Mock };
const auth = require("../auth") as { requireRole: jest.Mock };
const blob = require("../blob-storage") as { uploadKeyPhotoBlob: jest.Mock };
const { app } = require("@azure/functions") as { app: { http: jest.Mock } };
require("./keys");
const registered = (name: string): Handler =>
  (app.http.mock.calls.find((c: unknown[]) => c[0] === name)![1] as { handler: Handler }).handler;
const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;
const json = (b: unknown): HttpRequest =>
  ({ headers: { get: () => null }, json: async () => b, query: new URLSearchParams() }) as unknown as HttpRequest;
const form = (f: FormData): HttpRequest =>
  ({ formData: async () => f, headers: { get: () => null }, query: new URLSearchParams() }) as unknown as HttpRequest;

beforeEach(() => {
  jest.clearAllMocks();
  db.executeQuery.mockReset().mockResolvedValue([]);
  auth.requireRole.mockResolvedValue(null);
});

describe("checkoutKeys ExpectedReturnAt", () => {
  const checkout = registered("checkoutKeys");
  const base = { CheckedOutTo: "Sam", KeyIds: [1] };

  it.each(["01/02/2026", "next week", "2026-02-31", 12345])("400s on %p before touching the DB", async (v) => {
    const res = await checkout(json({ ...base, ExpectedReturnAt: v }), ctx);
    expect(res.status).toBe(400);
    expect(db.executeQuery).not.toHaveBeenCalled();
  });

  it("binds a parsed Date as DateTime2", async () => {
    db.executeQuery.mockImplementation(async (_c: unknown, sql: string) => {
      if (sql.includes("FROM dbo.Keys WITH (UPDLOCK")) return [{ Id: 1, KeyNumber: "A", Status: "active", IsDeleted: 0, ItemType: "code" }];
      if (sql.includes("INSERT INTO dbo.KeyCheckoutBatches")) return [{ Id: 9 }];
      return [];
    });
    await checkout(json({ ...base, ExpectedReturnAt: "2026-02-01T10:00:00.000Z" }), ctx);
    const insert = db.executeQuery.mock.calls.find((c: unknown[]) => String(c[1]).includes("INSERT INTO dbo.KeyCheckoutBatches"))!;
    const param = (insert[2] as { name: string; type: unknown; value: unknown }[]).find((p) => p.name === "ExpectedReturnAt")!;
    expect(param.type).toBe(TYPES.DateTime2);
    expect(param.value).toEqual(new Date("2026-02-01T10:00:00.000Z"));
  });
});

describe("uploadKeyPhoto", () => {
  const upload = registered("uploadKeyPhoto");
  const send = (file: File) => {
    const f = new FormData();
    f.set("photo", file);
    return upload(form(f), ctx);
  };

  it.each(["image/svg+xml", "image/svg+xml; charset=utf-8", "text/html", "application/pdf"])("415s %s", async (type) => {
    expect((await send(new File(["<svg/>"], "a", { type }))).status).toBe(415);
    expect(blob.uploadKeyPhotoBlob).not.toHaveBeenCalled();
  });

  it("415s SVG bytes labelled image/png", async () => {
    expect((await send(new File(["<svg><script/></svg>"], "a.png", { type: "image/png" }))).status).toBe(415);
  });

  it("stores a genuine image under its normalised type", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect((await send(new File([png], "a.png", { type: "IMAGE/PNG; x=1" }))).status).toBe(200);
    expect(blob.uploadKeyPhotoBlob.mock.calls[0][2]).toBe("image/png");
  });
});

describe("keyImportTemplate roles", () => {
  const template = registered("keyImportTemplate");
  const bulk = registered("bulkImportKeys");
  it("is gated on the same roles as bulkImportKeys", async () => {
    const seen: unknown[] = [];
    auth.requireRole.mockImplementation(async (_r: unknown, roles: unknown) => {
      seen.push(roles);
      return { status: 403, jsonBody: {} };
    });
    await template(json({}), ctx);
    await bulk(form(new FormData()), ctx);
    expect(seen[0]).toEqual(seen[1]);
    expect(seen[0]).not.toContain("facilities");
  });
});

describe("bulkImportKeys", () => {
  const importKeys = registered("bulkImportKeys");

  async function sheet(rows: (string | number | ExcelJS.CellValue)[][], numFmt?: string): Promise<HttpRequest> {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Keys");
    ws.addRow(["Item Type", "Building", "Key Number", "Level", "Description", "Tenancy Name"]);
    for (const r of rows) ws.addRow(r as ExcelJS.CellValue[]);
    if (numFmt) ws.eachRow((row, n) => n > 1 && (row.getCell(3).numFmt = numFmt));
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const f = new FormData();
    f.set("file", new File([buf], "keys.xlsx"));
    return form(f);
  }
  const lookups = (sql: string) => {
    if (sql.includes("FROM dbo.Buildings")) return [{ BuildingID: 1, BuildingName: "Tower" }];
    if (sql.includes("FROM dbo.Tenants")) return [{ Id: 4, Name: "Acme Pty" }];
    return [];
  };
  const inserts = (): unknown[][] => db.executeQuery.mock.calls.filter((c: unknown[]) => String(c[1]).includes("INSERT INTO dbo.Keys"));
  const valueOf = (call: unknown[], name: string): unknown =>
    (call[2] as { name: string; value: unknown }[]).find((p) => p.name === name)?.value;

  beforeEach(() => db.executeQuery.mockImplementation(async (_c: unknown, sql: string) => lookups(sql)));

  it("counts whitespace-only rows as skipped but reports partly blank ones", async () => {
    const res = await importKeys(
      await sheet([["key", "Tower", "K1", "", "Front door", ""], ["  ", "", ""], ["", "", "K2", "", "No type or building", ""]]),
      ctx,
    );
    expect(res.jsonBody.created).toBe(1);
    expect(res.jsonBody.skipped).toBe(1);
    expect(res.jsonBody.errors).toEqual([expect.objectContaining({ row: 4 })]);
  });

  it("reads rich-text and formula cells as their text, not [object Object]", async () => {
    await importKeys(
      await sheet([
        ["key", "Tower", { richText: [{ text: "K" }, { text: "7" }] }, "", { formula: "A1", result: "Side door" } as ExcelJS.CellValue, ""],
      ]),
      ctx,
    );
    expect(valueOf(inserts()[0], "KeyNumber")).toBe("K7");
    expect(valueOf(inserts()[0], "Description")).toBe("Side door");
  });

  it("keeps zero padding from a 000 number format", async () => {
    await importKeys(await sheet([["key", "Tower", 7, "", "Cupboard", ""]], "000"), ctx);
    expect(valueOf(inserts()[0], "KeyNumber")).toBe("007");
  });

  it("reports an unknown tenancy instead of silently dropping the link", async () => {
    const res = await importKeys(await sheet([["key", "Tower", "K1", "", "Door", "Nobody Ltd"]]), ctx);
    expect(inserts()).toHaveLength(0);
    expect(res.jsonBody.errors).toEqual([{ row: 2, reason: 'Tenancy "Nobody Ltd" not found' }]);
  });

  it("links a known tenancy", async () => {
    await importKeys(await sheet([["key", "Tower", "K1", "", "Door", "acme pty"]]), ctx);
    expect(valueOf(inserts()[0], "TenancyId")).toBe(4);
  });

  it("rejects more than 2000 rows", async () => {
    const rows = Array.from({ length: 2001 }, (_, i) => ["key", "Tower", `K${i}`, "", "Door", ""]);
    const res = await importKeys(await sheet(rows), ctx);
    expect(res.status).toBe(400);
    expect(inserts()).toHaveLength(0);
  });
});
