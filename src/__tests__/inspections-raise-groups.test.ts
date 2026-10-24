/// <reference types="jest" />
// SC-AI6: raiseJobsFromInspection with Groups, the jobs a person reviewed. The DB and
// blob layers are mocked; auth flows through the real requireRole path with the
// dev-override header and an unsigned JWT (the harness of inspections-ops.test.ts).
// One request, one transaction, one job per group; a body without Groups is checked
// to make the same insert as before.
import { HttpRequest, InvocationContext } from "@azure/functions";
import { clearRoleCache } from "../auth";
import { _resetRateLimitForTests } from "../rateLimit";
import { composeGroupTitle, fitText, joinDistinct, MAX_GROUP_TITLE_CHARS, parseRaiseGroups } from "../inspectionRaiseGroups";
import { raiseJobsFromInspection } from "../functions/inspections";

jest.mock("../db", () => ({
  beginTransaction: jest.fn(),
  closeConnection: jest.fn(),
  commitTransaction: jest.fn(),
  createRequestConnection: jest.fn(),
  createServiceConnection: jest.fn(),
  executeQuery: jest.fn(),
  rollbackTransaction: jest.fn(),
}));

jest.mock("../blob-storage", () => ({
  deleteBlob: jest.fn(),
  generateReadSasUrl: jest.fn(() => "https://example.test/blob?sas"),
  uploadBlob: jest.fn(),
}));

const db = require("../db") as {
  beginTransaction: jest.Mock;
  closeConnection: jest.Mock;
  commitTransaction: jest.Mock;
  createRequestConnection: jest.Mock;
  createServiceConnection: jest.Mock;
  executeQuery: jest.Mock;
  rollbackTransaction: jest.Mock;
};

// ── Harness ──────────────────────────────────────────────────────────────────

function makeJwt(payload: Record<string, unknown>): string {
  const encode = (obj: unknown) =>
    Buffer.from(JSON.stringify(obj)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${encode({ alg: "none" })}.${encode(payload)}.sig`;
}

const authHeaders = (roles: string): Record<string, string> => ({
  authorization: `Bearer ${makeJwt({ oid: "oid-tester", name: "Test User", preferred_username: "t@example.com" })}`,
  "x-dev-roles": roles,
});

function makeRequest(opts: { body?: unknown; headers: Record<string, string> }): HttpRequest {
  return {
    headers: { get: (key: string) => opts.headers[key.toLowerCase()] ?? null },
    json: async () => opts.body,
    query: { get: () => null },
  } as unknown as HttpRequest;
}

const makeContext = (): InvocationContext => ({ error: jest.fn(), log: jest.fn(), warn: jest.fn() }) as unknown as InvocationContext;

type Row = Record<string, unknown>;
type SqlCall = [unknown, string, { name: string; value: unknown }[]];

const callsMatching = (substr: string): SqlCall[] => (db.executeQuery.mock.calls as SqlCall[]).filter(([, sql]) => sql.includes(substr));
const param = (call: SqlCall, name: string): unknown => call[2].find((p) => p.name === name)?.value;
const jobInserts = (): SqlCall[] => callsMatching("INSERT INTO dbo.Jobs");

// ── Fixture: a completed inspection on two levels, three rooms, six findings ──

const WHEN = new Date("2026-07-01T00:00:00Z");
const room = (Id: string, LevelId: string, Name: string, SortOrder: number): Row => ({
  AddedAt: WHEN, AddedById: "u", AddedByName: "Sam", Description: null, Id, LevelId, Name, SortOrder,
});
const point = (Id: string, RoomId: string, Description: string, SortOrder: number): Row => ({
  AddedAt: WHEN, AddedById: "u", AddedByName: "Sam", Description, Id, LastModifiedAt: WHEN, RoomId, SortOrder,
});

const LEVELS: Row[] = [
  { AddedAt: WHEN, Id: "lvl-g", Name: "Ground floor", SortOrder: 0 },
  { AddedAt: WHEN, Id: "lvl-2", Name: "Level 2", SortOrder: 1 },
];
const ROOMS: Row[] = [room("room-p", "lvl-g", "Plant room", 0), room("room-k", "lvl-2", "Kitchen", 0), room("room-c", "lvl-2", "Corridor", 1)];
const POINTS: Row[] = [
  point("pt-p1", "room-p", "Leaking valve", 0),
  point("pt-p2", "room-p", "Rusted bracket", 1),
  point("pt-k1", "room-k", "Light flickering", 0),
  point("pt-k2", "room-k", "Switch loose", 1),
  point("pt-c1", "room-c", "Corridor lights out", 0),
  point("pt-photo", "room-c", "", 1),
];
const ATTACHMENTS: Row[] = [
  { BlobName: "inspections/aaa", FileName: "crack.jpg", Id: "att-1", PointId: "pt-photo", UploadedAt: WHEN, UploadedById: "u", UploadedByName: "Sam" },
];

const inspectionRow = (over: Row = {}): Row => ({
  BuildingId: 10, BuildingName: "HQ", CompletedAt: WHEN, CompletedById: "u", CompletedByName: "Sam", CreatedAt: WHEN,
  CreatedById: "oid-tester", CreatedByName: "Test User", Id: 7, LastModifiedAt: WHEN, MergedIntoId: null, Revision: 1, Status: "complete",
  Title: null, ...over,
});

interface Wiring {
  /** Points that already have a job. */
  linked?: string[];
  /** Make the nth Jobs insert (from 1) throw. */
  failJobInsert?: number;
  inspection?: Row;
}

function wire(opts: Wiring = {}): void {
  let nextJobId = 500;
  let jobInserted = 0;
  const linked = opts.linked ?? [];
  db.executeQuery.mockImplementation(async (_conn: unknown, sql: string) => {
    if (sql.includes("JOIN dbo.Buildings b")) return [inspectionRow(opts.inspection)];
    if (sql.includes("FROM dbo.InspectionLevels")) return LEVELS;
    if (sql.includes("FROM dbo.InspectionLevelContributors")) return [];
    if (sql.includes("FROM dbo.InspectionRooms")) return ROOMS;
    if (sql.includes("FROM dbo.InspectionPoints")) return POINTS;
    if (sql.includes("SELECT Id, PointId, BlobName")) return ATTACHMENTS;
    if (sql.includes("SELECT DISTINCT PointId FROM dbo.InspectionRaisedJobs")) return linked.map((PointId) => ({ PointId }));
    if (sql.includes("SELECT PointId, JobId FROM dbo.InspectionRaisedJobs")) return linked.map((PointId) => ({ JobId: 1, PointId }));
    if (sql.includes("SELECT SourceInspectionId")) return [];
    if (sql.includes("WITH (UPDLOCK, HOLDLOCK) WHERE Id = @Id")) return [{ Status: String(inspectionRow(opts.inspection).Status) }];
    if (sql.includes("INSERT INTO dbo.Jobs")) {
      jobInserted += 1;
      if (opts.failJobInsert === jobInserted) throw new Error("String or binary data would be truncated");
      return [{ JobID: nextJobId++ }];
    }
    return [];
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  clearRoleCache();
  _resetRateLimitForTests();
  db.createRequestConnection.mockResolvedValue({});
  db.createServiceConnection.mockResolvedValue({});
  db.beginTransaction.mockResolvedValue(undefined);
  db.commitTransaction.mockResolvedValue(undefined);
  db.rollbackTransaction.mockResolvedValue(undefined);
  process.env.DEV_ROLE_OVERRIDE_ENABLED = "true";
  process.env.AZURE_FUNCTIONS_ENVIRONMENT = "Development";
  wire();
});

const DEFAULTS = { JobType: "Electrical", Priority: "Normal" };

type Body = Record<string, unknown>;
const raise = (body: Body, roles = "facilities") =>
  raiseJobsFromInspection(makeRequest({ body: { InspectionId: 7, Defaults: DEFAULTS, ...body }, headers: authHeaders(roles) }), makeContext());
const withGroups = (groups: unknown, extra: Body = {}) => raise({ Groups: groups, ...extra });

type RaiseOut = { jobs: { jobId: number; pointIds: string[] }[]; pointIds: string[]; skippedPointIds: string[] };
const out = (res: { jsonBody?: unknown }) => res.jsonBody as RaiseOut;
const message = (res: { jsonBody?: unknown }) => (res.jsonBody as { error: string }).error;

// ── One job per group ────────────────────────────────────────────────────────

describe("Groups: one job per group", () => {
  it("makes one job for each group with the title and priority it was given, and the defaults for what it was not", async () => {
    const res = await raise({
      Defaults: { AssigneeName: "Jo", DescriptionPrefix: "[Monthly walk]", JobType: "Electrical", Priority: "Normal", SubType: "Repairs & Maintenance" },
      Groups: [
        { PointIds: ["pt-k1", "pt-k2"], Priority: "High", Title: "Electrical: Level 2 kitchen (2 findings)" },
        { PointIds: ["pt-p1"] },
      ],
    });

    expect(res.status).toBe(200);
    expect(out(res)).toEqual({
      jobs: [{ jobId: 500, pointIds: ["pt-k1", "pt-k2"] }, { jobId: 501, pointIds: ["pt-p1"] }],
      pointIds: ["pt-k1", "pt-k2", "pt-p1"],
      skippedPointIds: [],
    });

    const [first, second] = jobInserts();
    expect(jobInserts()).toHaveLength(2);
    expect(Object.fromEntries(first[2].map((p) => [p.name, p.value]))).toMatchObject({
      AssignedTo: "Jo",
      Description: "• Light flickering\n• Switch loose",
      ExactLocation: "Kitchen",
      JobType: "Electrical",
      LevelName: "Level 2",
      Priority: "High",
      SourceInspectionId: 7,
      SourceInspectionPointId: null,
      SourceInspectionRoomId: "room-k",
      SubType: "Repairs & Maintenance",
      Title: "[Monthly walk] Electrical: Level 2 kitchen (2 findings)",
    });
    // No title: titled as a per-point job is; no priority: the batch's.
    expect(Object.fromEntries(second[2].map((p) => [p.name, p.value]))).toMatchObject({
      Description: "Leaking valve",
      ExactLocation: "Plant room",
      LevelName: "Ground floor",
      Priority: "Normal",
      SourceInspectionPointId: "pt-p1",
      SourceInspectionRoomId: "room-p",
      Title: "[Monthly walk] Ground floor / Plant room",
    });
    expect(callsMatching("INSERT INTO dbo.JobEvents")).toHaveLength(2);
  });

  it("makes ONE job of a group that spans rooms and levels: every finding linked, every finding's photos copied", async () => {
    const res = await withGroups([{ PointIds: ["pt-k1", "pt-c1", "pt-photo", "pt-p1"], Title: "Mixed works" }]);

    expect(out(res).jobs).toEqual([{ jobId: 500, pointIds: ["pt-k1", "pt-c1", "pt-photo", "pt-p1"] }]);
    expect(jobInserts()).toHaveLength(1);
    const insert = jobInserts()[0];
    expect(param(insert, "LevelName")).toBe("Level 2, Ground floor");
    expect(param(insert, "ExactLocation")).toBe("Kitchen, Corridor, Plant room");
    expect(param(insert, "SourceInspectionRoomId")).toBe("room-k");
    expect(param(insert, "SourceInspectionPointId")).toBeNull();
    expect(param(insert, "Description")).toBe("• Light flickering\n• Corridor lights out\n• (photo only)\n• Leaking valve");

    const links = callsMatching("INSERT INTO dbo.InspectionRaisedJobs");
    expect(links.map((call) => [param(call, "PointId"), param(call, "JobId")])).toEqual([
      ["pt-k1", 500], ["pt-c1", 500], ["pt-photo", 500], ["pt-p1", 500],
    ]);
    const copies = callsMatching("INSERT INTO dbo.Attachments");
    expect(copies.map((call) => param(call, "PointId"))).toEqual(["pt-k1", "pt-c1", "pt-photo", "pt-p1"]);
    expect(copies.every((call) => param(call, "JobID") === 500)).toBe(true);
  });

  it("sets SourceInspectionPointId for a group of one finding, and for none of more", async () => {
    await withGroups([{ PointIds: ["pt-k1"] }, { PointIds: ["pt-k2", "pt-c1"] }]);
    const [one, several] = jobInserts();
    expect(param(one, "SourceInspectionPointId")).toBe("pt-k1");
    expect(param(several, "SourceInspectionPointId")).toBeNull();
  });

  it("puts the batch's prefix before the person's title, and nothing before it when there is no prefix", async () => {
    await raise({ Defaults: { ...DEFAULTS, DescriptionPrefix: "  [Walk 7]  " }, Groups: [{ PointIds: ["pt-k1"], Title: "Fix the kitchen light" }] });
    expect(param(jobInserts()[0], "Title")).toBe("[Walk 7] Fix the kitchen light");

    jest.clearAllMocks();
    wire();
    await raise({ Defaults: DEFAULTS, Groups: [{ PointIds: ["pt-k1"], Title: "  Fix the kitchen light  " }] });
    expect(param(jobInserts()[0], "Title")).toBe("Fix the kitchen light");
  });

  it("fits a long title to the 200 a job title holds, at a word and with an ellipsis", async () => {
    const title = "alpha ".repeat(33).trim();
    expect(title.length).toBeLessThanOrEqual(MAX_GROUP_TITLE_CHARS);
    await raise({ Defaults: { ...DEFAULTS, DescriptionPrefix: "[Inspection 7 monthly walk]" }, Groups: [{ PointIds: ["pt-k1"], Title: title }] });

    const saved = String(param(jobInserts()[0], "Title"));
    expect(saved.length).toBeLessThanOrEqual(200);
    expect(saved.startsWith("[Inspection 7 monthly walk] alpha alpha")).toBe(true);
    expect(saved.endsWith("alpha…")).toBe(true);
  });

  it("raises a repeated id inside a group once", async () => {
    const res = await withGroups([{ PointIds: ["pt-k1", "pt-k1", "pt-k2"] }]);
    expect(out(res).jobs).toEqual([{ jobId: 500, pointIds: ["pt-k1", "pt-k2"] }]);
    expect(callsMatching("INSERT INTO dbo.InspectionRaisedJobs")).toHaveLength(2);
  });

  it("marks the jobs of a test inspection as test jobs", async () => {
    wire({ inspection: { IsTest: true } });
    await withGroups([{ PointIds: ["pt-k1"] }]);
    expect(param(jobInserts()[0], "IsTest")).toBe(true);
  });

  it("makes the same job for a room's findings as the per-room mode does", async () => {
    const defaults = { ...DEFAULTS, DescriptionPrefix: "[Walk]" };
    await raise({ Defaults: defaults, Mode: "per-room", PointIds: ["pt-k1", "pt-k2"] });
    const legacy = jobInserts()[0][2];

    jest.clearAllMocks();
    wire();
    await raise({ Defaults: defaults, Groups: [{ PointIds: ["pt-k1", "pt-k2"] }] });
    expect(jobInserts()[0][2]).toEqual(legacy);
  });

  it("makes the same job for one finding as the per-point mode does", async () => {
    await raise({ PointIds: ["pt-p1"] });
    const legacy = jobInserts()[0][2];

    jest.clearAllMocks();
    wire();
    await withGroups([{ PointIds: ["pt-p1"] }]);
    expect(jobInserts()[0][2]).toEqual(legacy);
  });
});

// ── Findings that already have a job ─────────────────────────────────────────

describe("Groups: findings that already have a job", () => {
  it("raises what is left of a group as one job and reports the rest as skipped", async () => {
    wire({ linked: ["pt-k1"] });
    const res = await withGroups([{ PointIds: ["pt-k1", "pt-k2", "pt-c1"], Title: "Lights" }]);

    expect(out(res)).toEqual({ jobs: [{ jobId: 500, pointIds: ["pt-k2", "pt-c1"] }], pointIds: ["pt-k2", "pt-c1"], skippedPointIds: ["pt-k1"] });
    expect(callsMatching("INSERT INTO dbo.InspectionRaisedJobs").map((call) => param(call, "PointId"))).toEqual(["pt-k2", "pt-c1"]);
  });

  it("makes no job of a group whose findings all have one, and still raises the others", async () => {
    wire({ linked: ["pt-k1", "pt-k2"] });
    const res = await withGroups([{ PointIds: ["pt-k1", "pt-k2"] }, { PointIds: ["pt-p1"] }]);

    expect(out(res)).toEqual({ jobs: [{ jobId: 500, pointIds: ["pt-p1"] }], pointIds: ["pt-p1"], skippedPointIds: ["pt-k1", "pt-k2"] });
    expect(jobInserts()).toHaveLength(1);
  });

  it("answers 200 with no jobs when every finding has one (a retry after a lost response)", async () => {
    wire({ linked: ["pt-k1", "pt-p1"] });
    const res = await withGroups([{ PointIds: ["pt-k1"] }, { PointIds: ["pt-p1"] }]);

    expect(res.status).toBe(200);
    expect(out(res)).toEqual({ jobs: [], pointIds: [], skippedPointIds: ["pt-k1", "pt-p1"] });
    expect(jobInserts()).toHaveLength(0);
    expect(callsMatching("INSERT INTO dbo.JobEvents")).toHaveLength(0);
    expect(callsMatching("INSERT INTO dbo.InspectionRaisedJobs")).toHaveLength(0);
  });

  it("reads the existing links under the inspection's lock, inside the transaction, before it inserts", async () => {
    await withGroups([{ PointIds: ["pt-k1"] }]);
    const calls = db.executeQuery.mock.calls as SqlCall[];
    const order = db.executeQuery.mock.invocationCallOrder;
    const orderOf = (sql: string) => order[calls.findIndex(([, text]) => text.includes(sql))];
    expect(db.beginTransaction.mock.invocationCallOrder[0]).toBeLessThan(orderOf("WITH (UPDLOCK, HOLDLOCK) WHERE Id = @Id"));
    expect(orderOf("WITH (UPDLOCK, HOLDLOCK) WHERE Id = @Id")).toBeLessThan(orderOf("SELECT DISTINCT PointId FROM dbo.InspectionRaisedJobs"));
    expect(orderOf("SELECT DISTINCT PointId FROM dbo.InspectionRaisedJobs")).toBeLessThan(orderOf("INSERT INTO dbo.Jobs"));
  });
});

// ── A request that is not valid ──────────────────────────────────────────────

describe("Groups: a request that is not valid", () => {
  const ok = { PointIds: ["pt-k1"] };
  const BAD: [string, Body][] = [
    ["a finding in two jobs", { Groups: [{ PointIds: ["pt-k1", "pt-k2"] }, { PointIds: ["pt-k2"] }] }],
    ["Groups with PointIds beside them", { Groups: [ok], PointIds: ["pt-k1"] }],
    ["Groups with a Mode beside them", { Groups: [ok], Mode: "per-room" }],
    ["Groups with a Mode of per-point beside them", { Groups: [ok], Mode: "per-point" }],
    ["an empty Groups list", { Groups: [] }],
    ["Groups that is text", { Groups: "pt-k1" }],
    ["Groups that is an object", { Groups: ok }],
    ["more than 100 groups", { Groups: Array.from({ length: 101 }, (_, i) => ({ PointIds: [`pt-${i}`] })) }],
    ["a group that is not an object", { Groups: ["pt-k1"] }],
    ["a group with no PointIds", { Groups: [{ Title: "Lights" }] }],
    ["a group with an empty PointIds", { Groups: [{ PointIds: [] }] }],
    ["a group with more than 500 findings", { Groups: [{ PointIds: Array.from({ length: 501 }, (_, i) => `pt-${i}`) }] }],
    ["a blank finding id", { Groups: [{ PointIds: [""] }] }],
    ["a finding id that is a number", { Groups: [{ PointIds: [5] }] }],
    ["a finding id that is long", { Groups: [{ PointIds: ["p".repeat(101)] }] }],
    ["a priority that is not one of ours", { Groups: [{ ...ok, Priority: "Urgent" }] }],
    ["a priority that is a number", { Groups: [{ ...ok, Priority: 1 }] }],
    ["a blank title", { Groups: [{ ...ok, Title: "   " }] }],
    ["a title that is a number", { Groups: [{ ...ok, Title: 7 }] }],
    ["a title over 200 characters", { Groups: [{ ...ok, Title: "t".repeat(201) }] }],
    ["a title with a line break", { Groups: [{ ...ok, Title: "Lights\nand more" }] }],
    ["a title with a control character", { Groups: [{ ...ok, Title: "Lights\u0007" }] }],
  ];

  it.each(BAD)("answers 400 with a sentence for %s, and opens no connection", async (_label, body) => {
    const res = await raise(body);
    expect(res.status).toBe(400);
    expect(typeof message(res)).toBe("string");
    expect(db.createRequestConnection).not.toHaveBeenCalled();
    expect(db.executeQuery).not.toHaveBeenCalled();
    expect(db.beginTransaction).not.toHaveBeenCalled();
  });

  it("says plainly that Groups and PointIds are one or the other, and that a finding goes in one job", async () => {
    expect(message(await raise({ Groups: [ok], PointIds: ["pt-k1"] }))).toBe("Send Groups, or PointIds with a Mode, not both.");
    expect(message(await withGroups([{ PointIds: ["pt-k1"] }, { PointIds: ["pt-k1"] }]))).toBe("A finding can only go into one job.");
  });

  it("still needs the batch's JobType and Priority, and an InspectionId", async () => {
    expect((await raise({ Defaults: { Priority: "Normal" }, Groups: [ok] })).status).toBe(400);
    expect((await raise({ Defaults: { JobType: "Electrical" }, Groups: [ok] })).status).toBe(400);
    const noInspection = await raiseJobsFromInspection(makeRequest({ body: { Defaults: DEFAULTS, Groups: [ok] }, headers: authHeaders("facilities") }), makeContext());
    expect(noInspection.status).toBe(400);
    expect(db.createRequestConnection).not.toHaveBeenCalled();
  });

  it("accepts an empty PointIds beside Groups, and reads Groups: null as no Groups at all", async () => {
    expect((await raise({ Groups: [ok], PointIds: [] })).status).toBe(200);
    const none = await raise({ Groups: null });
    expect(none.status).toBe(400);
    expect(message(none)).toBe("InspectionId and PointIds[] required");
  });

  it("refuses a finding that is not in the inspection, and creates nothing", async () => {
    const res = await withGroups([{ PointIds: ["pt-k1", "pt-nowhere"] }]);
    expect(res.status).toBe(400);
    expect(message(res)).toContain("pt-nowhere");
    expect(db.beginTransaction).not.toHaveBeenCalled();
    expect(jobInserts()).toHaveLength(0);
  });
});

// ── Access, state and the one transaction ────────────────────────────────────

describe("Groups: access, state and the transaction", () => {
  it("answers 401 with no token and 403 for a role that cannot edit inspections, before any database work", async () => {
    const body = { Defaults: DEFAULTS, Groups: [{ PointIds: ["pt-k1"] }], InspectionId: 7 };
    const none = await raiseJobsFromInspection(makeRequest({ body, headers: {} }), makeContext());
    expect(none.status).toBe(401);
    const accounts = await raiseJobsFromInspection(makeRequest({ body, headers: authHeaders("accounts") }), makeContext());
    expect(accounts.status).toBe(403);
    expect(db.createRequestConnection).not.toHaveBeenCalled();
    expect(db.executeQuery).not.toHaveBeenCalled();
  });

  it.each(["facilities", "facilities_manager", "director", "admin"])("lets %s raise suggested jobs", async (role) => {
    expect((await raise({ Groups: [{ PointIds: ["pt-p1"] }] }, role)).status).toBe(200);
  });

  it.each(["accounts", "accounts_manager", "cfo", "user"])("keeps %s out, as it does for the other modes", async (role) => {
    expect((await raise({ Groups: [{ PointIds: ["pt-p1"] }] }, role)).status).toBe(403);
    expect(jobInserts()).toHaveLength(0);
  });

  it("refuses to raise jobs from a draft inspection", async () => {
    wire({ inspection: { Status: "draft" } });
    const res = await withGroups([{ PointIds: ["pt-k1"] }]);
    expect(res.status).toBe(400);
    expect(message(res)).toMatch(/completed/i);
    expect(jobInserts()).toHaveLength(0);
  });

  it("does all its groups in one transaction: begun once, committed once", async () => {
    await withGroups([{ PointIds: ["pt-k1"] }, { PointIds: ["pt-p1"] }, { PointIds: ["pt-c1", "pt-photo"] }]);
    expect(jobInserts()).toHaveLength(3);
    expect(db.beginTransaction).toHaveBeenCalledTimes(1);
    expect(db.commitTransaction).toHaveBeenCalledTimes(1);
    expect(db.rollbackTransaction).not.toHaveBeenCalled();
  });

  it("keeps none of them when a later group fails: rolled back, never committed", async () => {
    wire({ failJobInsert: 2 });
    const res = await withGroups([{ PointIds: ["pt-k1"] }, { PointIds: ["pt-p1"] }]);
    expect(res.status).toBe(500);
    expect(db.rollbackTransaction).toHaveBeenCalled();
    expect(db.commitTransaction).not.toHaveBeenCalled();
    expect((res.jsonBody as { error: string }).error).toBe("Failed to raise jobs");
  });
});

// ── A body without Groups is the route it always was ─────────────────────────

describe("a body without Groups", () => {
  const defaults = { ...DEFAULTS, DescriptionPrefix: "[Walk]" };

  it("per-room: one job for the room, titled by its level and room, with no single finding", async () => {
    const res = await raise({ Defaults: defaults, Mode: "per-room", PointIds: ["pt-k1", "pt-k2", "pt-c1"] });
    expect(out(res).jobs).toEqual([{ jobId: 500, pointIds: ["pt-k1", "pt-k2"] }, { jobId: 501, pointIds: ["pt-c1"] }]);
    const [kitchen, corridor] = jobInserts();
    expect(Object.fromEntries(kitchen[2].map((p) => [p.name, p.value]))).toMatchObject({
      Description: "• Light flickering\n• Switch loose",
      ExactLocation: "Kitchen",
      LevelName: "Level 2",
      Priority: "Normal",
      SourceInspectionPointId: null,
      SourceInspectionRoomId: "room-k",
      Title: "[Walk] Level 2 / Kitchen",
    });
    // Per-room mode never names a single finding, even for a room with one.
    expect(param(corridor, "SourceInspectionPointId")).toBeNull();
  });

  it("per-point (the default mode): one job per finding, each naming its finding", async () => {
    const res = await raise({ Defaults: defaults, PointIds: ["pt-k1", "pt-p1"] });
    expect(out(res).jobs).toEqual([{ jobId: 500, pointIds: ["pt-k1"] }, { jobId: 501, pointIds: ["pt-p1"] }]);
    const [kitchen, plant] = jobInserts();
    expect(Object.fromEntries(kitchen[2].map((p) => [p.name, p.value]))).toMatchObject({
      Description: "Light flickering",
      ExactLocation: "Kitchen",
      LevelName: "Level 2",
      SourceInspectionPointId: "pt-k1",
      Title: "[Walk] Level 2 / Kitchen",
    });
    expect(param(plant, "Title")).toBe("[Walk] Ground floor / Plant room");
  });

  it("still refuses an unknown Mode and an empty PointIds", async () => {
    expect((await raise({ Mode: "bulk", PointIds: ["pt-k1"] })).status).toBe(400);
    expect(message(await raise({ PointIds: [] }))).toBe("InspectionId and PointIds[] required");
  });
});

// ── The pure helpers ─────────────────────────────────────────────────────────

describe("fitText, composeGroupTitle and joinDistinct", () => {
  it("leaves text that fits alone, and cuts the rest at a word with an ellipsis, within the limit", () => {
    expect(fitText("Lights out", 20)).toBe("Lights out");
    expect(fitText("a".repeat(20), 20)).toBe("a".repeat(20));
    expect(fitText("Replace the corridor lights", 20)).toBe("Replace the…");
    expect(fitText("Replace the corridor lights", 20).length).toBeLessThanOrEqual(20);
    expect(fitText("Replace corridor lights now", 17)).toBe("Replace corridor…");
  });

  it("cuts a single long word where it must", () => {
    expect(fitText("a".repeat(30), 10)).toBe(`${"a".repeat(9)}…`);
  });

  it("joins a prefix and a title with one space, and not at all without a prefix", () => {
    expect(composeGroupTitle("[Walk]", "Lights")).toBe("[Walk] Lights");
    expect(composeGroupTitle("", "Lights")).toBe("Lights");
    expect(composeGroupTitle("[Walk]", "x ".repeat(150).trim()).length).toBeLessThanOrEqual(200);
  });

  it("lists each name once, in the order first met", () => {
    expect(joinDistinct(["Level 2", "Level 2", "Ground floor", "Level 2"], 100)).toBe("Level 2, Ground floor");
    expect(joinDistinct(["Kitchen"], 200)).toBe("Kitchen");
    expect(joinDistinct(["Kitchen", "Corridor", "Plant room"], 12)).toBe("Kitchen…");
  });
});

describe("parseRaiseGroups", () => {
  it("returns the groups with repeated ids removed and the choices it kept", () => {
    expect(parseRaiseGroups([{ PointIds: ["a", "b", "a"], Priority: "Low", Title: " Lights " }, { PointIds: ["c"], Priority: null, Title: null }])).toEqual({
      groups: [{ pointIds: ["a", "b"], priority: "Low", title: "Lights" }, { pointIds: ["c"] }],
    });
  });

  it("names the job a mistake is in, by its position", () => {
    expect(parseRaiseGroups([{ PointIds: ["a"] }, { PointIds: ["b"], Priority: "Soon" }])).toEqual({
      error: "Job 2 has a priority that is not Critical, High, Normal, Low.",
    });
  });
});
