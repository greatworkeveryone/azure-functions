/// <reference types="jest" />
// Reporting a key lost, archiving it, restoring it, checking keys out and
// checking them in each change several rows that have to stand or fall together.
// They run as one transaction on rows the transaction has locked, so these tests
// follow what each does to the keys and their checkouts, and what is left when
// something fails half way. There is no SQL Server here: a small fake keeps the
// rows, applies the statements the handlers send (the ones named below, nothing
// else), and rolls back with the transaction. That two people really do take
// turns on a key is shown against SQL Server, not here: what is pinned here is
// that the keys are locked before anything is read about their checkouts.
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

const auth = require("../auth") as Record<"extractToken" | "requireRole", jest.Mock>;
const db = require("../db") as Record<
  "beginTransaction" | "closeConnection" | "commitTransaction" | "createRequestConnection" | "executeQuery" | "rollbackTransaction",
  jest.Mock
>;
const planner = require("../keyPlannerSync") as { syncKeyLostReportedStandalone: jest.Mock };
const context = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;

const call = (name: string, body: unknown): Promise<HttpResponseInit> =>
  handlers.get(name)!(({ headers: { get: () => null }, json: async () => body, query: { get: () => null } }) as unknown as HttpRequest, context);

// ── The fake database ────────────────────────────────────────────────────────

interface World {
  batches: Row[];
  checkouts: Row[];
  keys: Row[];
}
const copy = (w: World): World => ({
  batches: w.batches.map((r) => ({ ...r })),
  checkouts: w.checkouts.map((r) => ({ ...r })),
  keys: w.keys.map((r) => ({ ...r })),
});

let world: World;
let snapshot: World | null;
let events: string[];
let now: Date;
let failOn: { error: Error; pattern: RegExp } | null;
let attachment: Row | null;
let nextCheckoutId: number;

const T0 = new Date("2026-06-02T09:00:00.000Z");
const T1 = new Date("2026-06-02T10:00:00.123Z");
const T2 = new Date("2026-06-02T11:30:00.456Z");

const key = (over: Row = {}): Row => ({
  DeletedAt: null,
  DeletedById: null,
  Id: 7,
  IsDeleted: 0,
  ItemType: "key",
  KeyNumber: "K-007",
  LostAt: null,
  LostById: null,
  LostByName: null,
  LostComment: null,
  Status: "active",
  StorageLocation: "Cabinet B",
  ...over,
});
const checkout = (over: Row = {}): Row => ({ BatchId: 1, CheckInPhotoBlobUrl: null, CheckedInAt: null, Id: 1, KeyId: 7, ...over });

function serve() {
  db.executeQuery.mockImplementation(async (_connection: unknown, sql: string, params: Param[] = []) => {
    const one = (name: string) => params.find((p) => p.name === name)?.value;
    const named = (pattern: RegExp) => params.filter((p) => pattern.test(p.name)).map((p) => p.value);
    if (failOn?.pattern.test(sql)) throw failOn.error;
    const keyById = (id: unknown) => world.keys.find((k) => k.Id === id);
    const hasOpen = (keyId: unknown) => world.checkouts.some((c) => c.KeyId === keyId && c.CheckedInAt === null);

    if (/FROM dbo\.Keys WITH \(UPDLOCK, ROWLOCK\)\s+WHERE Id = @Id/.test(sql)) {
      events.push("lock");
      const row = keyById(one("Id"));
      return row ? [{ ...row, Now: now }] : [];
    }
    if (/SELECT DISTINCT KeyId FROM dbo\.KeyCheckouts/.test(sql)) {
      events.push("owners");
      const ids = named(/^C\d+$/);
      return [...new Set(world.checkouts.filter((c) => ids.includes(c.Id)).map((c) => c.KeyId as number))].sort((a, b) => a - b).map((KeyId) => ({ KeyId }));
    }
    if (/FROM dbo\.Keys WITH \(UPDLOCK, ROWLOCK\)\s+WHERE Id = @KeyId/.test(sql)) {
      events.push(`lock-key-${one("KeyId")}`);
      return keyById(one("KeyId")) ? [{ Id: one("KeyId") }] : [];
    }
    if (/FROM dbo\.Keys WITH \(UPDLOCK, ROWLOCK\)\s+WHERE Id IN/.test(sql)) {
      events.push("lock-keys");
      const ids = named(/^K\d+$/);
      return world.keys.filter((k) => ids.includes(k.Id)).sort((a, b) => (a.Id as number) - (b.Id as number)).map((k) => ({ ...k }));
    }
    if (/JOIN dbo\.KeyCheckouts kco ON kco\.KeyId = k\.Id/.test(sql)) {
      events.push("already-out");
      const ids = named(/^K\d+$/);
      return world.keys.filter((k) => ids.includes(k.Id) && k.ItemType === "key" && hasOpen(k.Id)).map((k) => ({ Id: k.Id, KeyNumber: k.KeyNumber }));
    }
    if (/FROM dbo\.Attachments a/.test(sql)) return attachment ? [attachment] : [];
    if (/INSERT INTO dbo\.KeyCheckoutBatches/.test(sql)) {
      events.push("insert-batch");
      const id = 100 + world.batches.length;
      world.batches.push({ Id: id, SignatureAttachmentId: one("SignatureAttachmentId") });
      return [{ Id: id }];
    }
    if (/INSERT INTO dbo\.KeyCheckouts/.test(sql)) {
      events.push("insert-checkout");
      world.checkouts.push(checkout({ BatchId: one("BatchId"), Id: nextCheckoutId++, KeyId: one("KeyId") }));
      return [];
    }
    if (/UPDATE dbo\.Keys SET StorageLocation = @Loc WHERE Id = @KeyId/.test(sql)) {
      events.push("set-location");
      Object.assign(keyById(one("KeyId")) as Row, { StorageLocation: one("Loc") });
      return [];
    }
    if (/UPDATE dbo\.KeyCheckouts\s+SET CheckedInAt = SYSUTCDATETIME\(\), CheckInPhotoBlobUrl = @Photo/.test(sql)) {
      events.push("close");
      const ids = named(/^C\d+$/);
      const closing = world.checkouts.filter((c) => ids.includes(c.Id) && c.CheckedInAt === null);
      for (const c of closing) Object.assign(c, { CheckInPhotoBlobUrl: one("Photo"), CheckedInAt: now });
      return closing.map((c) => ({ Id: c.Id, KeyId: c.KeyId }));
    }
    if (/SELECT DISTINCT kco\.BatchId/.test(sql)) {
      const ids = named(/^C\d+$/);
      return [...new Set(world.checkouts.filter((c) => ids.includes(c.Id)).map((c) => c.BatchId))].map((BatchId) => ({ BatchId }));
    }
    if (/SELECT k\.KeyNumber FROM dbo\.KeyCheckouts kco/.test(sql)) {
      return world.checkouts
        .filter((c) => c.BatchId === one("BatchId") && c.CheckedInAt === null)
        .map((c) => ({ KeyNumber: keyById(c.KeyId)?.KeyNumber }));
    }
    if (/UPDATE dbo\.KeyCheckouts\s+SET CheckedInAt = @Now/.test(sql)) {
      events.push("close-checkouts");
      for (const c of world.checkouts) if (c.KeyId === one("Id") && c.CheckedInAt === null) c.CheckedInAt = one("Now");
      return [];
    }
    if (/UPDATE dbo\.Keys\s+SET Status = 'lost'/.test(sql)) {
      events.push("mark-lost");
      Object.assign(keyById(one("Id")) as Row, {
        LostAt: one("Now"), LostById: one("LostById"), LostByName: one("LostByName"), LostComment: one("LostComment"), Status: "lost",
      });
      return [];
    }
    if (/UPDATE dbo\.Keys\s+SET IsDeleted = 1/.test(sql)) {
      events.push("mark-deleted");
      Object.assign(keyById(one("Id")) as Row, { DeletedAt: one("Now"), DeletedById: one("DeletedById"), IsDeleted: 1 });
      return [];
    }
    if (/UPDATE kc\s+SET CheckedInAt = NULL/.test(sql)) {
      events.push("reopen");
      const owner = keyById(one("Id")) as Row;
      const same = (a: unknown, b: unknown) => a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
      const reopening = world.checkouts.filter(
        (c) =>
          c.KeyId === owner.Id &&
          c.CheckedInAt !== null &&
          c.CheckInPhotoBlobUrl === null &&
          ((one("WasLost") === true && same(c.CheckedInAt, owner.LostAt)) || (one("WasDeleted") === true && same(c.CheckedInAt, owner.DeletedAt))),
      );
      for (const c of reopening) c.CheckedInAt = null;
      return reopening.map((c) => ({ Id: c.Id }));
    }
    if (/UPDATE dbo\.Keys SET IsDeleted = 0, Status = 'active' WHERE Id = @Id/.test(sql)) {
      events.push("mark-active");
      Object.assign(keyById(one("Id")) as Row, { IsDeleted: 0, Status: "active" });
      return [];
    }
    return [];
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  auth.extractToken.mockReturnValue("mock-token");
  auth.requireRole.mockResolvedValue(null);
  world = { batches: [], checkouts: [], keys: [key()] };
  snapshot = null;
  events = [];
  now = T1;
  failOn = null;
  attachment = null;
  nextCheckoutId = 500;
  db.createRequestConnection.mockResolvedValue({});
  db.beginTransaction.mockImplementation(async () => {
    snapshot = copy(world);
    events.push("begin");
  });
  db.commitTransaction.mockImplementation(async () => {
    snapshot = null;
    events.push("commit");
  });
  db.rollbackTransaction.mockImplementation(async () => {
    world = snapshot as World;
    snapshot = null;
    events.push("rollback");
  });
  planner.syncKeyLostReportedStandalone.mockImplementation(() => events.push("planner"));
  serve();
});

/** The text of the one statement that matches, among those sent so far. */
const statement = (pattern: RegExp): string => {
  const sent = db.executeQuery.mock.calls.map((c) => c[1] as string).filter((sql) => pattern.test(sql));
  expect(sent).toHaveLength(1);
  return sent[0];
};
const theKey = (id = 7) => world.keys.find((k) => k.Id === id) as Row;
const theCheckout = (id: number) => world.checkouts.find((c) => c.Id === id) as Row;
const boom = (pattern: RegExp) => {
  failOn = { error: new Error("The write failed"), pattern };
};
/** The transaction was begun once and ended once, the way the test expects. */
const endedBy = (end: "commit" | "rollback") => {
  expect(events.filter((e) => e === "begin")).toHaveLength(1);
  expect(events.filter((e) => e === "commit" || e === "rollback")).toEqual([end]);
  expect(db.closeConnection).toHaveBeenCalledTimes(1);
};

// ── reportKeyLost ────────────────────────────────────────────────────────────

describe("reportKeyLost", () => {
  beforeEach(() => {
    world.checkouts = [checkout({ Id: 1 })];
  });

  it("closes the key's open checkouts and marks it lost, in one transaction, at one moment", async () => {
    const res = await call("reportKeyLost", { Comment: "  Not on the hook  ", Id: 7 });
    expect(res).toMatchObject({ jsonBody: { ok: true }, status: 200 });
    expect(events).toEqual(["begin", "lock", "close-checkouts", "mark-lost", "commit", "planner"]);
    expect(theKey()).toMatchObject({ LostAt: T1, LostById: "oid-ann", LostComment: "Not on the hook", Status: "lost" });
    expect(theCheckout(1).CheckedInAt).toBe(T1);
    expect(theCheckout(1).CheckedInAt).toBe(theKey().LostAt);
    expect(planner.syncKeyLostReportedStandalone).toHaveBeenCalledWith(7);
    expect(db.closeConnection).toHaveBeenCalledTimes(1);
  });

  it("reads the key under an update lock before it writes anything", async () => {
    await call("reportKeyLost", { Id: 7 });
    const [sql] = db.executeQuery.mock.calls.map((c) => c[1] as string);
    expect(sql).toMatch(/FROM dbo\.Keys WITH \(UPDLOCK, ROWLOCK\)/);
  });

  it("keeps a blank comment as no comment", async () => {
    await call("reportKeyLost", { Comment: "   ", Id: 7 });
    expect(theKey().LostComment).toBeNull();
  });

  it("leaves the checkouts open and the key active when the second write fails", async () => {
    boom(/UPDATE dbo\.Keys\s+SET Status = 'lost'/);
    const res = await call("reportKeyLost", { Id: 7 });
    expect(res.status).toBe(500);
    expect(events).toEqual(["begin", "lock", "close-checkouts", "rollback"]);
    expect(theKey()).toMatchObject({ LostAt: null, Status: "active" });
    expect(theCheckout(1).CheckedInAt).toBeNull();
    expect(planner.syncKeyLostReportedStandalone).not.toHaveBeenCalled();
    endedBy("rollback");
  });

  it("refuses a key that is already lost, and keeps who reported it first", async () => {
    world.keys = [key({ LostAt: T0, LostById: "oid-bob", LostComment: "Bob's report", Status: "lost" })];
    const res = await call("reportKeyLost", { Comment: "Ann's report", Id: 7 });
    expect(res).toMatchObject({ jsonBody: { code: "ALREADY_LOST" }, status: 409 });
    expect(theKey()).toMatchObject({ LostAt: T0, LostById: "oid-bob", LostComment: "Bob's report" });
    expect(events).toEqual(["begin", "lock", "rollback"]);
    expect(planner.syncKeyLostReportedStandalone).not.toHaveBeenCalled();
  });

  it("answers 404 for a key that is not there, and 400 without an Id", async () => {
    expect(await call("reportKeyLost", { Id: 99 })).toMatchObject({ jsonBody: { code: "KEY_NOT_FOUND" }, status: 404 });
    expect(await call("reportKeyLost", {})).toMatchObject({ jsonBody: { error: "Id required" }, status: 400 });
  });
});

// ── deleteKey ────────────────────────────────────────────────────────────────

describe("deleteKey", () => {
  beforeEach(() => {
    world.checkouts = [checkout({ Id: 1 })];
  });

  it("closes the open checkouts and archives the key, in one transaction, at one moment", async () => {
    const res = await call("deleteKey", { Id: 7 });
    expect(res).toMatchObject({ jsonBody: { ok: true }, status: 200 });
    expect(events).toEqual(["begin", "lock", "close-checkouts", "mark-deleted", "commit", "planner"]);
    expect(theKey()).toMatchObject({ DeletedAt: T1, DeletedById: "oid-ann", IsDeleted: 1 });
    expect(theCheckout(1).CheckedInAt).toBe(theKey().DeletedAt);
  });

  it("leaves everything as it was when the archive fails", async () => {
    boom(/UPDATE dbo\.Keys\s+SET IsDeleted = 1/);
    expect((await call("deleteKey", { Id: 7 })).status).toBe(500);
    expect(theKey().IsDeleted).toBe(0);
    expect(theCheckout(1).CheckedInAt).toBeNull();
    expect(planner.syncKeyLostReportedStandalone).not.toHaveBeenCalled();
    endedBy("rollback");
  });

  it("refuses a key that is already archived, and one that is not there", async () => {
    world.keys = [key({ DeletedAt: T0, IsDeleted: 1 })];
    expect(await call("deleteKey", { Id: 7 })).toMatchObject({ jsonBody: { code: "ALREADY_DELETED" }, status: 409 });
    expect(theKey().DeletedAt).toBe(T0);
    expect(await call("deleteKey", { Id: 99 })).toMatchObject({ status: 404 });
  });
});

// ── restoreKey ───────────────────────────────────────────────────────────────

describe("restoreKey", () => {
  // Three checkouts of one key: returned with a photo long ago, closed by an
  // earlier report at another moment, and still out when it is reported lost.
  beforeEach(() => {
    world.checkouts = [
      checkout({ CheckInPhotoBlobUrl: "keys/back.jpg", CheckedInAt: T0, Id: 1 }),
      checkout({ CheckedInAt: new Date("2026-05-01T08:00:00.000Z"), Id: 2 }),
      checkout({ Id: 3 }),
    ];
  });

  it("brings back a key reported lost, with the checkout that report closed", async () => {
    await call("reportKeyLost", { Comment: "Not on the hook", Id: 7 });
    expect(theCheckout(3).CheckedInAt).toBe(T1);
    events = [];

    const res = await call("restoreKey", { Id: 7 });
    expect(res).toMatchObject({ jsonBody: { ok: true, reopenedCheckouts: 1 }, status: 200 });
    expect(events).toEqual(["begin", "lock", "reopen", "mark-active", "commit", "planner"]);
    expect(theKey()).toMatchObject({ IsDeleted: 0, Status: "active" });
    expect(theCheckout(3).CheckedInAt).toBeNull();
  });

  it("reopens only that one: not a return with a photo, not a closure from some other moment", async () => {
    await call("reportKeyLost", { Id: 7 });
    await call("restoreKey", { Id: 7 });
    expect(theCheckout(1)).toMatchObject({ CheckInPhotoBlobUrl: "keys/back.jpg", CheckedInAt: T0 });
    expect(theCheckout(2).CheckedInAt).toEqual(new Date("2026-05-01T08:00:00.000Z"));
  });

  it("brings back an archived key with the checkout the archive closed", async () => {
    await call("deleteKey", { Id: 7 });
    const res = await call("restoreKey", { Id: 7 });
    expect(res).toMatchObject({ jsonBody: { reopenedCheckouts: 1 }, status: 200 });
    expect(theKey().IsDeleted).toBe(0);
    expect(theCheckout(3).CheckedInAt).toBeNull();
  });

  it("keeps the history of the report and the archive instead of erasing it", async () => {
    await call("reportKeyLost", { Comment: "Not on the hook", Id: 7 });
    await call("restoreKey", { Id: 7 });
    expect(theKey()).toMatchObject({ LostAt: T1, LostById: "oid-ann", LostComment: "Not on the hook" });
    now = T2;
    await call("deleteKey", { Id: 7 });
    await call("restoreKey", { Id: 7 });
    expect(theKey()).toMatchObject({ DeletedAt: T2, DeletedById: "oid-ann", LostAt: T1, LostComment: "Not on the hook" });
    const restore = db.executeQuery.mock.calls.map((c) => c[1] as string).filter((sql) => /UPDATE dbo\.Keys SET IsDeleted = 0/.test(sql));
    expect(restore.length).toBeGreaterThan(0);
    for (const sql of restore) expect(sql).not.toMatch(/DeletedAt|DeletedBy|Lost/);
  });

  it("asks for exactly the closures with no photo that carry the key's own LostAt or DeletedAt", async () => {
    world.keys = [key({ LostAt: T1, Status: "lost" })];
    await call("restoreKey", { Id: 7 });
    const sql = statement(/SET CheckedInAt = NULL/);
    expect(sql).toMatch(/kc\.CheckedInAt IS NOT NULL/);
    expect(sql).toMatch(/kc\.CheckInPhotoBlobUrl IS NULL/);
    expect(sql).toMatch(/@WasLost = 1 AND kc\.CheckedInAt = k\.LostAt/);
    expect(sql).toMatch(/@WasDeleted = 1 AND kc\.CheckedInAt = k\.DeletedAt/);
    expect(sql).toMatch(/OUTPUT INSERTED\.Id/);
  });

  it("leaves closed a checkout that was closed some other way, even at nearly the same moment", async () => {
    // closed by an older report: no photo, but not at exactly the key's LostAt
    world.keys = [key({ LostAt: T1, Status: "lost" })];
    world.checkouts = [checkout({ CheckedInAt: new Date(T1.getTime() - 40), Id: 4 })];
    const res = await call("restoreKey", { Id: 7 });
    expect(res).toMatchObject({ jsonBody: { reopenedCheckouts: 0 }, status: 200 });
    expect(theCheckout(4).CheckedInAt).not.toBeNull();
    expect(theKey().Status).toBe("active");
  });

  it("never reopens a return that has a photo, whatever moment it carries", async () => {
    world.keys = [key({ LostAt: T1, Status: "lost" })];
    world.checkouts = [checkout({ CheckInPhotoBlobUrl: "keys/back.jpg", CheckedInAt: T1, Id: 4 })];
    expect(await call("restoreKey", { Id: 7 })).toMatchObject({ jsonBody: { reopenedCheckouts: 0 } });
    expect(theCheckout(4).CheckedInAt).toBe(T1);
  });

  it("reopens what a report closed and what an archive closed, when a key was both lost and archived", async () => {
    world.keys = [key({ DeletedAt: T2, IsDeleted: 1, LostAt: T1, Status: "lost" })];
    world.checkouts = [checkout({ CheckedInAt: T1, Id: 4 }), checkout({ BatchId: 2, CheckedInAt: T2, Id: 5, KeyId: 7 })];
    expect(await call("restoreKey", { Id: 7 })).toMatchObject({ jsonBody: { reopenedCheckouts: 2 } });
    expect(world.checkouts.every((c) => c.CheckedInAt === null)).toBe(true);
  });

  it("leaves everything as it was when the restore fails", async () => {
    await call("reportKeyLost", { Id: 7 });
    events = [];
    db.closeConnection.mockClear();
    boom(/UPDATE dbo\.Keys SET IsDeleted = 0/);
    expect((await call("restoreKey", { Id: 7 })).status).toBe(500);
    expect(theKey().Status).toBe("lost");
    expect(theCheckout(3).CheckedInAt).toBe(T1);
    endedBy("rollback");
    expect(planner.syncKeyLostReportedStandalone).toHaveBeenCalledTimes(1); // the report's, not the failed restore's
  });

  it("refuses a key that is already active, and one that is not there", async () => {
    expect(await call("restoreKey", { Id: 7 })).toMatchObject({ jsonBody: { code: "ALREADY_ACTIVE" }, status: 409 });
    expect(await call("restoreKey", { Id: 99 })).toMatchObject({ jsonBody: { code: "KEY_NOT_FOUND" }, status: 404 });
  });
});

// ── checkoutKeys ─────────────────────────────────────────────────────────────

describe("checkoutKeys", () => {
  const HANDOVER = { CheckOutPhotoBlobUrl: "keys/handover.jpg", CheckedOutTo: "Bob", ExpectedReturnAt: "2026-06-03T09:00:00Z", KeyIds: [8, 7] };
  beforeEach(() => {
    world.keys = [key(), key({ Id: 8, KeyNumber: "K-008" }), key({ Id: 9, ItemType: "code", KeyNumber: "C-009" })];
  });
  const checkOut = (over: Row = {}) => call("checkoutKeys", { ...HANDOVER, ...over });

  it("locks the keys, checks them, and writes the batch and its checkouts, in one transaction", async () => {
    const res = await checkOut({ StorageLocation: "Van 2" });
    expect(res).toMatchObject({ jsonBody: { batchId: 100 }, status: 200 });
    expect(events).toEqual([
      "begin", "lock-keys", "already-out", "insert-batch",
      "insert-checkout", "set-location", "insert-checkout", "set-location", "commit",
    ]);
    expect(world.checkouts.map((c) => [c.KeyId, c.CheckedInAt])).toEqual([[8, null], [7, null]]);
    expect([theKey(7).StorageLocation, theKey(8).StorageLocation]).toEqual(["Van 2", "Van 2"]);
  });

  it("locks every key, in Id order, before it looks at any of their checkouts", async () => {
    await checkOut();
    const sql = db.executeQuery.mock.calls.map((c) => c[1] as string);
    expect(sql[0]).toMatch(/FROM dbo\.Keys WITH \(UPDLOCK, ROWLOCK\)\s+WHERE Id IN \(@K0,@K1\) ORDER BY Id/);
    expect(sql[1]).toMatch(/JOIN dbo\.KeyCheckouts kco/);
  });

  it("counts only physical keys as out, and only checkouts that are still open", async () => {
    await checkOut();
    const sql = statement(/JOIN dbo\.KeyCheckouts kco/);
    expect(sql).toMatch(/kco\.CheckedInAt IS NULL/);
    expect(sql).toMatch(/k\.ItemType = 'key'/);
  });

  it("refuses a key that is already out, and a second handover of the same key right after", async () => {
    expect((await checkOut()).status).toBe(200);
    events = [];
    const again = await checkOut({ KeyIds: [7] });
    expect(again).toMatchObject({ jsonBody: { code: "ALREADY_CHECKED_OUT", error: "Already checked out: K-007" }, status: 409 });
    expect(events).toEqual(["begin", "lock-keys", "already-out", "rollback"]);
    expect(world.checkouts).toHaveLength(2);
  });

  it.each([
    ["a key that is not there", { KeyIds: [7, 99] }, 404, "KEY_NOT_FOUND"],
    ["a key that is archived", { KeyIds: [7] }, 409, "KEY_DELETED"],
    ["a key that is lost", { KeyIds: [7] }, 409, "KEY_NOT_ACTIVE"],
    ["a physical key with no handover photo", { CheckOutPhotoBlobUrl: "", KeyIds: [7] }, 400, "PHOTO_REQUIRED"],
  ])("writes nothing for %s", async (label, over, status, code) => {
    if (label.includes("archived")) world.keys[0] = key({ IsDeleted: 1 });
    if (label.includes("lost")) world.keys[0] = key({ Status: "lost" });
    const res = await checkOut(over);
    expect(res).toMatchObject({ jsonBody: { code }, status });
    expect(world.batches).toHaveLength(0);
    expect(world.checkouts).toHaveLength(0);
    expect(events.at(-1)).toBe("rollback");
    endedBy("rollback");
  });

  it("lets a code be shared again and again, with no photo, since nothing is handed over", async () => {
    const first = await checkOut({ CheckOutPhotoBlobUrl: "", KeyIds: [9] });
    const second = await checkOut({ CheckOutPhotoBlobUrl: "", KeyIds: [9] });
    expect([first.status, second.status]).toEqual([200, 200]);
    expect(world.checkouts).toHaveLength(2);
  });

  it("leaves no half a handover when a write fails part way", async () => {
    let inserts = 0;
    const executeQuery = db.executeQuery.getMockImplementation() as (...args: unknown[]) => Promise<unknown>;
    db.executeQuery.mockImplementation(async (connection: unknown, sql: string, params: Param[]) => {
      if (/INSERT INTO dbo\.KeyCheckouts/.test(sql) && ++inserts === 2) throw new Error("The write failed");
      return executeQuery(connection, sql, params);
    });
    const res = await checkOut();
    expect(res.status).toBe(500);
    expect(world.batches).toHaveLength(0);
    expect(world.checkouts).toHaveLength(0);
    expect(events).toEqual(["begin", "lock-keys", "already-out", "insert-batch", "insert-checkout", "rollback"]);
    endedBy("rollback");
    // and the keys can be handed over once the fault is gone
    db.executeQuery.mockImplementation(executeQuery);
    expect((await checkOut()).status).toBe(200);
  });

  it("does not move a storage location unless the whole handover is written", async () => {
    boom(/INSERT INTO dbo\.KeyCheckouts/);
    expect((await checkOut({ StorageLocation: "Van 2" })).status).toBe(500);
    expect(theKey(7).StorageLocation).toBe("Cabinet B");
  });

  it("answers 409 when the signature was used by another handover in the meantime", async () => {
    attachment = { BlobName: "keys/sig.png", ContentType: "image/png", Id: 55, LinkedBatchId: null, UploadedBy: "oid-ann" };
    boom(/INSERT INTO dbo\.KeyCheckoutBatches/);
    (failOn as { error: Error }).error = new Error("Cannot insert duplicate key row ... unique index 'UX_KeyCheckoutBatches_SignatureAttachmentId'.");
    const res = await checkOut({ SignatureAttachmentId: 55 });
    expect(res).toMatchObject({ jsonBody: { code: "SIGNATURE_ALREADY_USED" }, status: 409 });
    expect(world.batches).toHaveLength(0);
    endedBy("rollback");
  });

  it("still asks for the keys, who it is for and when they are due before it opens a connection", async () => {
    expect((await checkOut({ KeyIds: [] })).status).toBe(400);
    expect((await checkOut({ CheckedOutTo: "" })).status).toBe(400);
    expect(db.createRequestConnection).not.toHaveBeenCalled();
  });
});

// ── checkinKeys ──────────────────────────────────────────────────────────────

describe("checkinKeys", () => {
  beforeEach(() => {
    world.keys = [key({ StorageLocation: "Van 2" }), key({ Id: 8, KeyNumber: "K-008", StorageLocation: "Van 2" }), key({ Id: 9, KeyNumber: "K-009", StorageLocation: "Van 2" })];
    // one handover of three keys; K-008 already came back, with the location it was put in
    world.checkouts = [
      checkout({ BatchId: 1, Id: 1, KeyId: 7 }),
      checkout({ BatchId: 1, CheckInPhotoBlobUrl: "keys/back.jpg", CheckedInAt: T0, Id: 2, KeyId: 8 }),
      checkout({ BatchId: 1, Id: 3, KeyId: 9 }),
    ];
    theKey(8).StorageLocation = "Safe";
  });
  const checkIn = (over: Row = {}) => call("checkinKeys", { CheckInPhotoBlobUrl: "keys/return.jpg", CheckoutIds: [1], ...over });

  it("closes the checkouts and puts the keys in the location, in one transaction", async () => {
    const res = await checkIn({ StorageLocation: "Cabinet B" });
    expect(res).toMatchObject({ jsonBody: { checkedIn: [1], remainingInBatches: [{ batchId: 1, keyNumbers: ["K-009"] }] }, status: 200 });
    expect(events).toEqual(["begin", "owners", "lock-key-7", "close", "set-location", "commit"]);
    expect(theCheckout(1)).toMatchObject({ CheckInPhotoBlobUrl: "keys/return.jpg", CheckedInAt: T1 });
    expect(theKey(7).StorageLocation).toBe("Cabinet B");
  });

  it("locks the keys of the checkouts, in Id order, before it closes any of them", async () => {
    await checkIn({ CheckoutIds: [3, 1] });
    expect(events.slice(0, 4)).toEqual(["begin", "owners", "lock-key-7", "lock-key-9"]);
    expect(events.indexOf("close")).toBeGreaterThan(events.indexOf("lock-key-9"));
    expect(statement(/SELECT DISTINCT KeyId FROM dbo\.KeyCheckouts/)).toMatch(/ORDER BY KeyId/);
  });

  it("moves the location only for the checkouts it actually closes", async () => {
    const res = await checkIn({ CheckoutIds: [1, 2], StorageLocation: "Cabinet B" });
    expect((res.jsonBody as { checkedIn: number[] }).checkedIn).toEqual([1]);
    expect(theKey(7).StorageLocation).toBe("Cabinet B");
    expect(theKey(8).StorageLocation).toBe("Safe"); // already back; not this call's to move
    expect(theCheckout(2)).toMatchObject({ CheckInPhotoBlobUrl: "keys/back.jpg", CheckedInAt: T0 });
  });

  it("closes only the checkouts that are still open, and reports which", async () => {
    await checkIn();
    const sql = statement(/UPDATE dbo\.KeyCheckouts\s+SET CheckedInAt = SYSUTCDATETIME\(\)/);
    expect(sql).toMatch(/AND CheckedInAt IS NULL/);
    expect(sql).toMatch(/OUTPUT INSERTED\.Id, INSERTED\.KeyId/);
  });

  it("closes nothing and moves nothing when the same check-in is sent again", async () => {
    await checkIn({ StorageLocation: "Cabinet B" });
    theKey(7).StorageLocation = "Safe";
    events = [];
    const again = await checkIn({ StorageLocation: "Cabinet B" });
    expect((again.jsonBody as { checkedIn: number[] }).checkedIn).toEqual([]);
    expect(theKey(7).StorageLocation).toBe("Safe");
    expect(events).toEqual(["begin", "owners", "lock-key-7", "close", "commit"]);
  });

  it("writes no location at all when none was given", async () => {
    await checkIn();
    expect(events).toEqual(["begin", "owners", "lock-key-7", "close", "commit"]);
    expect(theKey(7).StorageLocation).toBe("Van 2");
  });

  it("leaves the checkout open when putting the key in its location fails", async () => {
    boom(/UPDATE dbo\.Keys SET StorageLocation = @Loc WHERE Id = @KeyId/);
    expect((await checkIn({ StorageLocation: "Cabinet B" })).status).toBe(500);
    expect(theCheckout(1).CheckedInAt).toBeNull();
    expect(theKey(7).StorageLocation).toBe("Van 2");
    endedBy("rollback");
  });

  it("still answers which keys of the batch are not back", async () => {
    const res = await checkIn({ CheckoutIds: [1, 3] });
    expect((res.jsonBody as { remainingInBatches: unknown[] }).remainingInBatches).toEqual([]);
    const partial = await call("checkinKeys", { CheckInPhotoBlobUrl: "keys/return.jpg", CheckoutIds: [2] });
    expect((partial.jsonBody as { checkedIn: number[] }).checkedIn).toEqual([]);
  });

  it("still asks for checkouts and a photo before it opens a connection", async () => {
    expect((await checkIn({ CheckoutIds: [] })).status).toBe(400);
    expect((await checkIn({ CheckInPhotoBlobUrl: "" })).status).toBe(400);
    expect(db.createRequestConnection).not.toHaveBeenCalled();
  });
});
