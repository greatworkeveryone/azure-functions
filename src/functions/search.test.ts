import { HttpRequest, InvocationContext } from "@azure/functions";
import { search } from "./search";

jest.mock("../auth", () => {
  const actual = jest.requireActual("../auth");
  return {
    ...actual,
    requireRole: jest.fn(),
    extractToken: jest.fn(() => "fake-token"),
  };
});

jest.mock("../db", () => ({
  createConnection: jest.fn(async () => ({})),
  closeConnection: jest.fn(),
  executeQuery: jest.fn(async () => []),
}));

import { requireRole } from "../auth";
import { executeQuery } from "../db";

function makeRequest(query: Record<string, string>): HttpRequest {
  return {
    query: { get: (k: string) => query[k] ?? null },
    headers: { get: () => null },
  } as unknown as HttpRequest;
}

const ctx = {} as InvocationContext;

beforeEach(() => {
  jest.clearAllMocks();
  (requireRole as jest.Mock).mockResolvedValue(null);
});

describe("search handler — scaffold behaviour", () => {
  it("returns 401 when no token is present", async () => {
    const { extractToken } = jest.requireMock("../auth");
    (extractToken as jest.Mock).mockReturnValueOnce(null);

    const res = await search(makeRequest({ q: "acme" }), ctx);
    expect(res.status).toBe(401);
  });

  it("returns 403 when requireRole denies", async () => {
    (requireRole as jest.Mock).mockResolvedValueOnce({ status: 403, jsonBody: { error: "x" } });

    const res = await search(makeRequest({ q: "acme" }), ctx);
    expect(res.status).toBe(403);
  });

  it("returns 400 when q is missing", async () => {
    const res = await search(makeRequest({}), ctx);
    expect(res.status).toBe(400);
  });

  it("returns 400 when q is empty after trim", async () => {
    const res = await search(makeRequest({ q: "   " }), ctx);
    expect(res.status).toBe(400);
  });

  it("returns 400 when q exceeds 100 chars", async () => {
    const res = await search(makeRequest({ q: "a".repeat(101) }), ctx);
    expect(res.status).toBe(400);
  });

  it("returns 200 with all four groups (empty arrays) on valid query", async () => {
    const res = await search(makeRequest({ q: "acme" }), ctx);
    expect(res.status).toBe(200);
    expect(res.jsonBody).toEqual({
      tenants: [],
      jobs: [],
      keys: [],
      buildings: [],
    });
  });

  it("runs all four entity queries", async () => {
    await search(makeRequest({ q: "acme" }), ctx);
    expect(executeQuery).toHaveBeenCalledTimes(4);
  });
});

describe("queryTenants", () => {
  it("matches LegalName or TradingName via parameterised LIKE", async () => {
    (executeQuery as jest.Mock).mockResolvedValueOnce([
      { id: 7, title: "Acme Holdings", subtitle: "Tower 1" },
    ]);

    const res = await search(makeRequest({ q: "acme" }), ctx);
    expect(res.status).toBe(200);
    expect(res.jsonBody?.tenants).toEqual([
      { id: 7, title: "Acme Holdings", subtitle: "Tower 1", href: "/tenancy/7" },
    ]);

    const firstCall = (executeQuery as jest.Mock).mock.calls[0];
    const [, sql, params] = firstCall;
    expect(sql).toMatch(/Tenants/);
    expect(sql).toMatch(/LegalName\s+LIKE\s+@q\s+ESCAPE\s+'\\'/);
    expect(sql).toMatch(/TradingName\s+LIKE\s+@q\s+ESCAPE\s+'\\'/);
    expect(sql).toMatch(/TOP\s+5/);
    expect(params).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "q",      value: "%acme%" }),
      expect.objectContaining({ name: "prefix", value: "acme%" }),
    ]));
  });

  it("escapes wildcards in user input", async () => {
    (executeQuery as jest.Mock).mockResolvedValueOnce([]);
    await search(makeRequest({ q: "50%" }), ctx);

    const [, , params] = (executeQuery as jest.Mock).mock.calls[0];
    expect(params).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "q",      value: "%50\\%%" }),
      expect.objectContaining({ name: "prefix", value: "50\\%%" }),
    ]));
  });
});

describe("queryJobs", () => {
  it("matches Job Title and returns jobs?jobId=… href", async () => {
    (executeQuery as jest.Mock)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { id: 4821, title: "Replace boiler", subtitle: "Open · Tower 1" },
      ]);

    const res = await search(makeRequest({ q: "boiler" }), ctx);
    expect(res.jsonBody?.jobs).toEqual([
      { id: 4821, title: "Replace boiler", subtitle: "Open · Tower 1", href: "/jobs?jobId=4821" },
    ]);

    const [, sql] = (executeQuery as jest.Mock).mock.calls[1];
    expect(sql).toMatch(/FROM\s+(?:dbo\.)?Jobs/);
    expect(sql).toMatch(/Title\s+LIKE\s+@q\s+ESCAPE\s+'\\'/);
    expect(sql).toMatch(/TOP\s+5/);
  });
});

describe("queryKeys", () => {
  it("matches KeyNumber, Description, Level and returns /keys/:id href", async () => {
    (executeQuery as jest.Mock)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { id: 12, title: "K-104", subtitle: "L2 · Tower 1" },
      ]);

    const res = await search(makeRequest({ q: "K-104" }), ctx);
    expect(res.jsonBody?.keys).toEqual([
      { id: 12, title: "K-104", subtitle: "L2 · Tower 1", href: "/keys/12" },
    ]);

    const [, sql] = (executeQuery as jest.Mock).mock.calls[2];
    expect(sql).toMatch(/FROM\s+(?:dbo\.)?\[Keys\]/);
    expect(sql).toMatch(/KeyNumber\s+LIKE\s+@q\s+ESCAPE\s+'\\'/);
    expect(sql).toMatch(/Description\s+LIKE\s+@q\s+ESCAPE\s+'\\'/);
    expect(sql).toMatch(/TOP\s+5/);
  });
});

describe("queryBuildings", () => {
  it("matches BuildingName/BuildingCode and links to /tenancy?buildingId=…", async () => {
    (executeQuery as jest.Mock)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { id: 3, title: "Acme Tower", subtitle: "ACT" },
      ]);

    const res = await search(makeRequest({ q: "acme" }), ctx);
    expect(res.jsonBody?.buildings).toEqual([
      { id: 3, title: "Acme Tower", subtitle: "ACT", href: "/tenancy?buildingId=3" },
    ]);

    const [, sql] = (executeQuery as jest.Mock).mock.calls[3];
    expect(sql).toMatch(/FROM\s+(?:dbo\.)?Buildings/);
    expect(sql).toMatch(/BuildingName\s+LIKE\s+@q\s+ESCAPE\s+'\\'/);
    expect(sql).toMatch(/BuildingCode\s+LIKE\s+@q\s+ESCAPE\s+'\\'/);
    expect(sql).toMatch(/TOP\s+5/);
  });
});

describe("SQL injection defence", () => {
  it("never interpolates the raw query string into the SQL text", async () => {
    const dangerous = "'; DROP TABLE Tenants; --";
    await search(makeRequest({ q: dangerous }), ctx);

    for (const call of (executeQuery as jest.Mock).mock.calls) {
      const [, sql] = call;
      expect(sql).not.toContain(dangerous);
      expect(sql).not.toContain("DROP");
    }
  });

  it("passes user input only via @q / @prefix parameters", async () => {
    await search(makeRequest({ q: "anything" }), ctx);

    for (const call of (executeQuery as jest.Mock).mock.calls) {
      const [, , params] = call;
      for (const p of params) {
        expect(["q", "prefix"]).toContain(p.name);
      }
    }
  });

  it("escapes a literal % so it doesn't act as a wildcard", async () => {
    await search(makeRequest({ q: "abc%def" }), ctx);
    const [, , params] = (executeQuery as jest.Mock).mock.calls[0];
    const q = params.find((p: any) => p.name === "q");
    expect(q.value).toBe("%abc\\%def%");
  });

  it("escapes a literal _ so it doesn't match any single char", async () => {
    await search(makeRequest({ q: "abc_def" }), ctx);
    const [, , params] = (executeQuery as jest.Mock).mock.calls[0];
    const q = params.find((p: any) => p.name === "q");
    expect(q.value).toBe("%abc\\_def%");
  });
});
