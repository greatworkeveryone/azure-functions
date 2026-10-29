/// <reference types="jest" />
// getEmails treats `search` as a literal (LIKE wildcards escaped) and caps `statuses`.
import { HttpRequest, InvocationContext } from "@azure/functions";

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn(), storageQueue: jest.fn(), timer: jest.fn() } };
});
jest.mock("../db", () => ({ closeConnection: jest.fn(), createRequestConnection: jest.fn().mockResolvedValue({}), executeQuery: jest.fn() }));
jest.mock("../auth", () => ({
  ...jest.requireActual("../auth"),
  extractToken: jest.fn().mockReturnValue("tok"),
  requireRole: jest.fn().mockResolvedValue(null),
}));
jest.mock("../blob-storage", () => ({ generateReadSasUrl: jest.fn() }));
jest.mock("../rateLimit", () => ({ checkRateLimit: jest.fn() }));

import { getEmails } from "./emails";

const db = jest.requireMock("../db") as { executeQuery: jest.Mock };
const ctx = { error: jest.fn(), log: jest.fn() } as unknown as InvocationContext;
const get = (query: string) => ({ headers: { get: () => null }, query: new URLSearchParams(query) }) as unknown as HttpRequest;
const firstCall = () => {
  const [, sql, params] = db.executeQuery.mock.calls[0] as [unknown, string, { name: string; value: unknown }[]];
  return { params: Object.fromEntries(params.map((p) => [p.name, p.value])), sql };
};

beforeEach(() => {
  jest.clearAllMocks();
  db.executeQuery.mockResolvedValue([{ Total: 0 }]);
});

describe("getEmails search", () => {
  it("escapes LIKE wildcards and declares the escape character", async () => {
    await getEmails(get("search=50%25_off%5Bx%5D"), ctx);
    const { params, sql } = firstCall();
    expect(sql).toMatch(/FromAddress LIKE @Search ESCAPE '\\' OR Subject LIKE @Search ESCAPE '\\'/);
    expect(params.Search).toBe("%50\\%\\_off\\[x]%");
  });

  it("wraps plain text in wildcards unchanged", async () => {
    await getEmails(get("search=invoice"), ctx);
    expect(firstCall().params.Search).toBe("%invoice%");
  });
});

describe("getEmails statuses", () => {
  it("accepts up to 20 statuses", async () => {
    const res = await getEmails(get(`statuses=${Array.from({ length: 20 }, (_, i) => `s${i}`).join(",")}`), ctx);
    expect(res.status).toBe(200);
    expect(firstCall().sql).toMatch(/Status IN \(@S0, .*@S19\)/);
  });

  it("400 beyond 20 statuses without touching the database", async () => {
    const res = await getEmails(get(`statuses=${Array.from({ length: 21 }, (_, i) => `s${i}`).join(",")}`), ctx);
    expect(res.status).toBe(400);
    expect(db.executeQuery).not.toHaveBeenCalled();
  });
});
