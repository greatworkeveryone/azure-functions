/// <reference types="jest" />
// Parity (beta sprint J4): the who-can-do-what table says the same as the
// handlers. Every route an entry lists is called once per role, with the
// database, Graph and the token mocked, and the role either gets a 403 from the
// gate or gets past it. Each route must let through at least the roles the
// frontend is told may act (rolesFor) and no role outside the gate. A handler
// that widens or narrows its own allowlist without the table fails here; so
// does a table entry that offers a role a route refuses.
import type { HttpRequest, InvocationContext } from "@azure/functions";
import { readdirSync } from "fs";
import { join } from "path";

export {};

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  const register = jest.fn();
  return {
    ...actual,
    app: {
      hook: { appStart: jest.fn(), appTerminate: jest.fn(), postInvocation: jest.fn(), preInvocation: jest.fn() },
      http: register,
      serviceBusQueue: register,
      setup: jest.fn(),
      storageQueue: register,
      timer: register,
    },
    output: { serviceBusQueue: jest.fn(() => ({})), storageQueue: jest.fn(() => ({})) },
  };
});
jest.mock("../db", () => ({
  beginTransaction: jest.fn().mockResolvedValue(undefined),
  buildUpdateSet: jest.requireActual("../db").buildUpdateSet,
  closeConnection: jest.fn(),
  commitTransaction: jest.fn().mockResolvedValue(undefined),
  createRequestConnection: jest.fn().mockResolvedValue({}),
  createServiceConnection: jest.fn().mockResolvedValue({}),
  createServiceRequestConnection: jest.fn().mockResolvedValue({}),
  executeQuery: jest.fn().mockResolvedValue([]),
  rollbackTransaction: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../auth", () => {
  const actual = jest.requireActual("../auth");
  const state: { roles: string[] } = { roles: [] };
  return {
    ...actual,
    __state: state,
    extractToken: jest.fn(() => "token"),
    nameFromToken: jest.fn(() => "Sweep Tester"),
    oidFromToken: jest.fn(() => "sweep-oid"),
    userInfoFromToken: jest.fn(() => ({ email: "sweep@example.com", name: "Sweep Tester" })),
    requireRole: jest.fn(async (_request: unknown, allowed: readonly string[]) =>
      actual.rolesPassGate(state.roles, allowed) ? null : actual.forbiddenResponse("gate"),
    ),
    rolesForRequest: jest.fn(async () => state.roles),
    verifiedIdentityFromRequest: jest.fn(async () => ({ email: "sweep@example.com", name: "Sweep Tester", oid: "sweep-oid" })),
    verifiedRequestClaims: jest.fn(async () => ({ amr: ["mfa"], auth_time: Math.floor(Date.now() / 1000), oid: "sweep-oid" })),
  };
});
jest.mock("../sentry", () => ({ ...jest.requireActual("../sentry"), Sentry: { captureException: jest.fn(), captureMessage: jest.fn() } }));

type Handler = (request: HttpRequest, context: InvocationContext) => Promise<{ status?: number } | undefined>;

const auth = require("../auth") as { __state: { roles: string[] } };
const { ACTION_ROLES, ALL_ROLES, admittedBy, rolesFor } = require("../action-roles") as typeof import("../action-roles");

// Load every handler module so app.http has seen every route.
const FUNCTIONS = join(__dirname, "..", "functions");
for (const file of readdirSync(FUNCTIONS)) {
  if (file.endsWith(".ts") && !file.endsWith(".test.ts")) require(join(FUNCTIONS, file));
}
const { app } = require("@azure/functions") as { app: { http: jest.Mock } };
const ROUTES = new Map<string, Handler>();
for (const call of app.http.mock.calls) {
  const options = call[1] as { handler?: Handler } | undefined;
  if (typeof call[0] === "string" && options?.handler) ROUTES.set(call[0], options.handler);
}

// A route whose gate is the outer requireRole of another entry and whose own
// list is checked further in (a literal check on a record) is swept with a
// record that makes the inner check decide: here, a job someone else created,
// so only archiveAnyJob's roles may archive it.
type Probe = { body: Record<string, unknown>; rows: (sql: string) => Record<string, unknown>[] };
const PROBES: Record<string, Probe> = {
  "archiveAnyJob:archiveJob": {
    body: { JobID: 41 },
    rows: (sql) => (/SELECT CreatedBy, CreatedById, IsArchived FROM Jobs/.test(sql) ? [{ CreatedBy: "Someone Else", CreatedById: "someone-else-oid", IsArchived: false }] : []),
  },
};
const db = require("../db") as { executeQuery: jest.Mock };
let body: Record<string, unknown> = {};

function request(): HttpRequest {
  return {
    headers: { get: (name: string) => (name.toLowerCase() === "authorization" ? "Bearer token" : null) },
    json: async () => body,
    method: "POST",
    params: {},
    query: new URLSearchParams(),
    text: async () => "",
    url: "http://localhost/api/sweep",
  } as unknown as HttpRequest;
}
const context = { error: jest.fn(), log: jest.fn(), trace: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;

/** The roles a route lets past its gate: anything but a 403 counts as past. */
async function passing(handler: Handler): Promise<string[]> {
  const out: string[] = [];
  for (const role of ALL_ROLES) {
    auth.__state.roles = [role];
    let status: number | undefined;
    try {
      const res = await Promise.race([
        handler(request(), context),
        new Promise<{ status: number }>((resolve) => setTimeout(() => resolve({ status: 200 }), 1500)),
      ]);
      status = res?.status;
    } catch {
      status = 500;
    }
    // A 401 would mean the sweep never reached the gate: the mocks above must prevent it.
    if (status === 401) throw new Error(`401 before the gate for ${role}`);
    if (status !== 403) out.push(role);
  }
  return out;
}


const CASES = (Object.keys(ACTION_ROLES) as (keyof typeof ACTION_ROLES)[]).flatMap((capability) =>
  (ACTION_ROLES[capability].routes as readonly string[]).map((route) => [capability, route] as const),
);

beforeAll(() => {
  jest.spyOn(console, "error").mockImplementation(() => undefined);
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
  jest.spyOn(console, "log").mockImplementation(() => undefined);
});

describe("every route in the table lets through exactly what it says", () => {
  it("probes only routes the table lists", () => {
    const listed = new Set(CASES.map(([capability, route]) => `${capability}:${route}`));
    expect(Object.keys(PROBES).filter((key) => !listed.has(key))).toEqual([]);
  });

  it.each(CASES)("%s: %s", async (capability, route) => {
    const handler = ROUTES.get(route);
    expect({ registered: Boolean(handler), route }).toEqual({ registered: true, route });
    const probe = PROBES[`${capability}:${route}`];
    body = probe?.body ?? {};
    if (probe) db.executeQuery.mockImplementation(async (_connection: unknown, sql: string) => probe.rows(sql));
    let passed: string[];
    try {
      passed = await passing(handler!);
    } finally {
      body = {};
      db.executeQuery.mockReset().mockResolvedValue([]);
    }
    const entry = ACTION_ROLES[capability];
    // Everyone the frontend offers the action to gets past the gate (refused and
    // conditional roles aren't offered it)...
    expect({ missing: rolesFor(entry).filter((role) => !passed.includes(role)), route }).toEqual({ missing: [], route });
    // ...and nobody outside the gate does (a conditional role may).
    const admitted: readonly string[] = admittedBy(entry);
    expect({ extra: passed.filter((role) => !admitted.includes(role)), route }).toEqual({ extra: [], route });
  }, 60_000);
});
