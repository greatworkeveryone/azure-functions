jest.mock("../db", () => ({
  beginTransaction: jest.fn().mockResolvedValue(undefined),
  closeConnection: jest.fn(),
  commitTransaction: jest.fn().mockResolvedValue(undefined),
  createServiceRequestConnection: jest.fn().mockResolvedValue({ conn: true }),
  executeQuery: jest.fn(),
  rollbackTransaction: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../ledger", () => ({ ...jest.requireActual("../ledger"), record: jest.fn().mockResolvedValue(undefined) }));

import {
  _resetAccessLedgerMemoForTests,
  _setAccessLoggingForTests,
  accessLoggingEnabled,
  noteAccess,
  noteMoneyAction,
  noteSignIn,
  observationFromRequest,
  recordAccess,
  type AccessObservation,
} from "./accessEvents";
import { _resetSamplingForTests, BURST_LIMIT } from "./sampling";

const db = jest.requireMock("../db") as Record<string, jest.Mock>;
const ledger = jest.requireMock("../ledger") as { record: jest.Mock };

type Param = { name: string; value: unknown };
const paramsOf = (call: unknown[]): Record<string, unknown> =>
  Object.fromEntries((call[2] as Param[]).map((p) => [p.name, p.value]));
const insertCall = (): unknown[] | undefined =>
  db.executeQuery.mock.calls.find((c) => String(c[1]).includes("INSERT INTO dbo.AccessEvents"));

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(() => setImmediate(resolve)));

function req(headers: Record<string, string>) {
  return { headers: { get: (name: string) => headers[name.toLowerCase()] ?? null } };
}

// 10:00 Darwin on a Thursday.
const DAYTIME = new Date("2026-10-15T00:30:00Z");

function observation(overrides: Partial<AccessObservation> = {}): AccessObservation {
  return {
    at: DAYTIME,
    burst: false,
    country: "AU",
    detail: null,
    ipHash: "a".repeat(32),
    kind: "request",
    oid: "oid-1",
    userAgentHash: "b".repeat(32),
    ...overrides,
  };
}

function context(row: Record<string, unknown>): void {
  db.executeQuery.mockImplementation(async (_c: unknown, sql: string) =>
    sql.includes("FROM (SELECT 1 AS One)") ? [{ AccessProfile: null, DeviceSeen: 1, HasHistory: 1, Role: "accounts", UserID: 7, ...row }] : [],
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "warn").mockImplementation(() => {});
  _resetSamplingForTests();
  _resetAccessLedgerMemoForTests();
  _setAccessLoggingForTests(null);
  db.createServiceRequestConnection.mockResolvedValue({ conn: true });
  context({});
});

afterEach(() => jest.restoreAllMocks());
afterAll(() => _setAccessLoggingForTests(null));

describe("observationFromRequest", () => {
  it("keeps hashes and the client's country claim, never the raw address or agent", () => {
    const obs = observationFromRequest(
      req({ "user-agent": "Mozilla/5.0", "x-forwarded-for": "203.0.113.5", "x-fp-country": "dk" }),
      "oid-1",
      "signin",
    );
    expect(obs).toMatchObject({ country: "DK", kind: "signin", oid: "oid-1" });
    expect(obs.ipHash).toMatch(/^[0-9a-f]{32}$/);
    expect(obs.userAgentHash).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(obs)).not.toMatch(/203\.0\.113\.5|Mozilla/);
  });

  it("drops a country claim that is not two letters", () => {
    expect(observationFromRequest(req({ "x-fp-country": "Australia" }), "o", "request").country).toBeNull();
  });
});

describe("recordAccess", () => {
  it("writes an ordinary event with no transaction and no ledger row", async () => {
    await expect(recordAccess(observation())).resolves.toEqual({ anomaly: "none" });
    const params = paramsOf(insertCall() as unknown[]);
    expect(params).toMatchObject({ Anomaly: "none", Country: "AU", Kind: "request", LocalHour: 10, Oid: "oid-1", Role: "accounts" });
    expect(db.beginTransaction).not.toHaveBeenCalled();
    expect(ledger.record).not.toHaveBeenCalled();
    expect(db.closeConnection).toHaveBeenCalledWith({ conn: true });
  });

  it("records an anomaly and its exception in one transaction", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    await expect(recordAccess(observation({ country: "US" }))).resolves.toEqual({ anomaly: "new_country" });
    expect(warn).toHaveBeenCalledWith(
      '[access] anomaly {"alsoFlagged":[],"anomaly":"new_country","country":"US","kind":"request","role":"accounts","userId":7}',
    );
    warn.mockRestore();
    expect(paramsOf(insertCall() as unknown[]).Anomaly).toBe("new_country");
    expect(db.beginTransaction).toHaveBeenCalledTimes(1);
    expect(ledger.record).toHaveBeenCalledWith(
      { conn: true },
      expect.objectContaining({
        action: "access.anomaly",
        actor: { kind: "system", name: "accessMonitor" },
        reason: "Used Floorplan from US, which is not one of this person's expected countries (AU).",
        ruleApplied: "new_country",
        subject: { id: 7, type: "app_user" },
      }),
    );
    expect(db.commitTransaction).toHaveBeenCalledTimes(1);
  });

  it("keeps the lesser findings in Detail", async () => {
    context({ DeviceSeen: 0 });
    await recordAccess(observation({ country: "US" }));
    expect(JSON.parse(paramsOf(insertCall() as unknown[]).Detail as string)).toEqual({ alsoFlagged: ["new_device"] });
  });

  it("ledgers the same finding for the same person once per few hours", async () => {
    await recordAccess(observation({ country: "US" }));
    await recordAccess(observation({ at: new Date(DAYTIME.getTime() + 60_000), country: "US" }));
    expect(ledger.record).toHaveBeenCalledTimes(1);
    expect(db.executeQuery.mock.calls.filter((c) => String(c[1]).includes("INSERT INTO dbo.AccessEvents"))).toHaveLength(2);
  });

  it("rolls back and rethrows when the ledger refuses", async () => {
    ledger.record.mockRejectedValueOnce(new Error("ledger down"));
    await expect(recordAccess(observation({ country: "US" }))).rejects.toThrow("ledger down");
    expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(db.closeConnection).toHaveBeenCalled();
  });

  it("uses the stored profile: Connor in Denmark is not an anomaly", async () => {
    context({
      AccessProfile: JSON.stringify({ callOutAllowed: false, countries: ["DK", "AU"], days: [1, 2, 3, 4, 5, 6, 7], hoursEnd: "24:00", hoursStart: "00:00", timeZone: "Europe/Copenhagen" }),
      Role: "admin",
    });
    await expect(recordAccess(observation({ country: "DK" }))).resolves.toEqual({ anomaly: "none" });
    expect(paramsOf(insertCall() as unknown[]).LocalHour).toBe(2);
  });

  it("records someone with no AppUsers row against their oid", async () => {
    context({ AccessProfile: null, Role: null, UserID: null });
    await recordAccess(observation({ country: "US" }));
    expect(ledger.record.mock.calls[0][1].subject).toEqual({ id: "oid-1", type: "app_user" });
  });

  it("treats the first device anyone uses as a baseline", async () => {
    context({ DeviceSeen: 0, HasHistory: 0 });
    await expect(recordAccess(observation())).resolves.toEqual({ anomaly: "none" });
  });
});

describe("the request-path hooks", () => {
  it("are off under Jest unless a test turns them on, and off when ACCESS_LOG_ENABLED is false", async () => {
    expect(accessLoggingEnabled()).toBe(false);
    noteAccess(req({}), "oid-1", ["accounts"]);
    noteSignIn(req({}), "oid-1");
    await flush();
    expect(db.executeQuery).not.toHaveBeenCalled();

    process.env.ACCESS_LOG_ENABLED = "false";
    process.env.NODE_ENV = "production";
    expect(accessLoggingEnabled()).toBe(false);
    process.env.NODE_ENV = "test";
    delete process.env.ACCESS_LOG_ENABLED;
  });

  it("samples the first request per person and never waits for the database", async () => {
    _setAccessLoggingForTests(true);
    let release: () => void = () => {};
    db.createServiceRequestConnection.mockReturnValue(new Promise((resolve) => (release = () => resolve({ conn: true }))));

    const started = Date.now();
    noteAccess(req({}), "oid-1", ["accounts"]);
    noteAccess(req({}), "oid-1", ["accounts"]);
    expect(Date.now() - started).toBeLessThan(50);
    expect(db.createServiceRequestConnection).not.toHaveBeenCalled();

    await flush();
    expect(db.createServiceRequestConnection).toHaveBeenCalledTimes(1);
    release();
    await flush();
    expect(paramsOf(insertCall() as unknown[]).Kind).toBe("request");
  });

  it("samples a second network or device separately, so a hijacker cannot hide in the owner's sample", async () => {
    _setAccessLoggingForTests(true);
    const owner = req({ "user-agent": "Owner/1.0", "x-forwarded-for": "203.0.113.5" });
    noteAccess(owner, "oid-1", ["accounts"]);
    noteAccess(owner, "oid-1", ["accounts"]);
    noteAccess(req({ "user-agent": "Owner/1.0", "x-forwarded-for": "198.51.100.20" }), "oid-1", ["accounts"]);
    noteAccess(req({ "user-agent": "Thief/2.0", "x-forwarded-for": "203.0.113.5" }), "oid-1", ["accounts"]);
    await flush();
    await flush();
    expect(db.executeQuery.mock.calls.filter((c) => String(c[1]).includes("INSERT INTO dbo.AccessEvents"))).toHaveLength(3);
  });

  it("ignores callers without a role or an oid", async () => {
    _setAccessLoggingForTests(true);
    noteAccess(req({}), "oid-1", []);
    noteAccess(req({}), null, ["accounts"]);
    await flush();
    expect(db.createServiceRequestConnection).not.toHaveBeenCalled();
  });

  it("records a burst once, on the request that crosses the limit", async () => {
    _setAccessLoggingForTests(true);
    for (let i = 0; i <= BURST_LIMIT; i += 1) noteAccess(req({}), "oid-1", ["accounts"]);
    await flush();
    await flush();
    const inserts = db.executeQuery.mock.calls.filter((c) => String(c[1]).includes("INSERT INTO dbo.AccessEvents"));
    expect(inserts).toHaveLength(2);
    expect(paramsOf(inserts[1]).Anomaly).toBe("burst");
  });

  it("records every sign-in and every money action", async () => {
    _setAccessLoggingForTests(true);
    noteSignIn(req({}), "oid-1");
    noteSignIn(req({}), "oid-1");
    noteMoneyAction(req({}), "oid-1", { outcome: "allowed", route: "markPaymentPaid" });
    await flush();
    await flush();
    const kinds = db.executeQuery.mock.calls
      .filter((c) => String(c[1]).includes("INSERT INTO dbo.AccessEvents"))
      .map((c) => paramsOf(c).Kind);
    expect(kinds.sort()).toEqual(["money", "signin", "signin"]);
  });

  it("logs and swallows a database failure", async () => {
    _setAccessLoggingForTests(true);
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    db.createServiceRequestConnection.mockRejectedValueOnce(new Error("sql down"));
    noteSignIn(req({}), "oid-1");
    await flush();
    expect(warn).toHaveBeenCalledWith("[access] could not record an access event:", "sql down");
    warn.mockRestore();
  });
});
