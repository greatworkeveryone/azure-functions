/// <reference types="jest" />
// Role gates for the rent review endpoints. Reads use the tenancy viewers'
// allowlist (getRegisterTenant), commence the tenancy editors' (upsertRegisterTenant);
// each mirror says so in a comment and these tests keep it honest. The cfo
// passes through requireRole's hierarchy, which the cfo cases below exercise on
// the real requireRole.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { HttpResponseInit, InvocationContext } from "@azure/functions";
import { AppRole, clearRoleCache } from "../auth";
import { commenceRentReview } from "../functions/commenceRentReview";
import { getRentReview } from "../functions/getRentReview";
import { getRentReviews } from "../functions/getRentReviews";
import { getUpcomingLeaseEvents } from "../functions/getUpcomingLeaseEvents";
import { updateRentReviewBasis } from "../functions/updateRentReviewBasis";
import { isManagerOrAbove, TENANCY_EDIT_ROLES, TENANCY_VIEW_ROLES } from "../rentReview/http";
import { getRequest, postRequest } from "./fixtures/rentReviewFakes";

jest.mock("../db", () => ({
  beginTransaction: jest.fn().mockResolvedValue(undefined),
  closeConnection: jest.fn(),
  commitTransaction: jest.fn().mockResolvedValue(undefined),
  createRequestConnection: jest.fn().mockResolvedValue({}),
  executeQuery: jest.fn().mockResolvedValue([]),
  rollbackTransaction: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../ledger/actor", () => ({
  resolveLedgerActor: jest.fn().mockResolvedValue({ kind: "user", name: "Ann Accounts", role: "accounts", userId: 7 }),
}));

const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;
const TENANCY_SOURCE = readFileSync(join(__dirname, "..", "functions", "tenancy.ts"), "utf8");

/** The role list a handler in functions/tenancy.ts passes to requireRole. */
function gateOf(handler: string): string[] {
  const start = TENANCY_SOURCE.indexOf(`async function ${handler}(`);
  expect(start).toBeGreaterThan(-1);
  const match = TENANCY_SOURCE.slice(start).match(/requireRole\(request, \[([^\]]*)\]\)/);
  if (!match) throw new Error(`${handler} has no requireRole list`);
  return match[1].split(",").map((entry) => entry.trim().replace(/^AppRole\./, "")).filter(Boolean);
}

const ROLE_NAME: Record<string, string> = {
  ACCOUNTS: AppRole.ACCOUNTS,
  ACCOUNTS_APPROVAL: AppRole.ACCOUNTS_APPROVAL,
  ADMIN: AppRole.ADMIN,
  DIRECTOR: AppRole.DIRECTOR,
};

const ALL_ROLES = ["accounts", "accounts_manager", "admin", "cfo", "director", "facilities", "facilities_manager", "user"];
const TENANCY_ROLES = ["accounts", "accounts_manager", "admin", "cfo", "director"];

beforeEach(() => {
  jest.spyOn(console, "warn").mockImplementation(() => undefined); // the dev role override warns on every call
  clearRoleCache();
  process.env.DEV_ROLE_OVERRIDE_ENABLED = "true";
  process.env.AZURE_FUNCTIONS_ENVIRONMENT = "Development"; // the override only applies there (jwt.ts isDevOverrideEnabled)
});

describe("the lists mirror the tenancy endpoints they were copied from", () => {
  it("reads: getRegisterTenant's, which getRegisterTenants and getCpiIndex share", () => {
    expect(TENANCY_VIEW_ROLES).toEqual(gateOf("getRegisterTenant").map((name) => ROLE_NAME[name]));
    expect(TENANCY_VIEW_ROLES).toEqual(gateOf("getRegisterTenants").map((name) => ROLE_NAME[name]));
  });

  it("commence: upsertRegisterTenant's, the roles that may edit a tenancy", () => {
    expect(TENANCY_EDIT_ROLES).toEqual(gateOf("upsertRegisterTenant").map((name) => ROLE_NAME[name]));
    expect(TENANCY_EDIT_ROLES).toEqual(gateOf("deleteRegisterTenant").map((name) => ROLE_NAME[name]));
  });

  it("each endpoint says in a comment which endpoint it mirrors", () => {
    const http = readFileSync(join(__dirname, "..", "rentReview", "http.ts"), "utf8");
    expect(http).toMatch(/getRegisterTenant in functions\/tenancy\.ts/);
    expect(http).toMatch(/upsertRegisterTenant in functions\/tenancy\.ts/);
    for (const file of ["getRentReviews", "getRentReview", "getUpcomingLeaseEvents"]) {
      expect(readFileSync(join(__dirname, "..", "functions", `${file}.ts`), "utf8")).toMatch(/Gate: the roles that may read a tenancy/);
    }
    for (const file of ["commenceRentReview", "updateRentReviewBasis"]) {
      expect(readFileSync(join(__dirname, "..", "functions", `${file}.ts`), "utf8")).toMatch(/Gate: the roles that may edit a tenancy/);
    }
  });
});

describe("every endpoint answers 401 with no token and 403 below its gate", () => {
  const reads: Array<[string, (roles: string | null) => Promise<HttpResponseInit>]> = [
    ["getRentReviews", (roles) => getRentReviews(getRequest("tenantId=7", roles), ctx)],
    ["getRentReview", (roles) => getRentReview(getRequest("reviewId=rev-1", roles), ctx)],
    ["getUpcomingLeaseEvents", (roles) => getUpcomingLeaseEvents(getRequest("", roles), ctx)],
  ];
  const writes: Array<[string, (roles: string | null) => Promise<HttpResponseInit>]> = [
    ["commenceRentReview", (roles) => commenceRentReview(postRequest({ reviewId: "rev-1", rowVersion: "0000000000000a01" }, roles), ctx)],
    [
      "updateRentReviewBasis",
      (roles) =>
        updateRentReviewBasis(
          postRequest({ basis: { capPercent: 4 }, reason: "Lease says 4%", reviewId: "rev-1", rowVersion: "0000000000000a01" }, roles),
          ctx,
        ),
    ],
  ];

  describe.each([...reads, ...writes])("%s", (_name, call) => {
    it("needs a token", async () => {
      expect((await call(null)).status).toBe(401);
    });

    it.each(ALL_ROLES.filter((role) => !TENANCY_ROLES.includes(role)))("refuses %s", async (role) => {
      expect((await call(role)).status).toBe(403);
    });

    it.each(TENANCY_ROLES)("lets %s through the gate (whatever happens next)", async (role) => {
      expect((await call(role)).status).not.toBe(403);
      expect((await call(role)).status).not.toBe(401);
    });
  });
});

describe("accounts manager and up", () => {
  it("is accounts_manager, cfo, director and admin: the roles allowed to change a review they don't own", () => {
    for (const role of ["accounts_manager", "cfo", "director", "admin"]) expect(isManagerOrAbove([role])).toBe(true);
    for (const role of ["accounts", "facilities", "facilities_manager", "user"]) expect(isManagerOrAbove([role])).toBe(false);
    expect(isManagerOrAbove([])).toBe(false);
  });
});
