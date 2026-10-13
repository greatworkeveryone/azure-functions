/// <reference types="jest" />
// The escalations screen is staged through Admin -> Features like the other
// modules (frontend FeatureKey "escalations", hidden until switched on), so the
// feature-flag endpoint has to accept that key, and a cfo row.
import type { HttpRequest, InvocationContext } from "@azure/functions";
import { clearRoleCache } from "../auth";
import { upsertFeatureFlag } from "../functions/feature-flags";

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn() } };
});
jest.mock("../db", () => ({
  closeConnection: jest.fn(),
  createRequestConnection: jest.fn(),
  createServiceConnection: jest.fn(),
  executeQuery: jest.fn(),
}));
const db = require("../db") as { createRequestConnection: jest.Mock; executeQuery: jest.Mock };

function makeJwt(payload: Record<string, unknown>): string {
  const encode = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${encode({ alg: "none" })}.${encode(payload)}.sig`;
}

const request = (body: unknown): HttpRequest =>
  ({
    headers: {
      get: (key: string) =>
        ({ authorization: `Bearer ${makeJwt({ name: "Ada Admin", oid: "oid-ada", preferred_username: "ada@example.com" })}`, "x-dev-roles": "admin" })[key.toLowerCase()] ?? null,
    },
    json: async () => body,
  }) as unknown as HttpRequest;
const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
  clearRoleCache();
  process.env.DEV_ROLE_OVERRIDE_ENABLED = "true";
  db.createRequestConnection.mockResolvedValue({});
  db.executeQuery.mockResolvedValue([]);
});

describe("upsertFeatureFlag", () => {
  it("accepts the escalations module for any role, including the new cfo role", async () => {
    for (const roleName of ["facilities", "facilities_manager", "accounts_manager", "cfo", "director"]) {
      const res = await upsertFeatureFlag(request({ featureKey: "escalations", roleName, visibility: "hidden" }), ctx);
      expect(res.status).toBe(200);
    }
    expect(db.executeQuery).toHaveBeenCalledTimes(5);
  });

  it("still refuses a module it doesn't know", async () => {
    const res = await upsertFeatureFlag(request({ featureKey: "escalation", roleName: "cfo", visibility: "hidden" }), ctx);
    expect(res.status).toBe(400);
    expect(res.jsonBody).toMatchObject({ error: "Unknown featureKey: escalation" });
  });

  it("still refuses a role it doesn't know", async () => {
    const res = await upsertFeatureFlag(request({ featureKey: "escalations", roleName: "chief", visibility: "hidden" }), ctx);
    expect(res.status).toBe(400);
  });
});
