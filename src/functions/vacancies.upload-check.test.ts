/// <reference types="jest" />
import { HttpRequest, InvocationContext } from "@azure/functions";

// SECS-05: vacancy images (which feed the public website) are checked by their bytes, not their label.

process.env.AzureWebJobsStorage =
  "DefaultEndpointsProtocol=https;AccountName=rpcctest;AccountKey=abc==;EndpointSuffix=core.windows.net";
delete process.env.VACANCY_IMAGE_ALLOWED_HOSTS;

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
  extractToken: jest.fn().mockReturnValue("tok"),
  requireRole: jest.fn().mockResolvedValue(null),
  unauthorizedResponse: jest.fn().mockReturnValue({ status: 401, jsonBody: {} }),
  verifiedIdentityFromRequest: jest.fn().mockResolvedValue({ email: "a@b", name: "A", oid: "oid-v" }),
}));
jest.mock("../blob-storage", () => ({
  ...jest.requireActual("../blob-storage"),
  deletePublicBlob: jest.fn().mockResolvedValue(undefined),
  uploadPublicBlob: jest.fn(),
  vacanciesReadSasUrl: jest.fn((u: string) => u),
}));

type Handler = (req: HttpRequest, ctx: InvocationContext) => Promise<{ status?: number; jsonBody?: any }>;
const db = require("../db") as { executeQuery: jest.Mock };
const blob = require("../blob-storage") as { deletePublicBlob: jest.Mock; uploadPublicBlob: jest.Mock };
const { app } = require("@azure/functions") as { app: { http: jest.Mock } };
require("./vacancies");
const handlers = new Map(app.http.mock.calls.map((c: unknown[]) => [c[0] as string, (c[1] as { handler: Handler }).handler]));
const registered = (name: string): Handler => handlers.get(name)!;
const ctx = { log: jest.fn(), warn: jest.fn(), error: jest.fn() } as unknown as InvocationContext;

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).buffer as ArrayBuffer;
const HTML = new TextEncoder().encode("<html><script>alert(1)</script></html>").buffer as ArrayBuffer;
const form = (fields: Record<string, string>, bytes: ArrayBuffer, type = "image/png") =>
  ({
    headers: new Headers(),
    formData: async () =>
      new Map<string, unknown>([...Object.entries(fields), ["file", { arrayBuffer: async () => bytes, name: "x.png", size: bytes.byteLength, type }]]),
  }) as unknown as HttpRequest;

beforeEach(() => {
  jest.clearAllMocks();
  blob.uploadPublicBlob.mockResolvedValue({ blobName: "1/new.png", url: "https://x.blob.core.windows.net/vacancies/1/new.png" });
  db.executeQuery.mockResolvedValue([{ SlotImages: JSON.stringify({ Front: "https://x.blob.core.windows.net/vacancies/1/slots/old.png" }), Id: 1 }]);
});

describe.each([
  ["uploadVacancyImage", { vacancyId: "1" }],
  ["uploadVacancySlotImage", { slotLabel: "Front", vacancyId: "1" }],
] as const)("%s", (name, fields) => {
  it("refuses a file whose bytes are not the image it says it is, storing and removing nothing", async () => {
    const res = await registered(name)(form({ ...fields }, HTML), ctx);
    expect(res.status).toBe(415);
    expect(blob.uploadPublicBlob).not.toHaveBeenCalled();
    expect(blob.deletePublicBlob).not.toHaveBeenCalled();
  });

  it("accepts a real PNG", async () => {
    const res = await registered(name)(form({ ...fields }, PNG), ctx);
    expect(res.status ?? 200).toBe(200);
    expect(blob.uploadPublicBlob).toHaveBeenCalledTimes(1);
  });

  it("still refuses a type outside the image list", async () => {
    expect((await registered(name)(form({ ...fields }, PNG, "image/svg+xml"), ctx)).status).toBe(415);
  });
});

describe("slot images are removed only after the row stops pointing at them (SECS-03, F10)", () => {
  const OLD = "https://x.blob.core.windows.net/vacancies/1/slots/old.png";
  const order = (fn: jest.Mock) => fn.mock.invocationCallOrder[0];
  const updateIndex = () => db.executeQuery.mock.calls.findIndex((c: unknown[]) => /UPDATE dbo\.Vacancies/.test(String(c[1])));

  it("replacing a slot image uploads and saves the new one before deleting the old", async () => {
    db.executeQuery.mockImplementation(async (_c: unknown, sql: string) =>
      /SELECT SlotImages/.test(sql) ? [{ SlotImages: JSON.stringify({ Front: OLD }) }] : [{ Id: 1 }],
    );
    await registered("uploadVacancySlotImage")(form({ slotLabel: "Front", vacancyId: "1" }, PNG), ctx);

    expect(blob.deletePublicBlob).toHaveBeenCalledTimes(1);
    expect(order(blob.uploadPublicBlob)).toBeLessThan(order(blob.deletePublicBlob));
    expect(db.executeQuery.mock.invocationCallOrder[updateIndex()]).toBeLessThan(order(blob.deletePublicBlob));
  });

  it("keeps the old image when saving the row fails", async () => {
    db.executeQuery.mockImplementation(async (_c: unknown, sql: string) => {
      if (/SELECT SlotImages/.test(sql)) return [{ SlotImages: JSON.stringify({ Front: OLD }) }];
      if (/UPDATE dbo\.Vacancies/.test(sql)) throw new Error("SQL unavailable");
      return [];
    });
    const res = await registered("uploadVacancySlotImage")(form({ slotLabel: "Front", vacancyId: "1" }, PNG), ctx);

    expect(res.status).toBe(500);
    expect(blob.deletePublicBlob).not.toHaveBeenCalled();
  });

  it("deleting a slot image saves the row before it removes the file, and keeps the file if the save fails", async () => {
    db.executeQuery.mockImplementation(async (_c: unknown, sql: string) => {
      if (/SELECT SlotImages/.test(sql)) return [{ SlotImages: JSON.stringify({ Front: OLD }) }];
      if (/UPDATE dbo\.Vacancies/.test(sql)) throw new Error("SQL unavailable");
      return [];
    });
    const req = { headers: new Headers(), json: async () => ({ slotLabel: "Front", vacancyId: 1 }) } as unknown as HttpRequest;
    const res = await registered("deleteVacancySlotImage")(req, ctx);

    expect(res.status).toBe(500);
    expect(blob.deletePublicBlob).not.toHaveBeenCalled();
  });

  it("deleting a slot image removes the file once the row is saved", async () => {
    db.executeQuery.mockImplementation(async (_c: unknown, sql: string) =>
      /SELECT SlotImages/.test(sql) ? [{ SlotImages: JSON.stringify({ Front: OLD }) }] : [{ Id: 1 }],
    );
    const req = { headers: new Headers(), json: async () => ({ slotLabel: "Front", vacancyId: 1 }) } as unknown as HttpRequest;
    await registered("deleteVacancySlotImage")(req, ctx);

    expect(blob.deletePublicBlob).toHaveBeenCalledTimes(1);
    expect(db.executeQuery.mock.invocationCallOrder[updateIndex()]).toBeLessThan(order(blob.deletePublicBlob));
  });
});
