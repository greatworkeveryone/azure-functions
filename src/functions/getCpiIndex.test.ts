/// <reference types="jest" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HttpRequest, InvocationContext } from "@azure/functions";
import { AppRole, clearRoleCache } from "../auth";
import { getCpiIndex, VIEW_CPI_INDEX_ROLES } from "./getCpiIndex";

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn() } };
});

// The real auth module runs (extractToken, requireRole, the role lookup); only
// the database underneath it is faked, as in inspections-auth.test.ts.
jest.mock("../db", () => ({
  closeConnection: jest.fn(),
  createRequestConnection: jest.fn(),
  createServiceConnection: jest.fn(),
  executeQuery: jest.fn(),
}));

const db = require("../db") as {
  closeConnection: jest.Mock;
  createRequestConnection: jest.Mock;
  createServiceConnection: jest.Mock;
  executeQuery: jest.Mock;
};

interface Param {
  name: string;
  value: unknown;
}

function makeJwt(payload: Record<string, unknown>): string {
  const encode = (obj: unknown) =>
    Buffer.from(JSON.stringify(obj))
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  return `${encode({ alg: "none" })}.${encode(payload)}.sig`;
}

function makeRequest(
  oid: string | null,
  query: Record<string, string> = {},
): HttpRequest {
  const headers: Record<string, string> = oid
    ? { authorization: `Bearer ${makeJwt({ oid })}` }
    : {};
  return {
    headers: { get: (key: string) => headers[key.toLowerCase()] ?? null },
    query: { get: (key: string) => query[key] ?? null },
  } as unknown as HttpRequest;
}

const context = { error: jest.fn(), log: jest.fn(), warn: jest.fn() };
const ctx = context as unknown as InvocationContext;

let roleByOid: Record<string, string | null>;
let cpiRows: Array<Record<string, unknown>>;
let cpiQueries: Array<{ sql: string; params: Param[] }>;

const originalEnv = {
  DEV_ROLE_OVERRIDE_ENABLED: process.env.DEV_ROLE_OVERRIDE_ENABLED,
  AZURE_FUNCTIONS_ENVIRONMENT: process.env.AZURE_FUNCTIONS_ENVIRONMENT,
};

afterAll(() => {
  for (const [name, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

beforeEach(() => {
  jest.clearAllMocks();
  clearRoleCache();
  process.env.DEV_ROLE_OVERRIDE_ENABLED = "true";
  delete process.env.AZURE_FUNCTIONS_ENVIRONMENT;
  roleByOid = {};
  cpiRows = [];
  cpiQueries = [];
  db.createServiceConnection.mockResolvedValue({});
  db.createRequestConnection.mockResolvedValue({});
  db.executeQuery.mockImplementation(async (_conn: unknown, sql: string, params: Param[] = []) => {
    if (sql.includes("dbo.AppUsers")) {
      const oid = params.find((p) => p.name === "Oid")?.value as string;
      const role = roleByOid[oid];
      return role ? [{ Role: role }] : [];
    }
    if (sql.includes("dbo.CpiIndex")) {
      cpiQueries.push({ sql, params });
      return cpiRows;
    }
    throw new Error(`unexpected query: ${sql}`);
  });
});

function asRole(role: string | null, oid = `oid-${role}`): string {
  roleByOid[oid] = role;
  return oid;
}

describe("getCpiIndex — authorisation", () => {
  it("is gated on exactly the tenancy register's viewers", () => {
    expect([...VIEW_CPI_INDEX_ROLES].sort()).toEqual(
      [AppRole.ACCOUNTS, AppRole.ACCOUNTS_APPROVAL, AppRole.ADMIN, AppRole.DIRECTOR].sort(),
    );
  });

  // tenancy.ts inlines its role list in every handler. Importing it is not
  // possible without touching that file, so compare against its source: if the
  // register's read gate changes, this fails until getCpiIndex follows.
  it.each(["getRegisterTenants", "getRegisterTenant"])(
    "matches the role gate of %s in tenancy.ts",
    (handlerName) => {
      const source = readFileSync(join(__dirname, "tenancy.ts"), "utf8");
      const start = source.indexOf(`async function ${handlerName}(`);
      expect(start).toBeGreaterThan(-1);
      const gate = source.slice(start).match(/requireRole\(request, \[([^\]]*)\]\)/);
      expect(gate).not.toBeNull();
      const names = [...(gate as RegExpMatchArray)[1].matchAll(/AppRole\.([A-Z_]+)/g)].map(
        (m) => AppRole[m[1] as keyof typeof AppRole],
      );
      expect(names.sort()).toEqual([...VIEW_CPI_INDEX_ROLES].sort());
    },
  );

  it("answers 401 without a bearer token, before any query", async () => {
    const response = await getCpiIndex(makeRequest(null, { region: "AUS" }), ctx);
    expect(response.status).toBe(401);
    expect(cpiQueries).toHaveLength(0);
  });

  it.each(["accounts", "accounts_manager", "admin", "director"])(
    "lets %s read the index",
    async (role) => {
      const response = await getCpiIndex(makeRequest(asRole(role), { region: "AUS" }), ctx);
      expect(response.status).toBe(200);
    },
  );

  it.each(["facilities", "facilities_manager", "user"])(
    "answers 403 to %s without querying CpiIndex",
    async (role) => {
      const response = await getCpiIndex(makeRequest(asRole(role), { region: "AUS" }), ctx);
      expect(response.status).toBe(403);
      expect(cpiQueries).toHaveLength(0);
      expect(db.createRequestConnection).not.toHaveBeenCalled();
    },
  );

  it("answers 403 to an account with no role assigned", async () => {
    const response = await getCpiIndex(makeRequest(asRole(null, "oid-pending"), { region: "AUS" }), ctx);
    expect(response.status).toBe(403);
    expect(cpiQueries).toHaveLength(0);
  });
});

describe("getCpiIndex — query validation", () => {
  const caller = () => makeRequest(asRole("accounts"), {});
  const withQuery = (query: Record<string, string>) =>
    makeRequest(asRole("accounts"), query);

  it("requires a region", async () => {
    const response = await getCpiIndex(caller(), ctx);
    expect(response.status).toBe(400);
    expect(response.jsonBody).toEqual({ error: "region must be one of AUS, DARWIN" });
    expect(cpiQueries).toHaveLength(0);
  });

  it("rejects an unknown region", async () => {
    const response = await getCpiIndex(withQuery({ region: "SYDNEY" }), ctx);
    expect(response.status).toBe(400);
  });

  it.each(["2025Q1", "2025-Q5", "2025-q", "garbage", "2025-Q1; DROP TABLE dbo.CpiIndex"])(
    "rejects from=%s",
    async (from) => {
      const response = await getCpiIndex(withQuery({ region: "AUS", from }), ctx);
      expect(response.status).toBe(400);
      expect(response.jsonBody).toEqual({ error: "from must be a quarter such as 2025-Q4" });
      expect(cpiQueries).toHaveLength(0);
    },
  );

  it("normalises region and from case, and binds both as parameters", async () => {
    const response = await getCpiIndex(withQuery({ region: " darwin ", from: "2025-q3" }), ctx);
    expect(response.status).toBe(200);
    expect(cpiQueries).toHaveLength(1);
    expect(cpiQueries[0].params.map((p) => [p.name, p.value])).toEqual([
      ["Region", "DARWIN"],
      ["From", "2025-Q3"],
    ]);
    expect(cpiQueries[0].sql).toMatch(/Region = @Region AND Period >= @From/);
    expect(cpiQueries[0].sql).not.toMatch(/SELECT\s+\*/i);
  });

  it("reads from the beginning when from is omitted", async () => {
    await getCpiIndex(withQuery({ region: "AUS" }), ctx);
    expect(cpiQueries[0].params.find((p) => p.name === "From")?.value).toBe("0000-Q1");
  });
});

describe("getCpiIndex — response", () => {
  const row = (period: string, value: number, extra: Record<string, unknown> = {}) => ({
    Period: period,
    IndexValue: value,
    ReferenceBase: "Sep 2025 = 100.0",
    SourceKey: "1.10001.10.7.Q",
    Dataflow: "CPI 2.0.0",
    FetchedAt: new Date("2026-10-13T03:00:05.000Z"),
    ...extra,
  });

  it("returns periods in order with the latest base, source and last-confirmed time", async () => {
    cpiRows = [
      row("2026-Q1", 101.27),
      row("2026-Q2", 102.35, { FetchedAt: new Date("2026-10-14T03:00:09.500Z") }),
    ];
    const response = await getCpiIndex(makeRequest(asRole("director"), { region: "DARWIN" }), ctx);

    expect(response.status).toBe(200);
    expect(response.jsonBody).toEqual({
      region: "DARWIN",
      latestPeriod: "2026-Q2",
      referenceBase: "Sep 2025 = 100.0",
      dataflow: "CPI 2.0.0",
      sourceKey: "1.10001.10.7.Q",
      fetchedAt: "2026-10-14T03:00:09.500Z",
      periods: [
        { period: "2026-Q1", indexValue: 101.27, referenceBase: "Sep 2025 = 100.0" },
        { period: "2026-Q2", indexValue: 102.35, referenceBase: "Sep 2025 = 100.0" },
      ],
    });
  });

  it("returns numbers for decimals however the driver delivers them", async () => {
    cpiRows = [row("2026-Q2", "102.350" as unknown as number)];
    const response = await getCpiIndex(makeRequest(asRole("admin"), { region: "DARWIN" }), ctx);
    expect((response.jsonBody as { periods: Array<{ indexValue: unknown }> }).periods[0].indexValue).toBe(102.35);
  });

  it("keeps each period's own base so a consumer can refuse to mix bases", async () => {
    cpiRows = [
      row("2025-Q4", 140.1, { ReferenceBase: "Dec 2011 = 100.0" }),
      row("2026-Q1", 101.27, { ReferenceBase: null }),
      row("2026-Q2", 102.35),
    ];
    const response = await getCpiIndex(makeRequest(asRole("admin"), { region: "DARWIN" }), ctx);
    const body = response.jsonBody as { periods: Array<{ referenceBase: string | null }> };
    expect(body.periods.map((p) => p.referenceBase)).toEqual([
      "Dec 2011 = 100.0",
      null,
      "Sep 2025 = 100.0",
    ]);
  });

  it("answers an empty table with 200 and no periods", async () => {
    const response = await getCpiIndex(makeRequest(asRole("accounts"), { region: "AUS" }), ctx);
    expect(response.status).toBe(200);
    expect(response.jsonBody).toEqual({
      region: "AUS",
      latestPeriod: null,
      referenceBase: null,
      dataflow: null,
      sourceKey: null,
      fetchedAt: null,
      periods: [],
    });
  });

  it("answers 500 with a generic message when the query fails, and closes the connection", async () => {
    const connection = {};
    db.createRequestConnection.mockResolvedValue(connection);
    db.executeQuery.mockImplementation(async (_c: unknown, sql: string) => {
      if (sql.includes("dbo.AppUsers")) return [{ Role: "accounts" }];
      throw new Error("Invalid object name 'dbo.CpiIndex'");
    });
    const response = await getCpiIndex(makeRequest("oid-db-failure", { region: "AUS" }), ctx);

    expect(response.status).toBe(500);
    expect((response.jsonBody as { error: string }).error).toBe("Failed to fetch CPI index");
    expect(db.closeConnection).toHaveBeenCalledWith(connection);
  });
});
