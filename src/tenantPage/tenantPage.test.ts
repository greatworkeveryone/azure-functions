/// <reference types="jest" />
import { InvocationContext, type HttpRequest } from "@azure/functions";
import { crc32 } from "node:zlib";

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn(), timer: jest.fn() } };
});
jest.mock("../db", () => ({
  beginTransaction: jest.fn().mockResolvedValue(undefined),
  closeConnection: jest.fn(),
  commitTransaction: jest.fn().mockResolvedValue(undefined),
  createServiceRequestConnection: jest.fn().mockResolvedValue({}),
  executeQuery: jest.fn(),
  rollbackTransaction: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../tenantLinks/resolve", () => ({ resolveTenantLink: jest.fn() }));
jest.mock("../blob-storage", () => ({ uploadTenantQuarantineBlob: jest.fn().mockResolvedValue({ blobName: "tenant-requests/7/x.png", url: "" }) }));

import { resetFeatureFlagCache } from "../features/flags";
import { ledgerInserts } from "../__tests__/fixtures/ledgerCalls";
import { tenantContext } from "../functions/tenantContext";
import { tenantListRequests } from "../functions/tenantListRequests";
import { tenantSubmitRequest } from "../functions/tenantSubmitRequest";
import { tenantUploadPhoto } from "../functions/tenantUploadPhoto";
import { sniffImage } from "./imageSniff";
import { resetTenantLimiter } from "./limiter";
import { parseSubmit } from "./submit";
import { timelineFor } from "./timeline";
import { rulesTriage } from "./triage";
import { newToken } from "../tenantLinks/token";

export {};
const db = require("../db") as { executeQuery: jest.Mock };
const resolver = require("../tenantLinks/resolve") as { resolveTenantLink: jest.Mock };
const blobs = require("../blob-storage") as { uploadTenantQuarantineBlob: jest.Mock };
const context = new InvocationContext();

const TOKEN_A = newToken();
const TOKEN_B = newToken();
const A = { buildingId: 5, contactId: 11, tenantId: 1 };
const B = { buildingId: 6, contactId: 22, tenantId: 2 };

let flagOn = true;
const call = (sql: string) => db.executeQuery.mock.calls.map((c) => ({ params: (c[2] ?? []) as { name: string; value: unknown }[], sql: String(c[1]) })).filter((c) => c.sql.includes(sql));

interface Opts { body?: unknown; bytes?: Buffer; headers?: Record<string, string>; ip?: string; token?: string | null; url?: string }
function req(opts: Opts = {}): HttpRequest {
  const headers = new Headers({ "x-forwarded-for": opts.ip ?? "203.0.113.7", ...(opts.headers ?? {}) });
  if (opts.token !== null) headers.set("x-tenant-link", opts.token ?? TOKEN_A);
  const text = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body ?? {});
  const bytes = opts.bytes ?? Buffer.from(text);
  return {
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
    headers, query: new URLSearchParams(), text: async () => text, url: opts.url ?? "https://api.test/api/x",
  } as unknown as HttpRequest;
}

const WHO = { BuildingName: "Tower One", ContactName: "Pat", Email: "pat@acme.test", Levels: '["Level 3"]', Phone: "0400 000 000", ReportsIssues: true, TenantName: "Acme Pty Ltd" };
let whoRow: Record<string, unknown> | null = WHO;
let ownedRows: unknown[] = [{ WorkRequestID: -7 }];
let photoCount = 0;
let emergencyRows: unknown[] = [{ EmergencyPhone: "1800 555 000" }];

beforeEach(() => {
  jest.clearAllMocks();
  resetFeatureFlagCache();
  resetTenantLimiter();
  flagOn = true;
  whoRow = WHO;
  ownedRows = [{ WorkRequestID: -7 }];
  photoCount = 0;
  emergencyRows = [{ EmergencyPhone: "1800 555 000" }];
  resolver.resolveTenantLink.mockImplementation(async (token: string) => (token === TOKEN_A ? A : token === TOKEN_B ? B : null));
  db.executeQuery.mockImplementation(async (_c: unknown, sql: string) => {
    if (sql.includes("FROM dbo.FeatureFlags")) return flagOn ? [{ FeatureKey: "tenantPage", RoleName: "tenant", Visibility: "enabled" }] : [];
    if (sql.includes("SELECT EmergencyPhone FROM dbo.Buildings")) return emergencyRows;
    if (sql.includes("JOIN dbo.TenancyContacts c")) return whoRow ? [whoRow] : [];
    if (sql.includes("COL_LENGTH")) return [{ Len: null }];
    if (sql.includes("INSERT INTO WorkRequests")) return [{ WorkRequestID: -7 }];
    if (sql.includes("COUNT(*) AS N FROM dbo.WorkRequests")) return [{ N: 0 }];
    if (sql.includes("FROM dbo.TenantRequestPhotos")) return [{ N: photoCount }];
    if (sql.includes("ClientRequestId = @Key")) return [];
    if (sql.includes("SELECT WorkRequestID FROM dbo.WorkRequests")) return ownedRows;
    return [];
  });
});

const GOOD = { category: "plumbing", description: "The tap in the kitchen is leaking onto the floor", urgency: "urgent" };
const bodyOf = (r: { jsonBody?: unknown }) => JSON.stringify(r.jsonBody);

describe("the link gate", () => {
  it("answers one identical 404 for no header, a malformed token, an unknown token, and a switched-off page", async () => {
    const none = await tenantContext(req({ ip: "198.51.100.1", token: null }), context);
    const bad = await tenantContext(req({ ip: "198.51.100.2", token: "short" }), context);
    const unknown = await tenantContext(req({ ip: "198.51.100.3", token: newToken() }), context);
    flagOn = false;
    resetFeatureFlagCache();
    const off = await tenantContext(req({ ip: "198.51.100.4" }), context);
    for (const r of [none, bad, unknown, off]) expect(r.status).toBe(404);
    expect(new Set([none, bad, unknown, off].map(bodyOf)).size).toBe(1);
  });

  it("reads the token from the header only: a token in the URL or query is not a link", async () => {
    const r = await tenantContext(req({ ip: "198.51.100.5", token: null, url: `https://api.test/api/tenantContext?token=${TOKEN_A}&t=${TOKEN_A}` }), context);
    expect(r.status).toBe(404);
    expect(resolver.resolveTenantLink).not.toHaveBeenCalled();
  });

  it("does not resolve (so records no use) while the tenantPage flag is off", async () => {
    flagOn = false;
    expect((await tenantContext(req({ ip: "198.51.100.6" }), context)).status).toBe(404);
    expect(resolver.resolveTenantLink).not.toHaveBeenCalled();
  });

  it("turns a client away with 429 after ten failed links, even before it presents a good one", async () => {
    const ip = "198.51.100.9";
    for (let i = 0; i < 10; i += 1) expect((await tenantContext(req({ ip, token: newToken() }), context)).status).toBe(404);
    const blocked = await tenantContext(req({ ip, token: TOKEN_A }), context);
    expect(blocked.status).toBe(429);
    expect(blocked.headers).toMatchObject({ "Retry-After": expect.any(String) });
    expect((await tenantContext(req({ ip: "198.51.100.10", token: TOKEN_A }), context)).status).toBe(200);
  });

  it("limits each link: the ninth submission in ten minutes is 429", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 9; i += 1) codes.push((await tenantSubmitRequest(req({ body: GOOD, ip: `192.0.2.${i + 20}` }), context)).status ?? 0);
    expect(codes.slice(0, 8)).toEqual(Array(8).fill(201));
    expect(codes[8]).toBe(429);
  });

  it("answers a generic 500 that carries neither the token nor the error text", async () => {
    db.executeQuery.mockImplementation(async (_c: unknown, sql: string) => {
      if (sql.includes("FROM dbo.FeatureFlags")) return [{ FeatureKey: "tenantPage", RoleName: "tenant", Visibility: "enabled" }];
      throw new Error(`secret sql failure ${TOKEN_A}`);
    });
    const r = await tenantContext(req({ ip: "198.51.100.11" }), context);
    expect(r.status).toBe(500);
    expect(bodyOf(r)).not.toContain("secret");
    expect(bodyOf(r)).not.toContain(TOKEN_A);
  });

  it("marks every answer no-store", async () => {
    expect((await tenantContext(req({ ip: "198.51.100.12" }), context)).headers).toMatchObject({ "Cache-Control": "no-store" });
    expect((await tenantContext(req({ ip: "198.51.100.13", token: null }), context)).headers).toMatchObject({ "Cache-Control": "no-store" });
  });
});

describe("tenancy scope: one tenancy's link cannot reach another's", () => {
  it("submit ignores tenantId, buildingId and contactId in the body and reads who/where by the link's identity", async () => {
    const r = await tenantSubmitRequest(req({ body: { ...GOOD, buildingId: 6, contactId: 22, tenantId: 2, SourceTenantId: 2 } }), context);
    expect(r.status).toBe(201);
    for (const c of [...call("JOIN dbo.TenancyContacts c"), ...call("UPDATE dbo.WorkRequests"), ...call("COUNT(*) AS N FROM dbo.WorkRequests")]) {
      const get = (n: string) => c.params.find((p) => p.name === n)?.value;
      expect(get("TenantId")).toBe(1);
      if (get("ContactId") !== undefined) expect(get("ContactId")).toBe(11);
      if (get("BuildingId") !== undefined) expect(get("BuildingId")).toBe(5);
    }
    const insert = call("INSERT INTO WorkRequests")[0];
    expect(insert.params.find((p) => p.name === "BuildingID")?.value).toBe(5);
    expect(insert.params.find((p) => p.name === "TenantName")?.value).toBe("Acme Pty Ltd");
    expect(insert.params.find((p) => p.name === "ContactName")?.value).toBe("Pat");
    const [entry] = ledgerInserts(db.executeQuery);
    expect(entry).toMatchObject({ action: "tenancy.request_submit", subjectId: "1", subjectType: "tenancy" });
  });

  it("tenancy B's link lists only B's requests, and A's list query is bound to A", async () => {
    await tenantListRequests(req({ token: TOKEN_A, ip: "192.0.2.50" }), context);
    await tenantListRequests(req({ token: TOKEN_B, ip: "192.0.2.51" }), context);
    const lists = call("FROM dbo.WorkRequests w");
    expect(lists).toHaveLength(2);
    expect(lists.map((c) => c.params.find((p) => p.name === "TenantId")?.value)).toEqual([1, 2]);
    for (const c of lists) expect(c.sql).toContain("w.SourceTenantId = @TenantId");
    for (const c of lists) expect(c.params).toHaveLength(1);
  });

  it("a photo cannot be added to another tenancy's request: the lookup is bound to the link's tenancy, and no match stores nothing", async () => {
    ownedRows = [];
    const png = pngBytes();
    const r = await tenantUploadPhoto(req({ bytes: png, headers: { "content-type": "image/png", "x-tenant-request": "-7" }, token: TOKEN_B, ip: "192.0.2.60" }), context);
    expect(r.status).toBe(404);
    const lookup = call("SELECT WorkRequestID FROM dbo.WorkRequests")[0];
    expect(lookup.params.find((p) => p.name === "TenantId")?.value).toBe(2);
    expect(lookup.sql).toContain("SourceTenantId = @TenantId");
    expect(blobs.uploadTenantQuarantineBlob).not.toHaveBeenCalled();
  });

  it("the page context carries nothing but its own tenancy", async () => {
    const r = await tenantContext(req({ ip: "192.0.2.61" }), context);
    expect(r.status).toBe(200);
    const q = call("JOIN dbo.TenancyContacts c")[0];
    expect(q.params.map((p) => [p.name, p.value])).toEqual([["TenantId", 1], ["ContactId", 11], ["BuildingId", 5]]);
    expect(r.jsonBody).toMatchObject({ buildingName: "Tower One", companyName: "Acme Pty Ltd", suite: "Level 3" });
  });

  it("a contact who may not report problems can read but not submit", async () => {
    whoRow = { ...WHO, ReportsIssues: false };
    expect((await tenantSubmitRequest(req({ body: GOOD }), context)).status).toBe(403);
    expect(call("INSERT INTO WorkRequests")).toHaveLength(0);
  });
});

describe("submit validation", () => {
  it.each([
    ["unknown category", { ...GOOD, category: "hack" }],
    ["unknown urgency", { ...GOOD, urgency: "whenever" }],
    ["short description", { ...GOOD, description: "leak" }],
    ["description too long", { ...GOOD, description: "x".repeat(2001) }],
    ["location too long", { ...GOOD, location: "x".repeat(201) }],
    ["access notes too long", { ...GOOD, accessNotes: "x".repeat(501) }],
    ["non-string description", { ...GOOD, description: { $ne: 1 } }],
  ])("refuses %s", (_name, body) => {
    expect(parseSubmit(body as Record<string, unknown>).ok).toBe(false);
  });

  it("strips control and bidi characters and keeps the tenant's own category and urgency as sent", () => {
    const parsed = parseSubmit({ ...GOOD, description: "Leak‮ under\u0000 the sink please", urgency: "routine" });
    expect(parsed).toMatchObject({ ok: true, value: { description: "Leak under the sink please", urgency: "routine", category: "plumbing" } });
  });

  it("answers 413 for a body over 16 KB", async () => {
    expect((await tenantSubmitRequest(req({ body: "x".repeat(20_000) }), context)).status).toBe(413);
  });
});

describe("triage never changes what the tenant submitted", () => {
  it("suggests from the words, stronger of the two urgencies, and stores the tenant's choice separately", async () => {
    expect(rulesTriage("Sparks coming from the power point", { category: "other", urgency: "routine" })).toMatchObject({ category: "electrical", source: "rules", urgency: "emergency" });
    expect(rulesTriage("Please repaint the wall", { category: "building_fabric", urgency: "urgent" })).toMatchObject({ category: "building_fabric", urgency: "urgent" });
    await tenantSubmitRequest(req({ body: { ...GOOD, category: "other", urgency: "routine", description: "Sparks coming from the power point" } }), context);
    const update = call("UPDATE dbo.WorkRequests")[0];
    expect(update.params.find((p) => p.name === "Category")?.value).toBe("other");
    expect(update.params.find((p) => p.name === "TriageUrgency")?.value).toBe("emergency");
    const insert = call("INSERT INTO WorkRequests")[0];
    expect(insert.params.find((p) => p.name === "Priority")?.value).toBe("Routine");
  });
});

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}
function pngBytes(extra: Buffer = Buffer.alloc(0), width = 2, height = 2): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", Buffer.from("x\u0001idatbytes")), chunk("IEND", Buffer.alloc(0)), extra]);
}
function jpegBytes(trailing = Buffer.from([0xff, 0xd9])): Buffer {
  const app = Buffer.concat([Buffer.from([0xff, 0xe1, 0x00, 0x82]), Buffer.alloc(128, 0x41)]);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x02, 0x00, 0x02, 0x01, 0x01, 0x11, 0x00]);
  const sos = Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0x12, 0x34]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app, sof, sos, trailing]);
}
const webpBytes = (width = 2, height = 2): Buffer => {
  const frame = Buffer.alloc(20, 1);
  frame.set([0x10, 0x00, 0x00, 0x9d, 0x01, 0x2a], 0);
  frame.writeUInt16LE(width, 6);
  frame.writeUInt16LE(height, 8);
  const body = Buffer.concat([Buffer.from("WEBPVP8 ", "latin1"), Buffer.from([20, 0, 0, 0]), frame]);
  const size = Buffer.alloc(4);
  size.writeUInt32LE(body.length, 0);
  return Buffer.concat([Buffer.from("RIFF", "latin1"), size, body]);
};

describe("image checks look at the bytes, not the label", () => {
  it("accepts a well-formed PNG, JPEG and WebP", () => {
    expect(sniffImage(pngBytes())).toBe("image/png");
    expect(sniffImage(jpegBytes())).toBe("image/jpeg");
    expect(sniffImage(webpBytes())).toBe("image/webp");
  });
  it.each([
    ["HTML named .jpg", Buffer.from("<html><script>alert(1)</script></html>".padEnd(200, " "))],
    ["PDF", Buffer.from("%PDF-1.4 ".padEnd(200, "0"))],
    ["SVG", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="x"></svg>'.padEnd(200, " "))],
    ["GIF", Buffer.from("GIF89a".padEnd(200, "0"))],
    ["PNG with a payload appended", pngBytes(Buffer.from("<?php system($_GET[1]); ?>"))],
    ["JPEG with a payload after the end marker", jpegBytes(Buffer.concat([Buffer.from([0xff, 0xd9]), Buffer.from("MZ....")]))],
    ["PNG with a corrupted chunk", (() => { const b = pngBytes(); b[20] ^= 0xff; return b; })()],
    ["PNG claiming a huge size", pngBytes(Buffer.alloc(0), 60000)],
    ["truncated JPEG", jpegBytes().subarray(0, 100)],
    ["empty", Buffer.alloc(0)],
    ["WebP claiming a huge canvas", webpBytes(16383, 16383)],
    ["PNG over the decoded-size cap (8000 x 8000)", pngBytes(Buffer.alloc(0), 8000, 8000)],
    ["PNG carrying markup in a text chunk", (() => { const b = pngBytes(); const text = chunk("tEXt", Buffer.from("k\0<script>alert(1)</script>")); const iend = b.length - 12; return Buffer.concat([b.subarray(0, iend), text, b.subarray(iend)]); })()],
    ["JPEG with a second image after the end marker", jpegBytes(Buffer.concat([Buffer.from([0xff, 0xd9]), jpegBytes()]))],
    ["JPEG whose comment holds markup", (() => { const b = jpegBytes(); const com = Buffer.concat([Buffer.from([0xff, 0xfe, 0x00, 0x16]), Buffer.from("<script>x</script>....")]); return Buffer.concat([b.subarray(0, 2), com, b.subarray(2)]); })()],
  ])("refuses %s", (_name, bytes) => {
    expect(sniffImage(bytes)).toBeNull();
  });
});

describe("photo upload", () => {
  const send = (bytes: Buffer, headers: Record<string, string> = {}, ip = "192.0.2.70") =>
    tenantUploadPhoto(req({ bytes, headers: { "content-type": "image/png", "x-tenant-request": "-7", ...headers }, ip }), context);

  it("stores a good photo unchanged in quarantine, records it, and ledgers it", async () => {
    const png = pngBytes();
    const r = await send(png);
    expect(r.status).toBe(201);
    expect(blobs.uploadTenantQuarantineBlob).toHaveBeenCalledWith(expect.any(Buffer), "image/png", -7);
    expect(blobs.uploadTenantQuarantineBlob.mock.calls[0][0].equals(png)).toBe(true);
    const insert = call("INSERT INTO dbo.TenantRequestPhotos")[0];
    expect(insert.sql).toContain("Processed");
    expect(insert.params.find((p) => p.name === "ContentType")?.value).toBe("image/png");
    expect(ledgerInserts(db.executeQuery)[0]).toMatchObject({ action: "tenancy.request_photo", subjectId: "1" });
  });
  it("refuses a file whose bytes are not the image its label says", async () => {
    expect((await send(jpegBytes(), { "content-type": "image/png" })).status).toBe(415);
    expect((await send(Buffer.from("<svg/>".padEnd(300)), { "content-type": "image/jpeg" }, "192.0.2.71")).status).toBe(415);
    expect(blobs.uploadTenantQuarantineBlob).not.toHaveBeenCalled();
  });
  it("reserves the slot under the lock before any bytes are uploaded, and frees it if the upload fails", async () => {
    const order: string[] = [];
    db.executeQuery.mockImplementation(async (_c: unknown, sql: string) => {
      if (sql.includes("FROM dbo.FeatureFlags")) return [{ FeatureKey: "tenantPage", RoleName: "tenant", Visibility: "enabled" }];
      if (sql.includes("SELECT EmergencyPhone")) return [{ EmergencyPhone: "1800 555 000" }];
      if (sql.includes("SELECT WorkRequestID FROM dbo.WorkRequests")) return ownedRows;
      if (sql.includes("INSERT INTO dbo.TenantRequestPhotos")) { order.push("reserve"); return [{ PhotoId: 9 }]; }
      if (sql.includes("FROM dbo.TenantRequestPhotos")) return [{ N: 0 }];
      if (sql.includes("SET UploadState = N'failed'")) order.push("failed");
      return [];
    });
    blobs.uploadTenantQuarantineBlob.mockImplementationOnce(async () => { order.push("upload"); throw new Error("blob down"); });
    expect((await send(pngBytes(), {}, "192.0.2.90")).status).toBe(500);
    expect(order).toEqual(["reserve", "upload", "failed"]);
    expect(call("COUNT(*) AS N FROM dbo.TenantRequestPhotos WITH (UPDLOCK, HOLDLOCK)").length).toBeGreaterThan(0);
  });
  it("stops reading a body that runs past the cap, whatever Content-Length says", async () => {
    let pulled = 0;
    const body = new ReadableStream({ pull(c) { pulled += 1; c.enqueue(new Uint8Array(1024 * 1024)); if (pulled > 50) c.close(); } });
    const r = await tenantUploadPhoto({ ...req({ headers: { "content-type": "image/png", "x-tenant-request": "-7" }, ip: "192.0.2.91" }), body } as unknown as HttpRequest, context);
    expect(r.status).toBe(413);
    expect(pulled).toBeLessThan(15);
  });
  it("refuses a sixth photo and anything over 8 MB", async () => {
    photoCount = 5;
    expect((await send(pngBytes())).status).toBe(409);
    expect((await tenantUploadPhoto(req({ bytes: pngBytes(), headers: { "content-length": String(9 * 1024 * 1024), "content-type": "image/png", "x-tenant-request": "-7" }, ip: "192.0.2.72" }), context)).status).toBe(413);
    expect(blobs.uploadTenantQuarantineBlob).not.toHaveBeenCalled();
  });
  it("needs a well-formed request reference", async () => {
    for (const bad of ["7", "-0", "abc", "-7; DROP", ""]) expect((await send(pngBytes(), { "x-tenant-request": bad }, `192.0.2.${80 + bad.length}`)).status).toBe(400);
  });
});

describe("status timeline", () => {
  const at = new Date("2026-11-02T01:00:00Z");
  it("starts at received and moves with intake state or status", () => {
    expect(timelineFor({ completedAt: null, intakeState: null, status: "New", submittedAt: at }).current).toBe("received");
    expect(timelineFor({ completedAt: null, intakeState: "Acknowledged", status: "New", submittedAt: at }).current).toBe("acknowledged");
    expect(timelineFor({ completedAt: null, intakeState: null, status: "In Progress", submittedAt: at }).current).toBe("booked");
    const done = timelineFor({ completedAt: "2026-11-04", intakeState: null, status: "Completed", submittedAt: at });
    expect(done.steps.every((s) => s.reached)).toBe(true);
    expect(done.steps[0].at).toBe(at.toISOString());
  });
  it("says only closed for a duplicate or not-ours request", () => {
    const closed = timelineFor({ completedAt: null, intakeState: "closed_duplicate", status: "New", submittedAt: at });
    expect(closed.closed).toBe(true);
    expect(JSON.stringify(closed)).not.toMatch(/duplicate/i);
  });
});

describe("hardening (review S2/S3)", () => {
  it("reads the tenantPage flag from the tenant audience only: enabling a staff role does not open the page", async () => {
    db.executeQuery.mockImplementation(async (_c: unknown, sql: string) => (sql.includes("FROM dbo.FeatureFlags") ? [{ FeatureKey: "tenantPage", RoleName: "admin", Visibility: "enabled" }] : []));
    expect((await tenantContext(req({ ip: "198.51.100.40" }), context)).status).toBe(404);
    expect(resolver.resolveTenantLink).not.toHaveBeenCalled();
  });

  it("answers 503 page_unavailable when the building has no emergency number (fail closed)", async () => {
    const saved = process.env.TENANT_EMERGENCY_PHONE;
    delete process.env.TENANT_EMERGENCY_PHONE;
    emergencyRows = [{ EmergencyPhone: null }];
    const r = await tenantContext(req({ ip: "198.51.100.41" }), context);
    if (saved !== undefined) process.env.TENANT_EMERGENCY_PHONE = saved;
    expect(r.status).toBe(503);
    expect(bodyOf(r)).toContain("page_unavailable");
  });

  it("returns the original request for a retry with the same key, and creates nothing", async () => {
    const key = "retry-key-0123456789ab";
    const base = db.executeQuery.getMockImplementation() as (c: unknown, sql: string, p?: unknown) => Promise<unknown[]>;
    db.executeQuery.mockImplementation(async (c: unknown, sql: string, p?: unknown) => (sql.includes("ClientRequestId = @Key") ? [{ WorkRequestID: -7 }] : base(c, sql, p)));
    const r = await tenantSubmitRequest(req({ body: { ...GOOD, requestKey: key }, ip: "192.0.2.100" }), context);
    expect(r.status).toBe(200);
    expect(r.jsonBody).toMatchObject({ requestId: -7 });
    expect(call("INSERT INTO WorkRequests")).toHaveLength(0);
  });

  it("stores the key on a first submission, and refuses a malformed key", async () => {
    expect((await tenantSubmitRequest(req({ body: { ...GOOD, requestKey: "retry-key-0123456789ab" }, ip: "192.0.2.101" }), context)).status).toBe(201);
    expect(call("UPDATE dbo.WorkRequests")[0].params.find((p) => p.name === "ClientRequestId")?.value).toBe("retry-key-0123456789ab");
    expect((await tenantSubmitRequest(req({ body: { ...GOOD, requestKey: "x" }, ip: "192.0.2.102" }), context)).status).toBe(400);
  });

  it("lets an emergency through the daily cap and flags it, but stops a routine report", async () => {
    const base = db.executeQuery.getMockImplementation() as (c: unknown, sql: string, p?: unknown) => Promise<unknown[]>;
    db.executeQuery.mockImplementation(async (c: unknown, sql: string, p?: unknown) => (sql.includes("COUNT(*) AS N FROM dbo.WorkRequests") ? [{ N: 20 }] : base(c, sql, p)));
    expect((await tenantSubmitRequest(req({ body: { ...GOOD, urgency: "routine", description: "Please repaint the wall by the door" }, ip: "192.0.2.103" }), context)).status).toBe(429);
    expect((await tenantSubmitRequest(req({ body: { ...GOOD, urgency: "emergency" }, ip: "192.0.2.104" }), context)).status).toBe(201);
    expect(ledgerInserts(db.executeQuery).find((e) => e.action === "tenancy.request_submit")?.after).toMatchObject({ overDailyCap: true });
  });
});
