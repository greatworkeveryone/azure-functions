/// <reference types="jest" />
// The S10 endpoints: who may read the access log and edit profiles, input
// checks, and the ledger row on a profile change. DB mocked; auth runs the real
// requireRole through the dev-override header and an unsigned JWT.
import { HttpRequest, InvocationContext } from "@azure/functions";
import { clearRoleCache } from "../auth";
import { getAccessEvents } from "../functions/getAccessEvents";
import { getAccessProfiles } from "../functions/getAccessProfiles";
import { setAccessProfile } from "../functions/setAccessProfile";

jest.mock("@azure/functions", () => ({ ...jest.requireActual("@azure/functions"), app: { http: jest.fn() } }));
jest.mock("../db", () => ({
  beginTransaction: jest.fn().mockResolvedValue(undefined),
  closeConnection: jest.fn(),
  commitTransaction: jest.fn().mockResolvedValue(undefined),
  createRequestConnection: jest.fn().mockResolvedValue({}),
  executeQuery: jest.fn(),
  rollbackTransaction: jest.fn().mockResolvedValue(undefined),
}));

const db = jest.requireMock("../db") as Record<string, jest.Mock>;

function makeJwt(payload: Record<string, unknown>): string {
  const encode = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode(payload)}.sig`;
}

function makeRequest(opts: { body?: unknown; query?: Record<string, string>; roles?: string; token?: boolean }): HttpRequest {
  const headers: Record<string, string> = {};
  if (opts.token !== false) {
    headers.authorization = `Bearer ${makeJwt({ name: "Ada Admin", oid: "oid-ada", preferred_username: "ada@example.com" })}`;
  }
  if (opts.roles) headers["x-dev-roles"] = opts.roles;
  return {
    headers: { get: (key: string) => headers[key.toLowerCase()] ?? null },
    json: async () => opts.body,
    query: new URLSearchParams(opts.query ?? {}),
  } as unknown as HttpRequest;
}

const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;

function route(routes: Record<string, unknown[]>): void {
  db.executeQuery.mockImplementation(async (_c: unknown, sql: string) => {
    for (const [needle, rows] of Object.entries(routes)) if (sql.includes(needle)) return rows;
    return [];
  });
}

const GOOD_PROFILE = {
  callOutAllowed: false,
  countries: ["DK", "AU"],
  days: [1, 2, 3, 4, 5, 6, 7],
  hoursEnd: "24:00",
  hoursStart: "00:00",
  timeZone: "Europe/Copenhagen",
};

beforeAll(() => {
  process.env.DEV_ROLE_OVERRIDE_ENABLED = "true";
});
afterAll(() => {
  delete process.env.DEV_ROLE_OVERRIDE_ENABLED;
});
beforeEach(() => {
  jest.clearAllMocks();
  clearRoleCache();
  db.createRequestConnection.mockResolvedValue({});
  db.beginTransaction.mockResolvedValue(undefined);
  db.commitTransaction.mockResolvedValue(undefined);
  db.rollbackTransaction.mockResolvedValue(undefined);
  route({});
});

describe("getAccessEvents", () => {
  it("answers 401 without a token", async () => {
    expect((await getAccessEvents(makeRequest({ roles: "admin", token: false }), ctx)).status).toBe(401);
  });

  it.each(["accounts", "accounts_manager", "facilities", "facilities_manager"])("refuses %s", async (role) => {
    expect((await getAccessEvents(makeRequest({ roles: role }), ctx)).status).toBe(403);
  });

  it.each(["cfo", "director", "admin"])("lets %s read the last 7 days by default", async (role) => {
    route({
      "FROM dbo.AccessEvents": [
        {
          AccessEventId: 9,
          Anomaly: "new_country",
          At: new Date("2026-10-15T00:30:00Z"),
          Country: "US",
          Detail: '{"alsoFlagged":["new_device"]}',
          DisplayName: "Jane Smith",
          Kind: "signin",
          LocalHour: 10,
          Role: "accounts",
          UserID: 4,
        },
      ],
    });
    const res = await getAccessEvents(makeRequest({ roles: role }), ctx);
    expect(res.status).toBe(200);
    expect(res.jsonBody).toEqual({
      events: [
        {
          anomaly: "new_country",
          at: "2026-10-15T00:30:00.000Z",
          country: "US",
          detail: { alsoFlagged: ["new_device"] },
          displayName: "Jane Smith",
          id: 9,
          kind: "signin",
          localHour: 10,
          role: "accounts",
          userId: 4,
        },
      ],
      limit: 500,
    });
    const params = db.executeQuery.mock.calls[0][2] as { name: string; value: unknown }[];
    expect(Object.fromEntries(params.map((p) => [p.name, p.value]))).toEqual({ AnomaliesOnly: false, Days: 7, UserId: null });
  });

  it("filters by person and anomalies", async () => {
    await getAccessEvents(makeRequest({ query: { anomaliesOnly: "true", days: "30", userId: "4" }, roles: "admin" }), ctx);
    const params = db.executeQuery.mock.calls[0][2] as { name: string; value: unknown }[];
    expect(Object.fromEntries(params.map((p) => [p.name, p.value]))).toEqual({ AnomaliesOnly: true, Days: 30, UserId: 4 });
  });

  const BAD_QUERIES: Record<string, string>[] = [{ days: "0" }, { days: "31" }, { days: "x" }, { userId: "-1" }, { anomaliesOnly: "maybe" }];
  it.each(BAD_QUERIES)("refuses %j", async (query) => {
    expect((await getAccessEvents(makeRequest({ query, roles: "admin" }), ctx)).status).toBe(400);
  });
});

describe("getAccessProfiles", () => {
  it("is admin only", async () => {
    expect((await getAccessProfiles(makeRequest({ roles: "director" }), ctx)).status).toBe(403);
    expect((await getAccessProfiles(makeRequest({ roles: "cfo" }), ctx)).status).toBe(403);
  });

  it("returns stored profiles and role defaults", async () => {
    route({
      "FROM dbo.AppUsers WHERE IsActive = 1": [
        { AccessProfile: JSON.stringify(GOOD_PROFILE), DisplayName: "Connor", Email: "c@example.com", Role: "admin", UserID: 1 },
        { AccessProfile: null, DisplayName: "Fred", Email: "f@example.com", Role: "facilities", UserID: 2 },
      ],
    });
    const res = await getAccessProfiles(makeRequest({ roles: "admin" }), ctx);
    const profiles = (res.jsonBody as { profiles: { isDefault: boolean; profile: { callOutAllowed: boolean; timeZone: string } }[] }).profiles;
    expect(profiles[0]).toMatchObject({ isDefault: false, profile: { timeZone: "Europe/Copenhagen" } });
    expect(profiles[1]).toMatchObject({ isDefault: true, profile: { callOutAllowed: true, timeZone: "Australia/Darwin" } });
  });
});

describe("setAccessProfile", () => {
  const locked = (stored: string | null) => ({
    "SELECT UserID FROM dbo.AppUsers": [{ UserID: 1 }],
    "WITH (UPDLOCK, HOLDLOCK)": [{ AccessProfile: stored, Role: "admin" }],
  });

  it("is admin only", async () => {
    expect((await setAccessProfile(makeRequest({ body: { profile: GOOD_PROFILE, userId: 1 }, roles: "director" }), ctx)).status).toBe(403);
  });

  it.each([
    [{ profile: GOOD_PROFILE }, /userId/],
    [{ profile: { ...GOOD_PROFILE, countries: ["Denmark"] }, userId: 1 }, /countries/],
    [{ profile: { ...GOOD_PROFILE, timeZone: "Nowhere" }, userId: 1 }, /time zone/],
  ])("refuses %j", async (body, message) => {
    const res = await setAccessProfile(makeRequest({ body, roles: "admin" }), ctx);
    expect(res.status).toBe(400);
    expect((res.jsonBody as { error: string }).error).toMatch(message);
    expect(db.beginTransaction).not.toHaveBeenCalled();
  });

  it("saves the profile and ledgers before and after in one transaction", async () => {
    route(locked(null));
    const res = await setAccessProfile(makeRequest({ body: { profile: GOOD_PROFILE, userId: 1 }, roles: "admin" }), ctx);
    expect(res).toEqual({ jsonBody: { isDefault: false, profile: GOOD_PROFILE, userId: 1 }, status: 200 });
    const update = db.executeQuery.mock.calls.find((c) => String(c[1]).startsWith("UPDATE dbo.AppUsers SET AccessProfile"));
    expect(update?.[2][0].value).toBe(JSON.stringify(GOOD_PROFILE));
    const ledger = db.executeQuery.mock.calls.find((c) => String(c[1]).includes("INSERT INTO dbo.DecisionLedger"));
    const values = Object.fromEntries((ledger?.[2] as { name: string; value: unknown }[]).map((p) => [p.name, p.value]));
    expect(values).toMatchObject({ Action: "access.profile_change", ActorName: "Ada Admin", IsException: true, SubjectId: "1", SubjectType: "app_user" });
    expect(JSON.parse(values.Before as string)).toMatchObject({ isDefault: true, profile: { timeZone: "Australia/Darwin" } });
    expect(db.commitTransaction).toHaveBeenCalledTimes(1);
  });

  it("writes nothing when the profile is unchanged", async () => {
    route(locked(JSON.stringify(GOOD_PROFILE)));
    const res = await setAccessProfile(makeRequest({ body: { profile: GOOD_PROFILE, userId: 1 }, roles: "admin" }), ctx);
    expect(res.status).toBe(200);
    expect(db.executeQuery.mock.calls.some((c) => String(c[1]).startsWith("UPDATE"))).toBe(false);
    expect(db.executeQuery.mock.calls.some((c) => String(c[1]).includes("DecisionLedger"))).toBe(false);
  });

  it("resets to the role default with null", async () => {
    route(locked(JSON.stringify(GOOD_PROFILE)));
    const res = await setAccessProfile(makeRequest({ body: { profile: null, userId: 1 }, roles: "admin" }), ctx);
    expect((res.jsonBody as { isDefault: boolean }).isDefault).toBe(true);
    const update = db.executeQuery.mock.calls.find((c) => String(c[1]).startsWith("UPDATE dbo.AppUsers SET AccessProfile"));
    expect(update?.[2][0].value).toBeNull();
  });

  it("answers 404 for an unknown or inactive user", async () => {
    route({ "SELECT UserID FROM dbo.AppUsers": [{ UserID: 1 }] });
    const res = await setAccessProfile(makeRequest({ body: { profile: GOOD_PROFILE, userId: 99 }, roles: "admin" }), ctx);
    expect(res.status).toBe(404);
    expect(db.rollbackTransaction).toHaveBeenCalled();
  });

  it("rolls back when the ledger write fails", async () => {
    db.executeQuery.mockImplementation(async (_c: unknown, sql: string) => {
      if (sql.includes("WITH (UPDLOCK, HOLDLOCK)")) return [{ AccessProfile: null, Role: "admin" }];
      if (sql.includes("SELECT UserID FROM dbo.AppUsers")) return [{ UserID: 1 }];
      if (sql.includes("DecisionLedger")) throw new Error("ledger down");
      return [];
    });
    const res = await setAccessProfile(makeRequest({ body: { profile: GOOD_PROFILE, userId: 1 }, roles: "admin" }), ctx);
    expect(res.status).toBe(500);
    expect(db.rollbackTransaction).toHaveBeenCalled();
    expect(db.commitTransaction).not.toHaveBeenCalled();
  });
});
