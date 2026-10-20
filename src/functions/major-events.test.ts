import { HttpRequest, type InvocationContext } from "@azure/functions";
import { AppRole } from "../auth";
import { commitTransaction, executeQuery, rollbackTransaction } from "../db";
import { getMajorEvents, getMajorEvent, createMajorEvent, updateMajorEvent, closeMajorEvent, addMajorEventEntry, getMajorEventDocument } from "./major-events";
jest.mock("@azure/functions", () => ({ ...jest.requireActual("@azure/functions"), app: { http: jest.fn() } }));
let roles: string[] = [];
jest.mock("../auth", () => ({ ...jest.requireActual("../auth"), requireRole: jest.fn(async () => null), rolesForRequest: jest.fn(async () => roles), extractToken: jest.fn(() => "token"), verifiedIdentityFromRequest: jest.fn(async () => ({ name: "Real Staff", oid: "verified-oid" })) }));
jest.mock("../db", () => ({ createRequestConnection: jest.fn(async () => ({})), closeConnection: jest.fn(), executeQuery: jest.fn(), beginTransaction: jest.fn().mockResolvedValue(undefined), commitTransaction: jest.fn().mockResolvedValue(undefined), rollbackTransaction: jest.fn().mockResolvedValue(undefined) }));
jest.mock("../rateLimit", () => ({ checkRateLimit: () => ({ allowed: true }) }));
jest.mock("../blob-storage", () => ({ downloadBlob: jest.fn(), uploadBlob: jest.fn(), deleteBlob: jest.fn() }));
const db = jest.mocked(executeQuery);
const context = { error: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;
const input = { title: "Cyclone", domain: "operational", eventType: "cyclone", ownerName: "Team lead", startsAt: "2026-10-19T08:00:00Z", endsAt: null, brief: "Secure roof access", plan: { buildingIds: [33532], jobIds: [], actions: [] } };
let row: Record<string, unknown>;
const req = (body: unknown = {}, query = "") => new HttpRequest({ method: "POST", url: `http://localhost/api/test${query}`, headers: { "Content-Type": "application/json" }, body: { string: JSON.stringify(body) } });
beforeEach(() => {
  jest.clearAllMocks(); roles = [AppRole.FACILITIES_APPROVAL];
  row = { EventId: 1, Title: "Cyclone", Domain: "operational", EventType: "cyclone", Status: "active", OwnerName: "Lead", StartsAt: new Date(), Brief: "Secure", PlanJson: JSON.stringify(input.plan), Revision: 1 };
  db.mockImplementation(async (_c, sql) => /FROM dbo.MajorEvents/.test(sql) ? [row] : /FROM dbo.Buildings/.test(sql) ? [{ BuildingID: 33532 }] : /OUTPUT INSERTED.EventId/.test(sql) ? [{ EventId: 1 }] : []);
});
it("admin cannot create or close real events even though the generic gate allows admin", async () => {
  roles = [AppRole.ADMIN];
  expect((await createMajorEvent(req(input),context)).status).toBe(403);
  expect((await closeMajorEvent(req({ eventId: 1, revision: 1, reason: "Done" }),context)).status).toBe(403);
  expect(db).not.toHaveBeenCalled();
});
it("CFO cannot declare an operational event; FM cannot declare financial", async () => {
  roles = [AppRole.CFO]; expect((await createMajorEvent(req(input),context)).status).toBe(403);
  roles = [AppRole.FACILITIES_APPROVAL]; expect((await createMajorEvent(req({ ...input, domain: "financial", eventType: "financial" }),context)).status).toBe(403);
});
it("financial event details, entries and documents are unavailable to operational staff", async () => {
  row.Domain = "financial";
  for (const run of [() => getMajorEvent(req({},"?eventId=1"),context), () => addMajorEventEntry(req({ eventId: 1, type: "update", body: "secret" }),context), () => getMajorEventDocument(req({},"?eventId=1&documentId=2"),context)]) expect((await run()).status).toBe(404);
  expect(db.mock.calls.some(([,sql]) => /INSERT/.test(sql))).toBe(false);
});
it("list excludes financial events for ordinary staff in SQL", async () => {
  roles = [AppRole.FACILITIES]; await getMajorEvents(req(),context);
  expect(db.mock.calls[0][2]).toContainEqual(expect.objectContaining({ name: "Financial", value: false }));
});
it("retains verified creator identity and initial plan in the same transaction", async () => {
  expect((await createMajorEvent(req({ ...input, createdBy: "Director" }),context)).status).toBe(201);
  const audit = db.mock.calls.find(([,sql]) => sql.includes("INSERT INTO dbo.MajorEventEntries"));
  expect(audit?.[2]).toEqual(expect.arrayContaining([expect.objectContaining({ name: "Name", value: "Real Staff" }), expect.objectContaining({ name: "Oid", value: "verified-oid" })]));
});
it("rejects stale edits without changing the record", async () => {
  expect((await updateMajorEvent(req({ ...input,eventId: 1, revision: 2 }),context)).status).toBe(409);
  expect(rollbackTransaction).toHaveBeenCalled();
  expect(db.mock.calls.some(([,sql]) => sql.startsWith("UPDATE"))).toBe(false);
});
it("does not allow changing event domain to escape its authority", async () => {
  roles = [AppRole.DIRECTOR];
  expect((await updateMajorEvent(req({ ...input, eventId: 1, revision: 1, domain: "financial", eventType: "financial" }),context)).status).toBe(400);
});
it("closed event cannot accept more updates", async () => {
  row.Status = "closed";
  expect((await addMajorEventEntry(req({ eventId: 1, type: "update", body: "work" }),context)).status).toBe(409);
});
it("rejects a building outside the event", async () => expect((await addMajorEventEntry(req({ eventId: 1, type: "update", body: "work", buildingId: 9 }),context)).status).toBe(400));
it("job links must belong to affected buildings", async () => expect((await createMajorEvent(req({ ...input, plan: { ...input.plan,jobIds: [999] } }),context)).status).toBe(400));

it("removes only the new uploaded blob if the event closes during upload", async () => {
  const { uploadBlob, deleteBlob } = jest.requireMock('../blob-storage');
  uploadBlob.mockResolvedValue({ blobName: 'major-events/1/11111111-1111-4111-8111-111111111111.pdf' });
  deleteBlob.mockResolvedValue(undefined);
  let reads = 0;
  db.mockImplementation(async (_c, sql) => /FROM dbo.MajorEvents/.test(sql) ? [{ ...row, Status: ++reads === 1 ? 'active' : 'closed' }] : []);
  const request = { formData: async () => new Map<string, unknown>([['eventId', '1'], ['file', { type: 'application/pdf', name: 'evidence.pdf', size: 9, arrayBuffer: async () => Buffer.from('%PDF-test') }]]) } as unknown as HttpRequest;
  const { uploadMajorEventDocument } = await import('./major-events');
  expect((await uploadMajorEventDocument(request, context)).status).toBe(409);
  expect(deleteBlob).toHaveBeenCalledWith('major-events/1/11111111-1111-4111-8111-111111111111.pdf');
});
describe("upload cleanup only deletes a file no row references", () => {
  const BLOB = "major-events/1/11111111-1111-4111-8111-111111111111.pdf";
  const uploadRequest = () => ({ formData: async () => new Map<string, unknown>([["eventId", "1"], ["file", { type: "application/pdf", name: "evidence.pdf", size: 9, arrayBuffer: async () => Buffer.from("%PDF-test") }]]) }) as unknown as HttpRequest;
  const isRefCheck = (sql: string) => /FROM dbo.MajorEventDocuments WHERE BlobName=@Blob/.test(sql);
  beforeEach(() => {
    const { uploadBlob, deleteBlob } = jest.requireMock("../blob-storage");
    uploadBlob.mockResolvedValue({ blobName: BLOB });
    deleteBlob.mockResolvedValue(undefined);
  });
  it("deletes the new file when the insert failed and no row references it", async () => {
    const { deleteBlob } = jest.requireMock("../blob-storage");
    db.mockImplementation(async (_c, sql) => { if (/INSERT INTO dbo.MajorEventDocuments/.test(sql)) throw new Error("insert failed"); return /FROM dbo.MajorEvents/.test(sql) ? [row] : []; });
    const { uploadMajorEventDocument } = await import("./major-events");
    expect((await uploadMajorEventDocument(uploadRequest(), context)).status).toBe(500);
    expect(deleteBlob).toHaveBeenCalledWith(BLOB);
  });
  it("keeps the file when COMMIT succeeded but its acknowledgement was lost", async () => {
    const { deleteBlob } = jest.requireMock("../blob-storage");
    db.mockImplementation(async (_c, sql) => isRefCheck(sql) ? [{ DocumentId: 9 }] : /FROM dbo.MajorEvents/.test(sql) ? [row] : []);
    jest.mocked(commitTransaction).mockRejectedValueOnce(new Error("connection reset"));
    const { uploadMajorEventDocument } = await import("./major-events");
    expect((await uploadMajorEventDocument(uploadRequest(), context)).status).toBe(500);
    expect(deleteBlob).not.toHaveBeenCalled();
    expect(context.warn).toHaveBeenCalledWith(expect.stringContaining(BLOB));
  });
  it("keeps the file when the reference check itself fails", async () => {
    const { deleteBlob } = jest.requireMock("../blob-storage");
    db.mockImplementation(async (_c, sql) => { if (/INSERT INTO dbo.MajorEventDocuments/.test(sql)) throw new Error("insert failed"); if (isRefCheck(sql)) throw new Error("connection closed"); return /FROM dbo.MajorEvents/.test(sql) ? [row] : []; });
    const { uploadMajorEventDocument } = await import("./major-events");
    expect((await uploadMajorEventDocument(uploadRequest(), context)).status).toBe(500);
    expect(deleteBlob).not.toHaveBeenCalled();
    expect(context.warn).toHaveBeenCalledWith(expect.stringContaining("reference check failed"));
  });
});
it("rejects a document pointer outside the event's storage namespace before download", async () => {
  const { downloadBlob } = jest.requireMock('../blob-storage');
  db.mockImplementation(async (_c, sql) => /FROM dbo.MajorEvents/.test(sql) ? [row] : /FROM dbo.MajorEventDocuments/.test(sql) ? [{ FileName: 'private.pdf', BlobName: 'major-events/2/11111111-1111-4111-8111-111111111111.pdf' }] : []);
  expect((await getMajorEventDocument(req({}, '?eventId=1&documentId=1'), context)).status).toBe(404);
  expect(downloadBlob).not.toHaveBeenCalled();
});
