/// <reference types="jest" />
import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import ExcelJS from "exceljs";

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn() } };
});

jest.mock("../auth", () => {
  const actual = jest.requireActual("../auth");
  return {
    ...actual,
    errorResponse: jest.fn().mockReturnValue({ jsonBody: { error: "Error" }, status: 500 }),
    extractToken: jest.fn().mockReturnValue("mock-token"),
    oidFromToken: jest.fn().mockReturnValue("oid-officer"),
    requireRole: jest.fn().mockResolvedValue(null),
    unauthorizedResponse: jest.fn().mockReturnValue({ jsonBody: { error: "Unauthorized" }, status: 401 }),
    verifiedIdentityFromRequest: jest.fn().mockResolvedValue({ email: "o@rp.com", name: "Officer", oid: "oid-officer" }),
  };
});

jest.mock("../db", () => ({
  closeConnection: jest.fn(),
  createRequestConnection: jest.fn().mockResolvedValue({}),
  createServiceConnection: jest.fn().mockResolvedValue({}),
  executeQuery: jest.fn().mockResolvedValue([]),
}));

jest.mock("../blob-storage", () => ({
  keyPhotoReadSasUrl: jest.fn((blob: string) => `https://photo.example/${blob}`),
  uploadKeyPhotoBlob: jest.fn().mockResolvedValue({ blobName: "keys/abc.png", url: "https://blob.example/abc.png" }),
}));
jest.mock("../keyPlannerSync", () => ({ syncKeyLostReportedStandalone: jest.fn() }));

import { AppRole } from "../auth";
import { CHECKIN_KEYS_ROLES, CHECKOUT_KEYS_ROLES } from "../keyRoles";
import "../functions/keys";
import "../functions/uploadKeySignature";

const handlers = new Map<string, (request: HttpRequest, context: InvocationContext) => Promise<HttpResponseInit>>(
  (app.http as unknown as jest.Mock).mock.calls.map(
    ([name, options]: [string, { handler: (request: HttpRequest, context: InvocationContext) => Promise<HttpResponseInit> }]) => [name, options.handler],
  ),
);

const auth = require("../auth") as { extractToken: jest.Mock; requireRole: jest.Mock; verifiedIdentityFromRequest: jest.Mock };
const db = require("../db") as { executeQuery: jest.Mock };
const blob = require("../blob-storage") as { uploadKeyPhotoBlob: jest.Mock };
const realAuth = jest.requireActual("../auth") as typeof import("../auth");

const context = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;
const FORBIDDEN = { jsonBody: { error: "Forbidden" }, status: 403 };

const jsonRequest = (body: unknown, query: Record<string, string> = {}): HttpRequest =>
  ({ headers: { get: () => null }, json: async () => body, query: { get: (k: string) => query[k] ?? null } }) as unknown as HttpRequest;

const formRequest = (fields: Record<string, unknown>): HttpRequest =>
  ({ formData: async () => ({ get: (k: string) => fields[k] ?? null }), headers: { get: () => null } }) as unknown as HttpRequest;

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** A file of `bytes` length; a PNG starts with the PNG signature unless `magic` says otherwise. */
function fileOf(bytes: number, type = "image/png", name = "signature.png", magic: number[] = PNG_MAGIC) {
  const data = new Uint8Array(bytes);
  magic.forEach((byte, i) => {
    if (i < bytes) data[i] = byte;
  });
  return { arrayBuffer: async () => data.buffer, name, size: bytes, type };
}

/** Answers executeQuery by what the SQL is about, so a handler's order of queries can change without breaking tests. */
function answer(routes: Array<[RegExp, unknown[] | ((params: Array<{ name: string; value: unknown }>) => unknown[])]>) {
  db.executeQuery.mockImplementation(async (_conn: unknown, sql: string, params: Array<{ name: string; value: unknown }> = []) => {
    for (const [pattern, rows] of routes) if (pattern.test(sql)) return typeof rows === "function" ? rows(params) : rows;
    return [];
  });
}
const paramOf = (call: unknown[], name: string) => (call[2] as Array<{ name: string; value: unknown }>).find((p) => p.name === name)?.value;
const sqlCalls = (pattern: RegExp) => db.executeQuery.mock.calls.filter((call) => pattern.test(call[1] as string));

beforeEach(() => {
  jest.clearAllMocks();
  auth.extractToken.mockReturnValue("mock-token");
  auth.requireRole.mockResolvedValue(null);
  auth.verifiedIdentityFromRequest.mockResolvedValue({ email: "o@rp.com", name: "Officer", oid: "oid-officer" });
  db.executeQuery.mockResolvedValue([]);
});

describe("field officers can check keys out and in", () => {
  it("gates check-out and check-in on their own lists, which are not manager-only", async () => {
    auth.requireRole.mockResolvedValue(FORBIDDEN);
    expect((await handlers.get("checkoutKeys")!(jsonRequest({}), context)).status).toBe(403);
    expect(auth.requireRole).toHaveBeenLastCalledWith(expect.anything(), CHECKOUT_KEYS_ROLES);
    expect((await handlers.get("checkinKeys")!(jsonRequest({}), context)).status).toBe(403);
    expect(auth.requireRole).toHaveBeenLastCalledWith(expect.anything(), CHECKIN_KEYS_ROLES);
  });

  it("the real role check lets facilities through, along with managers, directors and admin, and nobody else", async () => {
    // The X-Dev-Roles header only counts when the host positively says it is a
    // local Development run and is not an Azure-hosted app (src/jwt.ts).
    const names = ["DEV_ROLE_OVERRIDE_ENABLED", "AZURE_FUNCTIONS_ENVIRONMENT", "WEBSITE_INSTANCE_ID"] as const;
    const original = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    process.env.DEV_ROLE_OVERRIDE_ENABLED = "true";
    process.env.AZURE_FUNCTIONS_ENVIRONMENT = "Development";
    delete process.env.WEBSITE_INSTANCE_ID;
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const admitted = async (gate: readonly AppRole[]) => {
        const result: string[] = [];
        for (const role of ["admin", "director", "facilities_manager", "facilities", "accounts_manager", "accounts", "user", "(no role)"]) {
          const headers: Record<string, string> = role === "(no role)" ? {} : { "x-dev-roles": role };
          const request = { headers: { get: (key: string) => headers[key.toLowerCase()] ?? null } } as unknown as HttpRequest;
          if ((await realAuth.requireRole(request, gate)) === null) result.push(role);
        }
        return result;
      };
      const expected = ["admin", "director", "facilities_manager", "facilities"];
      expect(await admitted(CHECKOUT_KEYS_ROLES)).toEqual(expected);
      expect(await admitted(CHECKIN_KEYS_ROLES)).toEqual(expected);
    } finally {
      jest.restoreAllMocks();
      for (const name of names) {
        const before = original[name];
        if (before === undefined) delete process.env[name];
        else process.env[name] = before;
      }
    }
  });
});

describe("uploadKeySignature", () => {
  const upload = (fields: Record<string, unknown>) => handlers.get("uploadKeySignature")!(formRequest(fields), context);
  const insertedAttachment = [{ Id: 55 }];

  it("answers 401 with no token and 403 for a role that cannot check keys out", async () => {
    auth.extractToken.mockReturnValue(null);
    expect((await upload({})).status).toBe(401);
    auth.extractToken.mockReturnValue("mock-token");
    auth.requireRole.mockResolvedValue(FORBIDDEN);
    expect((await upload({ file: fileOf(100) })).status).toBe(403);
    expect(auth.requireRole).toHaveBeenLastCalledWith(expect.anything(), CHECKOUT_KEYS_ROLES);
    expect(blob.uploadKeyPhotoBlob).not.toHaveBeenCalled();
  });

  it("wants a file", async () => {
    expect((await upload({})).status).toBe(400);
  });

  it("takes a PNG and nothing else", async () => {
    expect((await upload({ file: fileOf(100, "image/jpeg", "s.jpg") })).status).toBe(415);
    expect((await upload({ file: fileOf(100, "application/pdf", "s.pdf") })).status).toBe(415);
    expect(blob.uploadKeyPhotoBlob).not.toHaveBeenCalled();
  });

  it("refuses a file that says it is a PNG but is not", async () => {
    expect((await upload({ file: fileOf(100, "image/png", "signature.png", [0x3c, 0x68, 0x74, 0x6d, 0x6c]) })).status).toBe(415);
    expect(blob.uploadKeyPhotoBlob).not.toHaveBeenCalled();
  });

  it("refuses a signature bigger than 1 MB", async () => {
    expect((await upload({ file: fileOf(1024 * 1024 + 1) })).status).toBe(413);
    expect(blob.uploadKeyPhotoBlob).not.toHaveBeenCalled();
  });

  it("keeps the PNG in the permanent key-photos store with the handover photos, not the transient attachments store", async () => {
    answer([[/INSERT INTO dbo\.Attachments/, insertedAttachment]]);
    await upload({ file: fileOf(2048) });
    expect(blob.uploadKeyPhotoBlob).toHaveBeenCalledTimes(1);
  });

  it("stores the PNG as an attachment owned by the person who drew it, and returns its id", async () => {
    answer([[/INSERT INTO dbo\.Attachments/, insertedAttachment]]);
    const response = await upload({ file: fileOf(2048) });
    expect(response.status).toBe(200);
    expect(response.jsonBody).toEqual({ attachmentId: 55 });
    expect(blob.uploadKeyPhotoBlob).toHaveBeenCalledWith(expect.any(Buffer), "signature.png", "image/png");
    const [insert] = sqlCalls(/INSERT INTO dbo\.Attachments/);
    expect(paramOf(insert, "UploadedBy")).toBe("oid-officer");
    expect(paramOf(insert, "ContentType")).toBe("image/png");
    expect(paramOf(insert, "BlobName")).toBe("keys/abc.png");
  });

  it("does not need a work request or a job, so the attachment reaper never touches it", async () => {
    answer([[/INSERT INTO dbo\.Attachments/, insertedAttachment]]);
    await upload({ file: fileOf(2048) });
    const [insert] = sqlCalls(/INSERT INTO dbo\.Attachments/);
    expect(insert[1]).not.toMatch(/WorkRequestID|JobID/);
  });
});

describe("checkoutKeys with a signature", () => {
  const checkout = (body: Record<string, unknown>) =>
    handlers.get("checkoutKeys")!(
      jsonRequest({ CheckOutPhotoBlobUrl: "keys/p.jpg", CheckedOutTo: "Sam Contractor", ExpectedReturnAt: "2026-10-20T00:00:00Z", KeyIds: [4], ...body }),
      context,
    );
  const baseRoutes: Array<[RegExp, unknown[]]> = [
    [/FROM dbo\.Keys WHERE Id IN/, [{ Id: 4, IsDeleted: 0, KeyNumber: "K-004", Status: "active" }]],
    [/INSERT INTO dbo\.KeyCheckoutBatches/, [{ Id: 90 }]],
  ];
  const signatureRow = (over: Record<string, unknown> = {}) => ({
    BlobName: "keys/abc.png", ContentType: "image/png", Id: 55, LinkedBatchId: null, UploadedBy: "oid-officer", ...over,
  });

  it("links the signature to the new batch", async () => {
    answer([...baseRoutes, [/FROM dbo\.Attachments/, [signatureRow()]]]);
    const response = await checkout({ SignatureAttachmentId: 55 });
    expect(response.status).toBe(200);
    expect(response.jsonBody).toEqual({ batchId: 90 });
    const [insert] = sqlCalls(/INSERT INTO dbo\.KeyCheckoutBatches/);
    expect(insert[1]).toContain("SignatureAttachmentId");
    expect(paramOf(insert, "SignatureAttachmentId")).toBe(55);
  });

  it("still works without one, as every client did until now", async () => {
    answer(baseRoutes);
    const response = await checkout({});
    expect(response.status).toBe(200);
    const [insert] = sqlCalls(/INSERT INTO dbo\.KeyCheckoutBatches/);
    expect(paramOf(insert, "SignatureAttachmentId")).toBeNull();
    expect(sqlCalls(/FROM dbo\.Attachments/)).toHaveLength(0);
  });

  it.each([
    ["does not exist", []],
    ["was uploaded by somebody else", [signatureRow({ UploadedBy: "oid-someone-else" })]],
    ["is not a PNG", [signatureRow({ ContentType: "application/pdf" })]],
    ["is a file from somewhere else in the system", [signatureRow({ BlobName: "attachments/jobs/9/secret.png" })]],
  ])("refuses a signature that %s, before creating anything", async (_why, rows) => {
    answer([...baseRoutes, [/FROM dbo\.Attachments/, rows]]);
    const response = await checkout({ SignatureAttachmentId: 55 });
    expect(response.status).toBe(400);
    expect((response.jsonBody as { code: string }).code).toBe("SIGNATURE_INVALID");
    expect(sqlCalls(/INSERT INTO dbo\.KeyCheckoutBatches/)).toHaveLength(0);
  });

  it("refuses a signature that already belongs to another handover", async () => {
    answer([...baseRoutes, [/FROM dbo\.Attachments/, [signatureRow({ LinkedBatchId: 12 })]]]);
    const response = await checkout({ SignatureAttachmentId: 55 });
    expect(response.status).toBe(409);
    expect((response.jsonBody as { code: string }).code).toBe("SIGNATURE_ALREADY_USED");
    expect(sqlCalls(/INSERT INTO dbo\.KeyCheckoutBatches/)).toHaveLength(0);
  });

  it("refuses a signature id that is not a whole number", async () => {
    answer(baseRoutes);
    expect((await checkout({ SignatureAttachmentId: "55; DROP" })).status).toBe(400);
    expect(sqlCalls(/INSERT INTO dbo\.KeyCheckoutBatches/)).toHaveLength(0);
  });
});

describe("a key's history shows the signature", () => {
  const detail = () => handlers.get("getKeyDetail")!(jsonRequest(null, { id: "4" }), context);
  const routes = (batch: Record<string, unknown>): Array<[RegExp, unknown[]]> => [
    [/FROM dbo\.Keys k/, [{ BuildingName: "Tower A", Id: 4, IsDeleted: 0, KeyNumber: "K-004", Status: "active" }]],
    [/FROM dbo\.KeyCheckoutBatches kb/, [{ BatchId: 90, CheckedOutAt: new Date("2026-10-14"), CheckedOutBy: "Officer", CheckedOutTo: "Sam", IsOverdue: 0, ...batch }]],
    [/SELECT kco\.Id/, [{ BatchId: 90, CheckedInAt: null, Id: 1, KeyId: 4 }]],
  ];

  it("gives each handover a link to its signature", async () => {
    answer(routes({ SignatureBlobName: "keys/abc.png" }));
    const response = await detail();
    const history = (response.jsonBody as { key: { history: Array<{ signatureUrl: string | null }> } }).key.history;
    expect(history[0].signatureUrl).toBe("https://photo.example/keys/abc.png");
    const [batchQuery] = sqlCalls(/FROM dbo\.KeyCheckoutBatches kb/);
    expect(batchQuery[1]).toMatch(/LEFT JOIN dbo\.Attachments/);
  });

  it("says null for a handover with no signature", async () => {
    answer(routes({ SignatureBlobName: null }));
    const history = ((await detail()).jsonBody as { key: { history: Array<{ signatureUrl: string | null }> } }).key.history;
    expect(history[0].signatureUrl).toBeNull();
  });

  it("is only for people who can open a key's history, and is not in the key list", async () => {
    auth.requireRole.mockResolvedValue(FORBIDDEN);
    expect((await detail()).status).toBe(403);
    auth.requireRole.mockResolvedValue(null);
    answer([[/FROM dbo\.Keys k/, []]]);
    await handlers.get("getKeys")!(jsonRequest(null), context);
    const [listQuery] = sqlCalls(/FROM dbo\.Keys k/);
    expect(listQuery[1]).not.toMatch(/Signature|dbo\.Attachments/);
  });
});

describe("storage location is free text", () => {
  it("accepts a key stored anywhere when registering it", async () => {
    answer([[/INSERT INTO dbo\.Keys/, [{ Id: 9 }]], [/FROM dbo\.Keys k/, [{ BuildingName: "Tower A", Id: 9, IsDeleted: 0, KeyNumber: "K-9", Status: "active" }]]]);
    const response = await handlers.get("createKey")!(
      jsonRequest({ BuildingId: 1, Description: "Plant room", KeyNumber: "K-9", Level: "L1", StorageLocation: "Cabinet B, hook 14" }),
      context,
    );
    expect(response.status).toBe(200);
    const [insert] = sqlCalls(/INSERT INTO dbo\.Keys/);
    expect(paramOf(insert, "StorageLocation")).toBe("Cabinet B, hook 14");
  });

  it("the import template no longer offers a fixed list of rooms", async () => {
    answer([[/FROM dbo\.Buildings/, [{ BuildingName: "Tower A" }]]]);
    const response = await handlers.get("keyImportTemplate")!(jsonRequest(null), context);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(response.body as unknown as ExcelJS.Buffer);
    expect(wb.worksheets.map((sheet) => sheet.name)).not.toContain("_StorageLocations");
    const info: string[] = [];
    wb.getWorksheet("Info")!.eachRow((row) => info.push(row.values ? String(row.values) : ""));
    expect(info.join("\n")).not.toContain("Harry Potter");
    expect(info.join("\n")).toContain("Storage Location");
  });
});

describe("Location is optional", () => {
  it("lets a key be registered with no level, for a building that has none", async () => {
    answer([[/INSERT INTO dbo\.Keys/, [{ Id: 9 }]], [/FROM dbo\.Keys k/, [{ BuildingName: "House", Id: 9, IsDeleted: 0, KeyNumber: "K-9", Status: "active" }]]]);
    const response = await handlers.get("createKey")!(jsonRequest({ BuildingId: 1, Description: "Front door", KeyNumber: "K-9" }), context);
    expect(response.status).toBe(200);
    const [insert] = sqlCalls(/INSERT INTO dbo\.Keys/);
    expect(paramOf(insert, "Level")).toBe("");
  });

  it("still wants a building, a key number and a description", async () => {
    expect((await handlers.get("createKey")!(jsonRequest({ BuildingId: 1, KeyNumber: "K-9" }), context)).status).toBe(400);
    expect((await handlers.get("createKey")!(jsonRequest({ Description: "x", KeyNumber: "K-9" }), context)).status).toBe(400);
  });
});

describe("bulk import", () => {
  async function workbookOf(rows: string[][]): Promise<ArrayBuffer> {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Keys");
    ws.addRow(["Item Type", "Building", "Key Number", "Level", "Description", "Sub Type", "Tenancy Name", "Registration", "Storage Location"]);
    rows.forEach((row) => ws.addRow(row));
    const out = await wb.xlsx.writeBuffer();
    return out as ArrayBuffer;
  }
  const importFile = async (rows: string[][], sizeOverride?: number) => {
    const buffer = await workbookOf(rows);
    return handlers.get("bulkImportKeys")!(
      formRequest({ file: { arrayBuffer: async () => buffer, name: "keys.xlsx", size: sizeOverride ?? buffer.byteLength, type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" } }),
      context,
    );
  };
  const routes: Array<[RegExp, unknown[]]> = [
    [/FROM dbo\.Buildings/, [{ BuildingID: 1, BuildingName: "Tower A" }]],
    [/FROM dbo\.Tenants/, []],
  ];

  it("refuses a file over 10 MB with a sentence, before reading it", async () => {
    answer(routes);
    const response = await importFile([["key", "Tower A", "K-1", "L1", "Door"]], 10 * 1024 * 1024 + 1);
    expect(response.status).toBe(413);
    expect((response.jsonBody as { error: string }).error).toMatch(/10 MB/);
    expect(db.executeQuery).not.toHaveBeenCalled();
  });

  it("takes a file at the limit", async () => {
    answer(routes);
    const response = await importFile([["key", "Tower A", "K-1", "L1", "Door"]], 10 * 1024 * 1024);
    expect(response.status).toBe(200);
  });

  it("accepts any storage location and a blank level", async () => {
    answer(routes);
    const response = await importFile([["key", "Tower A", "K-1", "", "Front door", "", "", "", "Cabinet B, hook 14"]]);
    expect(response.status).toBe(200);
    expect(response.jsonBody).toMatchObject({ created: 1, errors: [] });
    const [insert] = sqlCalls(/INSERT INTO dbo\.Keys/);
    expect(paramOf(insert, "StorageLocation")).toBe("Cabinet B, hook 14");
    expect(paramOf(insert, "Level")).toBe("");
  });
});
