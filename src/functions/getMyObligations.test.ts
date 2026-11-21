/// <reference types="jest" />
import type { HttpRequest, InvocationContext } from "@azure/functions";

jest.mock("@azure/functions", () => ({ ...jest.requireActual("@azure/functions"), app: { http: jest.fn() } }));
jest.mock("../db", () => ({ closeConnection: jest.fn(), createRequestConnection: jest.fn().mockResolvedValue({}), executeQuery: jest.fn().mockResolvedValue([{ UserID: 7 }]) }));
jest.mock("../auth", () => ({
  ...jest.requireActual("../auth"),
  extractToken: jest.fn(),
  requireRole: jest.fn().mockResolvedValue(null),
  rolesForRequest: jest.fn().mockResolvedValue(["director"]),
  verifiedIdentityFromRequest: jest.fn().mockResolvedValue({ email: "d@example.test", name: "Dan Director", oid: "o7" }),
}));
jest.mock("../escalation/config", () => ({ chasingOn: () => false }));
jest.mock("../obligations/load", () => ({ loadObligations: jest.fn() }));

const auth = require("../auth") as { extractToken: jest.Mock; requireRole: jest.Mock };
const { loadObligations } = require("../obligations/load") as { loadObligations: jest.Mock };
const { getMyObligations } = require("./getMyObligations") as typeof import("./getMyObligations");
const { world } = require("../__tests__/fixtures/obligationsWorld") as typeof import("../__tests__/fixtures/obligationsWorld");

const call = () => getMyObligations({} as HttpRequest, { error: jest.fn() } as unknown as InvocationContext);

beforeEach(() => {
  auth.extractToken.mockReturnValue("token");
  auth.requireRole.mockResolvedValue(null);
});

it("answers 401 without a token and reads nothing", async () => {
  auth.extractToken.mockReturnValue(null);
  expect((await call()).status).toBe(401);
  expect(loadObligations).not.toHaveBeenCalled();
});

it("is open to every signed-in role: the gate it asks is the plain user gate", async () => {
  const { ctx, sources } = world();
  loadObligations.mockResolvedValue({ context: ctx, sources, unavailable: [] });
  await call();
  expect(auth.requireRole.mock.calls[0][1]).toEqual(["user"]);
});

it("scopes the answer to the caller from the token, and says whether chasing is on", async () => {
  const { ctx, sources } = world();
  loadObligations.mockResolvedValue({ context: ctx, sources, unavailable: ["leave"] });
  const response = await call();
  const body = response.jsonBody as { chasing: boolean; items: Array<{ id: string }>; totals: { decide: number }; unavailable: string[] };
  expect(response.status).toBe(200);
  expect(body.chasing).toBe(false);
  expect(body.unavailable).toEqual(["leave"]);
  expect(body.items.map((item) => item.id)).toContain("quote:1");
  expect(body.totals.decide).toBeGreaterThan(0);
});

it("answers 500 with a plain sentence when the read fails, never an empty list", async () => {
  loadObligations.mockRejectedValue(new Error("down"));
  const response = await call();
  expect(response.status).toBe(500);
  expect(JSON.stringify(response.jsonBody)).not.toContain("items");
});
