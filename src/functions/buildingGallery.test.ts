import { HttpRequest, InvocationContext, app } from "@azure/functions";
import { executeQuery } from "../db";
import { deletePublicBlob, uploadPublicBlob } from "../blob-storage";

jest.mock("@azure/functions", () => ({ app: { http: jest.fn() } }));
jest.mock("../db", () => ({ closeConnection: jest.fn(), createRequestConnection: jest.fn().mockResolvedValue({}), executeQuery: jest.fn() }));
jest.mock("../auth", () => ({ AppRole: { ADMIN: "admin" }, extractToken: () => "test-token", requireRole: jest.fn().mockResolvedValue(null), unauthorizedResponse: () => ({ status: 401 }), errorResponse: () => ({ status: 500 }) }));
jest.mock("../blob-storage", () => ({ ...jest.requireActual("../blob-storage"), deletePublicBlob: jest.fn().mockResolvedValue(undefined), uploadPublicBlob: jest.fn(), vacanciesReadSasUrl: (url: string) => url }));
jest.mock("./getBuildings", () => ({ clearBuildingsCache: jest.fn() }));
import "./buildingGallery";

const handlers = new Map(jest.mocked(app.http).mock.calls.map(([name, options]) => [name, options.handler!]));
const ctx = { log: jest.fn() } as unknown as InvocationContext;
const oldName = "building-hero/-7/11111111-1111-4111-8111-111111111111.jpg";
const newName = "building-hero/-7/22222222-2222-4222-8222-222222222222.jpg";
const url = (name: string) => `https://example.blob.core.windows.net/vacancies/${name}`;
const upload = (id = -7) => ({ headers: new Headers(), formData: async () => new Map<string, unknown>([["buildingId", String(id)], ["file", { type: "image/jpeg", size: 3, name: "photo.jpg", arrayBuffer: async () => new ArrayBuffer(3) }]]) }) as unknown as HttpRequest;
const call = (name: string, request: HttpRequest) => handlers.get(name)!(request, ctx);

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(executeQuery).mockResolvedValue([{ HeroImageUrl: url(oldName) }]);
  jest.mocked(uploadPublicBlob).mockResolvedValue({ blobName: newName, url: url(newName) });
});

it("keeps the old image when the replacement upload fails", async () => {
  jest.mocked(uploadPublicBlob).mockRejectedValueOnce(new Error("Storage unavailable"));
  expect((await call("uploadBuildingHeroImage", upload()))?.status).toBe(500);
  expect(deletePublicBlob).not.toHaveBeenCalled();
});
it("keeps the old image and cleans up the new upload when SQL fails", async () => {
  jest.mocked(executeQuery).mockResolvedValueOnce([{ HeroImageUrl: url(oldName) }]).mockRejectedValueOnce(new Error("SQL unavailable"));
  expect((await call("uploadBuildingHeroImage", upload()))?.status).toBe(500);
  expect(deletePublicBlob).toHaveBeenCalledTimes(1);
  expect(deletePublicBlob).toHaveBeenCalledWith(newName);
});
it("supports negative manual building IDs and removes only the correctly scoped old image after SQL succeeds", async () => {
  await call("uploadBuildingHeroImage", upload());
  expect(uploadPublicBlob).toHaveBeenCalledWith(expect.any(Buffer), "photo.jpg", "image/jpeg", "building-hero/-7");
  expect(deletePublicBlob).toHaveBeenCalledWith(oldName);
  expect(jest.mocked(deletePublicBlob).mock.invocationCallOrder[0]).toBeGreaterThan(jest.mocked(executeQuery).mock.invocationCallOrder[1]);
});
it("never removes another building's image", async () => {
  jest.mocked(executeQuery).mockResolvedValue([{ HeroImageUrl: url(oldName.replace("/-7/", "/33532/")) }]);
  await call("uploadBuildingHeroImage", upload());
  expect(deletePublicBlob).not.toHaveBeenCalled();
});
it("does not upload an orphan for a missing building", async () => {
  jest.mocked(executeQuery).mockResolvedValue([]);
  expect((await call("uploadBuildingHeroImage", upload()))?.status).toBe(404);
  expect(uploadPublicBlob).not.toHaveBeenCalled();
});
it("rejects fractional IDs before touching SQL or storage", async () => {
  expect((await call("uploadBuildingHeroImage", upload(1.5)))?.status).toBe(400);
  expect(executeQuery).not.toHaveBeenCalled();
  expect(uploadPublicBlob).not.toHaveBeenCalled();
});
it("keeps the image when clearing the DB pointer fails", async () => {
  jest.mocked(executeQuery).mockResolvedValueOnce([{ HeroImageUrl: url(oldName) }]).mockRejectedValueOnce(new Error("SQL unavailable"));
  expect((await call("deleteBuildingHeroImage", { json: async () => ({ buildingId: -7 }) } as HttpRequest))?.status).toBe(500);
  expect(deletePublicBlob).not.toHaveBeenCalled();
});
