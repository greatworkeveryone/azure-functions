/// <reference types="jest" />
import { HttpRequest, InvocationContext } from "@azure/functions";

// Image round-trip (SAS echo), reorder permutation rule, and delete ordering.

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
const blob = require("../blob-storage") as { deletePublicBlob: jest.Mock };
const { app } = require("@azure/functions") as { app: { http: jest.Mock } };
const mod = require("./vacancies") as { extractBlobName: (u: string) => string | null; bareVacancyImageUrl: (u: string) => string | null };
const registered = (name: string): Handler =>
  (app.http.mock.calls.find((c: unknown[]) => c[0] === name)![1] as { handler: Handler }).handler;
const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;
const body = (b: unknown): HttpRequest =>
  ({ headers: { get: () => null }, json: async () => b, query: new URLSearchParams() }) as unknown as HttpRequest;

const BASE = "https://rpcctest.blob.core.windows.net/vacancies";
const A = `${BASE}/1/3f2c9a10-5b7e-4d21-9c8a-0e1f2a3b4c5d.jpg`;
const B = `${BASE}/1/4f2c9a10-5b7e-4d21-9c8a-0e1f2a3b4c5d.jpg`;
const SAS = "?sv=2024&sig=abc";

const sqlOf = (): string[] => db.executeQuery.mock.calls.map((c: unknown[]) => String(c[1]));

beforeEach(() => {
  jest.clearAllMocks();
  db.executeQuery.mockReset().mockResolvedValue([]);
  blob.deletePublicBlob.mockResolvedValue(undefined);
});

describe("extractBlobName / bareVacancyImageUrl", () => {
  it("ignore a SAS query", () => {
    expect(mod.extractBlobName(`${A}${SAS}`)).toBe("1/3f2c9a10-5b7e-4d21-9c8a-0e1f2a3b4c5d.jpg");
    expect(mod.bareVacancyImageUrl(`${A}${SAS}#x`)).toBe(A);
    expect(mod.bareVacancyImageUrl("not a url")).toBeNull();
  });
});

describe("reorderVacancyImages", () => {
  const reorder = registered("reorderVacancyImages");

  it("persists bare URLs when the client echoes SAS-signed ones", async () => {
    db.executeQuery
      .mockResolvedValueOnce([{ Images: JSON.stringify([A, B]) }])
      .mockResolvedValueOnce([{ Images: "[]" }])
      .mockResolvedValue([{ Images: JSON.stringify([B, A]) }]);
    const res = await reorder(body({ id: 1, images: [`${B}${SAS}`, `${A}${SAS}`] }), ctx);
    expect(res.status ?? 200).toBe(200);
    const update = db.executeQuery.mock.calls.find((c: unknown[]) => String(c[1]).includes("UPDATE"))!;
    const images = (update[2] as { name: string; value: string }[]).find((p) => p.name === "Images")!.value;
    expect(JSON.parse(images)).toEqual([B, A]);
  });

  it("heals a row that already stores SAS URLs", async () => {
    db.executeQuery.mockResolvedValueOnce([{ Images: JSON.stringify([`${A}${SAS}`, B]) }]).mockResolvedValue([{ Images: "[]" }]);
    const res = await reorder(body({ id: 1, images: [B, A] }), ctx);
    expect(res.status ?? 200).toBe(200);
  });

  it.each([
    ["adds an image", [A, B, `${BASE}/1/5f2c9a10-5b7e-4d21-9c8a-0e1f2a3b4c5d.jpg`]],
    ["removes an image", [A]],
    ["duplicates an image", [A, A]],
  ])("400s when the reorder %s", async (_l, images) => {
    db.executeQuery.mockResolvedValueOnce([{ Images: JSON.stringify([A, B]) }]);
    const res = await reorder(body({ id: 1, images }), ctx);
    expect(res.status).toBe(400);
    expect(sqlOf().some((q) => q.includes("UPDATE"))).toBe(false);
  });

  it("404s an unknown vacancy", async () => {
    const res = await reorder(body({ id: 9, images: [A] }), ctx);
    expect(res.status).toBe(404);
  });
});

describe("deleteVacancyImage", () => {
  const del = registered("deleteVacancyImage");

  it("deletes an image addressed by its SAS-signed URL", async () => {
    db.executeQuery
      .mockResolvedValueOnce([{ Images: JSON.stringify([A, B]) }])
      .mockResolvedValue([{ Images: JSON.stringify([B]) }]);
    const res = await del(body({ id: 1, imageUrl: `${A}${SAS}` }), ctx);
    expect(res.status ?? 200).toBe(200);
    expect(blob.deletePublicBlob).toHaveBeenCalledWith("1/3f2c9a10-5b7e-4d21-9c8a-0e1f2a3b4c5d.jpg");
    const update = db.executeQuery.mock.calls.find((c: unknown[]) => String(c[1]).includes("UPDATE"))!;
    expect(JSON.parse((update[2] as { name: string; value: string }[])[0].value)).toEqual([B]);
  });

  it("404s an image the vacancy does not hold", async () => {
    db.executeQuery.mockResolvedValueOnce([{ Images: JSON.stringify([B]) }]);
    const res = await del(body({ id: 1, imageUrl: `${A}${SAS}` }), ctx);
    expect(res.status).toBe(404);
    expect(blob.deletePublicBlob).not.toHaveBeenCalled();
  });
});

describe("deleteVacancy ordering", () => {
  const del = registered("deleteVacancy");
  const row = (wp: number | null) => [{ Images: JSON.stringify([A]), SlotImages: JSON.stringify({ hero: B }), WordPressPostId: wp }];

  beforeEach(() => {
    process.env.WORDPRESS_API_URL = "https://wp.example/wp-json";
    process.env.WORDPRESS_USERNAME = "u";
    process.env.WORDPRESS_APP_PASSWORD = "p";
  });

  it("502s and keeps the record and blobs when the WordPress unpublish fails", async () => {
    db.executeQuery.mockResolvedValueOnce(row(77));
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500 }) as unknown as typeof fetch;
    const res = await del(body({ id: 1 }), ctx);
    expect(res.status).toBe(502);
    expect(sqlOf().some((q) => q.includes("DELETE"))).toBe(false);
    expect(blob.deletePublicBlob).not.toHaveBeenCalled();
  });

  it("502s on a network failure too", async () => {
    db.executeQuery.mockResolvedValueOnce(row(77));
    global.fetch = jest.fn().mockRejectedValue(new Error("ECONNRESET")) as unknown as typeof fetch;
    expect((await del(body({ id: 1 }), ctx)).status).toBe(502);
  });

  it("deletes the row before any blob, then removes image and slot blobs", async () => {
    const order: string[] = [];
    db.executeQuery.mockImplementation(async (_c: unknown, sql: string) => {
      if (sql.includes("DELETE")) order.push("row");
      return sql.includes("SELECT") ? row(77) : [];
    });
    blob.deletePublicBlob.mockImplementation(async () => { order.push("blob"); });
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 }) as unknown as typeof fetch;
    const res = await del(body({ id: 1 }), ctx);
    expect(res.status).toBe(200);
    expect(order).toEqual(["row", "blob", "blob"]);
  });

  it("still succeeds when a blob delete fails after the row is gone", async () => {
    db.executeQuery.mockImplementation(async (_c: unknown, sql: string) => (sql.includes("SELECT") ? row(null) : []));
    blob.deletePublicBlob.mockRejectedValue(new Error("blob down"));
    expect((await del(body({ id: 1 }), ctx)).status).toBe(200);
  });
});
