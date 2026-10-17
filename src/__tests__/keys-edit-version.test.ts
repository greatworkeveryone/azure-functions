/// <reference types="jest" />
// Editing a key must not silently overwrite what someone else saved meanwhile,
// nor what the edit did not touch. Every key read carries the row's version
// (rowVersion, 16 hex characters from Keys.Version, migration 139); updateKey
// requires it, reads the row under an update lock, and answers 409 with the
// current key when it has moved. It writes only the fields the request carries
// (absent: unchanged, null: cleared). The key's building, type and number are
// never written. There is no SQL Server here: a
// small fake keeps the row, stamps a new version on every write, and rolls back
// with the transaction, so these tests follow what a stale save does to the row.
import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";

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
    oidFromToken: jest.fn().mockReturnValue("oid-ann"),
    requireRole: jest.fn().mockResolvedValue(null),
    unauthorizedResponse: jest.fn().mockReturnValue({ jsonBody: { error: "Unauthorized" }, status: 401 }),
  };
});

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
  keyPhotoReadSasUrl: jest.fn((blob: string) => `https://photo.example/${blob}`),
  uploadKeyPhotoBlob: jest.fn(),
}));
jest.mock("../keyPlannerSync", () => ({ syncKeyLostReportedStandalone: jest.fn() }));

import "../functions/keys";

type Row = Record<string, unknown>;
type Param = { name: string; value: unknown };
type Handler = (request: HttpRequest, context: InvocationContext) => Promise<HttpResponseInit>;

const handlers = new Map<string, Handler>(
  (app.http as unknown as jest.Mock).mock.calls.map(([name, options]: [string, { handler: Handler }]) => [name, options.handler]),
);

const auth = require("../auth") as Record<"extractToken" | "requireRole" | "errorResponse", jest.Mock>;
const db = require("../db") as Record<
  "beginTransaction" | "closeConnection" | "commitTransaction" | "createRequestConnection" | "executeQuery" | "rollbackTransaction",
  jest.Mock
>;
const context = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;
const FORBIDDEN = { jsonBody: { error: "Forbidden" }, status: 403 };

const jsonRequest = (body: unknown, query: Record<string, string> = {}): HttpRequest =>
  ({ headers: { get: () => null }, json: async () => body, query: { get: (k: string) => query[k] ?? null } }) as unknown as HttpRequest;

/** A ROWVERSION as tedious returns it: 8 bytes. */
const versionOf = (n: number) => Buffer.from(n.toString(16).padStart(16, "0"), "hex");
const hex = (n: number) => versionOf(n).toString("hex");

const keyRow = (over: Row = {}): Row => ({
  BuildingId: 3,
  BuildingName: "Block A",
  CreatedAt: new Date("2026-06-01T00:00:00Z"),
  CreatedById: "oid-ann",
  CreatedByName: "Ann",
  DateAdded: "2026-06-01",
  DeletedAt: null,
  DeletedById: null,
  DeletedByName: null,
  Description: "Front door",
  Id: 7,
  IsDeleted: 0,
  ItemType: "key",
  KeyNumber: "K-001",
  Level: "Ground",
  LostAt: null,
  LostById: null,
  LostByName: null,
  LostComment: null,
  PhotoBlobUrl: "keys/front-door.jpg",
  Registration: "registered",
  Status: "active",
  StorageLocation: "Cabinet B",
  SubType: "BiLock",
  TenancyId: 12,
  TenancyName: "Acme Pty Ltd",
  Version: versionOf(1),
  ...over,
});

// ── The fake database ────────────────────────────────────────────────────────

let stored: Row | null; // the Keys row as the database holds it
let versionCounter: number; // the last ROWVERSION stamped
let snapshot: Row | null; // the row as it was when the open transaction began
let events: string[]; // what happened, in order
let failUpdate: Error | null;

/** Someone else writes the row: the server stamps it with a version nobody has read yet. */
function anotherWriterChanges(over: Row) {
  stored = { ...(stored as Row), ...over, Version: versionOf(++versionCounter) };
}

/** The row as the SELECT would return it: only the columns its select list names. */
function project(sql: string, row: Row): Row {
  const list = sql.slice(sql.search(/\bSELECT\b/i), sql.search(/\bFROM dbo\.Keys\b/));
  return Object.fromEntries(Object.entries(row).filter(([column]) => new RegExp(`\\b${column}\\b`).test(list)));
}

/** Columns a statement's SET clause assigns, so the fake applies what the SQL says and no more. */
function assignedColumns(sql: string): Array<[string, string]> {
  const set = sql.match(/\bSET\b([\s\S]*?)\bWHERE\b/i)?.[1] ?? "";
  return set
    .split(",")
    .map((part) => part.split("="))
    .filter((pair) => pair.length === 2)
    .map(([column, parameter]) => [column.trim(), parameter.trim().replace(/^@/, "")]);
}

function serve() {
  let selects = 0;
  db.executeQuery.mockImplementation(async (_connection: unknown, sql: string, params: Param[] = []) => {
    const param = (name: string) => params.find((p) => p.name === name)?.value;
    if (/FROM dbo\.Keys k WITH \(UPDLOCK, ROWLOCK\)/.test(sql)) {
      selects += 1;
      events.push(selects === 1 ? "lock" : "read");
      return stored && stored.Id === param("Id") ? [project(sql, stored)] : [];
    }
    if (/^\s*UPDATE dbo\.Keys\b/.test(sql)) {
      events.push("update");
      if (failUpdate) throw failUpdate;
      const next = { ...(stored as Row) };
      for (const [column, parameter] of assignedColumns(sql)) next[column] = param(parameter);
      next.Version = versionOf(++versionCounter);
      stored = next;
      return [];
    }
    if (/INSERT INTO dbo\.Keys\b/.test(sql)) {
      stored = keyRow({
        Description: param("Description"),
        Id: 9,
        KeyNumber: param("KeyNumber"),
        PhotoBlobUrl: param("PhotoBlobUrl"),
        Version: versionOf(++versionCounter),
      });
      return [{ Id: 9 }];
    }
    if (/FROM dbo\.Keys k\s+JOIN dbo\.Buildings b[\s\S]*OUTER APPLY/.test(sql)) return stored ? [project(sql, stored)] : [];
    if (/FROM dbo\.Keys k\s+JOIN dbo\.Buildings b/.test(sql)) return stored && stored.Id === param("Id") ? [project(sql, stored)] : [];
    return [];
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  auth.extractToken.mockReturnValue("mock-token");
  auth.requireRole.mockResolvedValue(null);
  auth.errorResponse.mockReturnValue({ jsonBody: { error: "Error" }, status: 500 });
  stored = keyRow();
  versionCounter = 1;
  snapshot = null;
  events = [];
  failUpdate = null;
  db.createRequestConnection.mockResolvedValue({});
  db.beginTransaction.mockImplementation(async () => {
    snapshot = stored && { ...stored };
    events.push("begin");
  });
  db.commitTransaction.mockImplementation(async () => {
    snapshot = null;
    events.push("commit");
  });
  db.rollbackTransaction.mockImplementation(async () => {
    stored = snapshot;
    snapshot = null;
    events.push("rollback");
  });
  serve();
});

// ── Reads ────────────────────────────────────────────────────────────────────

describe("every key read carries the version the next edit must send back", () => {
  it("getKeys gives each key its rowVersion as 16 hex characters", async () => {
    stored = keyRow({ Version: versionOf(0x2a) });
    const res = await handlers.get("getKeys")!(jsonRequest(null), context);
    expect(res.status).toBe(200);
    const { keys } = res.jsonBody as { keys: Array<{ rowVersion: string }> };
    expect(keys).toHaveLength(1);
    expect(keys[0].rowVersion).toBe("000000000000002a");
    expect(keys[0].rowVersion).toMatch(/^[0-9a-f]{16}$/);
  });

  it("getKeyDetail gives it too", async () => {
    stored = keyRow({ Version: versionOf(0xbeef) });
    const res = await handlers.get("getKeyDetail")!(jsonRequest(null, { id: "7" }), context);
    expect(res.status).toBe(200);
    expect((res.jsonBody as { key: { rowVersion: string } }).key.rowVersion).toBe("000000000000beef");
  });

  it("gives the photo as the stored reference an edit sends back, next to the link that shows it", async () => {
    const res = await handlers.get("getKeys")!(jsonRequest(null), context);
    const [key] = (res.jsonBody as { keys: Array<Record<string, unknown>> }).keys;
    expect(key).toMatchObject({ photoBlobUrl: "keys/front-door.jpg", photoUrl: "https://photo.example/keys/front-door.jpg" });
    stored = keyRow({ PhotoBlobUrl: null });
    const none = (await handlers.get("getKeys")!(jsonRequest(null), context)).jsonBody as { keys: Array<Record<string, unknown>> };
    expect(none.keys[0]).toMatchObject({ photoBlobUrl: null, photoUrl: null });
  });

  it("createKey returns the new key with the version it was created at", async () => {
    const res = await handlers.get("createKey")!(
      jsonRequest({ BuildingId: 3, Description: "Back door", KeyNumber: "K-002", Level: "Ground" }),
      context,
    );
    expect(res.status).toBe(200);
    expect((res.jsonBody as { key: { rowVersion: string } }).key.rowVersion).toBe(hex(2));
  });

  it.each([
    ["empty", ""],
    ["spaces", "   "],
    ["missing", undefined],
    ["null", null],
  ])("createKey refuses a description that is %s", async (_label, Description) => {
    const res = await handlers.get("createKey")!(jsonRequest({ BuildingId: 3, Description, KeyNumber: "K-002", Level: "Ground" }), context);
    expect(res.status).toBe(400);
    expect(db.executeQuery.mock.calls.filter((call) => /INSERT INTO dbo\.Keys/.test(call[1] as string))).toHaveLength(0);
  });
});

// ── updateKey ────────────────────────────────────────────────────────────────

// What the edit form sends for a key it has not otherwise changed: every field as it was, the description edited.
const EDIT = {
  Description: "Front door (edited)",
  Id: 7,
  Level: "Ground",
  PhotoBlobUrl: "keys/front-door.jpg",
  Registration: "registered",
  StorageLocation: "Cabinet B",
  SubType: "BiLock",
  TenancyId: 12,
};
const update = (body: Row = {}) => handlers.get("updateKey")!(jsonRequest({ ...EDIT, rowVersion: hex(1), ...body }), context);
/** A request that carries only the key, its version and what the test names. */
const send = (body: Row = {}) => handlers.get("updateKey")!(jsonRequest({ Id: 7, rowVersion: hex(1), ...body }), context);
const updates = () => db.executeQuery.mock.calls.filter((call) => /^\s*UPDATE dbo\.Keys\b/.test(call[1] as string));
const keyOf = (res: HttpResponseInit) => (res.jsonBody as { key: Row }).key;

describe("updateKey needs the version", () => {
  it("answers 401 with no token and 403 for a role that cannot edit keys, and touches nothing", async () => {
    auth.extractToken.mockReturnValue(null);
    expect((await update()).status).toBe(401);
    auth.extractToken.mockReturnValue("mock-token");
    auth.requireRole.mockResolvedValue(FORBIDDEN);
    expect((await update()).status).toBe(403);
    expect(db.createRequestConnection).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", undefined],
    ["null", null],
    ["empty", ""],
    ["blank", "   "],
    ["a number", 7],
    ["too short", "0000000000001"],
    ["too long", "00000000000000001"],
    ["not hex", "000000000000000g"],
    ["Base64 (the form another table uses)", "AAAAAAAAB9A="],
  ])("refuses an edit whose rowVersion is %s, before it opens a connection", async (_label, rowVersion) => {
    const res = await update({ rowVersion });
    expect(res.status).toBe(400);
    expect(res.jsonBody).toMatchObject({ code: "ROW_VERSION_REQUIRED" });
    expect(db.createRequestConnection).not.toHaveBeenCalled();
    expect(db.beginTransaction).not.toHaveBeenCalled();
    expect(updates()).toHaveLength(0);
    expect(stored).toMatchObject({ Description: "Front door" });
  });

  it("still asks for the Id first", async () => {
    const res = await handlers.get("updateKey")!(jsonRequest({ rowVersion: hex(1) }), context);
    expect(res.status).toBe(400);
    expect(res.jsonBody).toEqual({ error: "Id required" });
  });
});

describe("updateKey with the version it was read at", () => {
  it("locks the row, compares, writes, reads the result back and commits, in that order, in one transaction", async () => {
    const res = await update();
    expect(res.status).toBe(200);
    expect(events).toEqual(["begin", "lock", "update", "read", "commit"]);
    expect(db.rollbackTransaction).not.toHaveBeenCalled();
    expect(db.closeConnection).toHaveBeenCalledTimes(1);
  });

  it("reads the row under an update lock, by Id", async () => {
    await update();
    const [, sql, params] = db.executeQuery.mock.calls[0] as [unknown, string, Param[]];
    expect(sql).toMatch(/FROM dbo\.Keys k WITH \(UPDLOCK, ROWLOCK\)/);
    expect(params).toEqual([{ name: "Id", type: expect.anything(), value: 7 }]);
  });

  it("saves the edit and hands back the key with its new version", async () => {
    const res = await update();
    expect(stored).toMatchObject({ Description: "Front door (edited)" });
    expect(keyOf(res)).toMatchObject({ description: "Front door (edited)", id: 7, rowVersion: hex(2) });
  });

  it("takes the version in upper case and with stray spaces", async () => {
    const res = await update({ rowVersion: `  ${hex(1).toUpperCase()} ` });
    expect(res.status).toBe(200);
    expect(stored).toMatchObject({ Description: "Front door (edited)" });
  });

  it("writes the editable fields it was sent, in a fixed order, and nothing else", async () => {
    await update();
    expect(written()).toEqual({
      columns: ["TenancyId", "Level", "SubType", "Registration", "Description", "PhotoBlobUrl", "StorageLocation"],
      params: ["Id", "TenancyId", "Level", "SubType", "Registration", "Description", "PhotoBlobUrl", "StorageLocation"],
    });
  });
});

/** The columns the UPDATE set and the parameters it was given. */
function written() {
  const [[, sql, params]] = updates() as unknown as Array<[unknown, string, Param[]]>;
  return { columns: assignedColumns(sql).map(([column]) => column), params: params.map((p) => p.name) };
}

describe("updateKey writes only the fields the request carries", () => {
  it("writes the fields it was sent and no others", async () => {
    await send({ Description: "Front door (north)", StorageLocation: "Plant room" });
    expect(written()).toEqual({ columns: ["Description", "StorageLocation"], params: ["Id", "Description", "StorageLocation"] });
  });

  it.each([
    ["TenancyId", 12],
    ["Level", "Ground"],
    ["SubType", "BiLock"],
    ["Registration", "registered"],
    ["PhotoBlobUrl", "keys/front-door.jpg"],
    ["StorageLocation", "Cabinet B"],
  ])("leaves %s as it is when the request does not mention it", async (field, was) => {
    const res = await send({ Description: "Front door (north)" });
    expect(res.status).toBe(200);
    expect(written().columns).toEqual(["Description"]);
    expect(stored).toMatchObject({ Description: "Front door (north)", [field]: was });
  });

  it.each([
    ["TenancyId", null],
    ["Level", ""],
    ["SubType", null],
    ["Registration", "standard"],
    ["PhotoBlobUrl", null],
    ["StorageLocation", null],
  ])("clears %s when it is sent as null, and touches nothing else", async (field, cleared) => {
    const before = { ...(stored as Row) };
    const res = await send({ [field]: null });
    expect(res.status).toBe(200);
    expect(written().columns).toEqual([field]);
    expect(stored).toMatchObject({ [field]: cleared });
    expect({ ...stored, [field]: 0, Version: 0 }).toEqual({ ...before, [field]: 0, Version: 0 });
  });

  it("sets a field to the value it is sent", async () => {
    const res = await send({ Level: "Level 1", SubType: "Dimpled", TenancyId: 15 });
    expect(res.status).toBe(200);
    expect(written().columns).toEqual(["TenancyId", "Level", "SubType"]);
    expect(stored).toMatchObject({ Level: "Level 1", SubType: "Dimpled", TenancyId: 15 });
    expect(keyOf(res)).toMatchObject({ level: "Level 1", subType: "Dimpled", tenancyId: 15 });
  });

  it("an edit with nothing to change writes nothing and moves no version", async () => {
    const res = await send();
    expect(res.status).toBe(200);
    expect(events).toEqual(["begin", "lock", "commit"]);
    expect(updates()).toHaveLength(0);
    expect(keyOf(res)).toMatchObject({ description: "Front door", rowVersion: hex(1) });
  });

  it("and is still refused when its version is stale", async () => {
    anotherWriterChanges({ Description: "Front door (Bob)" });
    expect((await send()).status).toBe(409);
  });
});

describe("updateKey and the key's photo", () => {
  it("keeps it when the edit sends it back unchanged, as the edit form does", async () => {
    const res = await update();
    expect(stored).toMatchObject({ PhotoBlobUrl: "keys/front-door.jpg" });
    expect(keyOf(res)).toMatchObject({ photoBlobUrl: "keys/front-door.jpg", photoUrl: "https://photo.example/keys/front-door.jpg" });
  });

  it("keeps it when the edit does not mention it", async () => {
    const res = await send({ Description: "Front door (north)", StorageLocation: "Plant room" });
    expect(stored).toMatchObject({ PhotoBlobUrl: "keys/front-door.jpg", StorageLocation: "Plant room" });
    expect(keyOf(res)).toMatchObject({ photoBlobUrl: "keys/front-door.jpg" });
  });

  it("removes it only when the edit says so, with an explicit null", async () => {
    const res = await update({ PhotoBlobUrl: null });
    expect(stored).toMatchObject({ PhotoBlobUrl: null });
    expect(keyOf(res)).toMatchObject({ photoBlobUrl: null, photoUrl: null });
  });

  it("replaces it with a new one when the edit sends one", async () => {
    const res = await update({ PhotoBlobUrl: "keys/new-door.jpg" });
    expect(keyOf(res)).toMatchObject({ photoBlobUrl: "keys/new-door.jpg", photoUrl: "https://photo.example/keys/new-door.jpg" });
  });
});

describe("updateKey and the description", () => {
  it.each([
    ["empty", ""],
    ["only spaces", "   "],
    ["null", null],
    ["not text", 5],
  ])("refuses a description that is %s, before it opens a connection", async (_label, Description) => {
    const res = await send({ Description });
    expect(res.status).toBe(400);
    expect(res.jsonBody).toEqual({ error: "Description required" });
    expect(db.createRequestConnection).not.toHaveBeenCalled();
    expect(stored).toMatchObject({ Description: "Front door" });
  });

  it("changes it to the text it is sent, and lets an edit leave it out", async () => {
    const first = await send({ Description: "  Front door (north)  " });
    expect(stored).toMatchObject({ Description: "  Front door (north)  " });
    await send({ Level: "Level 1", rowVersion: keyOf(first).rowVersion });
    expect(stored).toMatchObject({ Description: "  Front door (north)  ", Level: "Level 1" });
  });
});

describe("updateKey leaves the key's identity alone", () => {
  it("ignores BuildingId, ItemType and KeyNumber in the body: not written, not changed, not echoed back", async () => {
    const res = await update({ BuildingId: 99, ItemType: "code", KeyNumber: "K-999" });
    expect(res.status).toBe(200);
    const [[, sql, params]] = updates() as unknown as Array<[unknown, string, Param[]]>;
    expect(sql).not.toMatch(/BuildingId|ItemType|KeyNumber/);
    expect(params.map((p) => p.name)).not.toEqual(expect.arrayContaining(["BuildingId"]));
    expect(params.map((p) => p.name)).not.toEqual(expect.arrayContaining(["ItemType"]));
    expect(params.map((p) => p.name)).not.toEqual(expect.arrayContaining(["KeyNumber"]));
    expect(stored).toMatchObject({ BuildingId: 3, ItemType: "key", KeyNumber: "K-001" });
    expect(keyOf(res)).toMatchObject({ buildingId: 3, itemType: "key", keyNumber: "K-001" });
  });

  it("does not even look at them when the version is stale", async () => {
    anotherWriterChanges({ Description: "Front door (Bob)" });
    const res = await update({ BuildingId: 99, ItemType: "code", KeyNumber: "K-999" });
    expect(res.status).toBe(409);
    expect(stored).toMatchObject({ BuildingId: 3, ItemType: "key", KeyNumber: "K-001" });
  });
});

describe("updateKey refuses a stale version instead of overwriting", () => {
  const SENTENCE = "Someone else changed this key — it has been refreshed. Check it and save again.";

  it("answers 409 with a plain sentence and the current key, and writes nothing", async () => {
    anotherWriterChanges({ Description: "Front door (Bob)", StorageLocation: "Plant room" });
    const res = await update();
    expect(res.status).toBe(409);
    expect(res.jsonBody).toMatchObject({
      code: "KEY_STALE",
      currentState: {
        buildingId: 3,
        description: "Front door (Bob)",
        id: 7,
        keyNumber: "K-001",
        rowVersion: hex(2),
        storageLocation: "Plant room",
      },
      error: SENTENCE,
    });
    expect(updates()).toHaveLength(0);
    expect(events).toEqual(["begin", "lock", "rollback"]);
    expect(db.commitTransaction).not.toHaveBeenCalled();
    expect(stored).toMatchObject({ Description: "Front door (Bob)", StorageLocation: "Plant room" });
    expect(db.closeConnection).toHaveBeenCalledTimes(1);
  });

  it("catches a check-in that moved the storage location while the edit form was open", async () => {
    // The check-in is another writer: it sets StorageLocation, and the server moves the version.
    anotherWriterChanges({ StorageLocation: "Plant room" });
    const res = await update({ StorageLocation: "Cabinet B" });
    expect(res.status).toBe(409);
    expect(stored).toMatchObject({ StorageLocation: "Plant room" });
    expect((res.jsonBody as { currentState: Row }).currentState).toMatchObject({ storageLocation: "Plant room" });
  });

  it("two saves from the same read: the first lands, the second is refused and cannot undo it", async () => {
    const ann = await update({ Description: "Front door (Ann)" });
    const bob = await update({ Description: "Front door (Bob)", StorageLocation: "Plant room" });
    expect(ann.status).toBe(200);
    expect(bob.status).toBe(409);
    expect(stored).toMatchObject({ Description: "Front door (Ann)", StorageLocation: "Cabinet B" });
    expect(updates()).toHaveLength(1);
    expect((bob.jsonBody as { currentState: Row }).currentState).toMatchObject({
      description: "Front door (Ann)",
      rowVersion: keyOf(ann).rowVersion,
    });
  });

  it("lets the person save again with the version the 409 handed back", async () => {
    anotherWriterChanges({ StorageLocation: "Plant room" });
    const refused = await update();
    const current = (refused.jsonBody as { currentState: { rowVersion: string } }).currentState;
    const retry = await update({ StorageLocation: "Plant room", rowVersion: current.rowVersion });
    expect(retry.status).toBe(200);
    expect(stored).toMatchObject({ Description: "Front door (edited)", StorageLocation: "Plant room" });
  });

  it("moves the version on writes made elsewhere in the module, so a form opened before them goes stale", async () => {
    // reportKeyLost, deleteKey, restoreKey, checkoutKeys and checkinKeys all UPDATE dbo.Keys; the
    // server stamps a new ROWVERSION on every such write. The fake models that stamp.
    const before = (await handlers.get("getKeyDetail")!(jsonRequest(null, { id: "7" }), context)).jsonBody as { key: { rowVersion: string } };
    anotherWriterChanges({ Status: "lost" });
    const res = await update({ rowVersion: before.key.rowVersion });
    expect(res.status).toBe(409);
    expect(stored).toMatchObject({ Status: "lost" });
  });
});

describe("updateKey when the key or the database is not as expected", () => {
  it("answers 404 for a key that does not exist, and ends the transaction", async () => {
    stored = null;
    const res = await update();
    expect(res.status).toBe(404);
    expect(res.jsonBody).toMatchObject({ code: "KEY_NOT_FOUND" });
    expect(events).toEqual(["begin", "lock", "rollback"]);
    expect(db.closeConnection).toHaveBeenCalledTimes(1);
  });

  it("rolls the whole edit back and answers 500 when the write fails", async () => {
    failUpdate = new Error("String or binary data would be truncated");
    const res = await update();
    expect(res.status).toBe(500);
    expect(events).toEqual(["begin", "lock", "update", "rollback"]);
    expect(db.commitTransaction).not.toHaveBeenCalled();
    expect(stored).toMatchObject({ Description: "Front door" });
    expect((stored as Row).Version).toEqual(versionOf(1));
    expect(db.closeConnection).toHaveBeenCalledTimes(1);
  });
});
