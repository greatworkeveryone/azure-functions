/// <reference types="jest" />
import type { HttpRequest } from "@azure/functions";
import type { Connection } from "tedious";
import { assertLedgerEntry } from "./validate";
import { ledgerUserActor, primaryRole, resolveLedgerActor } from "./actor";

jest.mock("../auth", () => {
  const actual = jest.requireActual("../auth");
  return { ...actual, rolesForRequest: jest.fn(), verifiedIdentityFromRequest: jest.fn() };
});
jest.mock("../db", () => ({ executeQuery: jest.fn() }));
jest.mock("../sentry", () => ({ Sentry: { captureException: jest.fn(), captureMessage: jest.fn() } }));

const auth = require("../auth") as { rolesForRequest: jest.Mock; verifiedIdentityFromRequest: jest.Mock };
const db = require("../db") as { executeQuery: jest.Mock };

const request = {} as HttpRequest;
const connection = {} as Connection;

beforeEach(() => {
  jest.clearAllMocks();
  auth.verifiedIdentityFromRequest.mockResolvedValue({ email: "fay@example.com", name: "Fay Staff", oid: "oid-fay" });
  auth.rolesForRequest.mockResolvedValue(["facilities"]);
  db.executeQuery.mockResolvedValue([{ UserID: 11 }]);
});

describe("primaryRole", () => {
  it("picks the most senior role when a caller holds several", () => {
    expect(primaryRole(["facilities", "director"])).toBe("director");
    expect(primaryRole(["accounts", "accounts_manager"])).toBe("accounts_manager");
    expect(primaryRole(["facilities", "admin", "director"])).toBe("admin");
    expect(primaryRole(["user", "facilities"])).toBe("facilities");
  });

  it("ranks the CFO between the managers and the director", () => {
    expect(primaryRole(["accounts_manager", "cfo"])).toBe("cfo");
    expect(primaryRole(["cfo", "director"])).toBe("director");
  });

  it("falls back to the first role it doesn't know, and to null for none", () => {
    expect(primaryRole(["auditor"])).toBe("auditor");
    expect(primaryRole([])).toBeNull();
  });
});

describe("ledgerUserActor", () => {
  it("builds a person actor", () => {
    expect(ledgerUserActor({ name: "Fay Staff", roles: ["facilities"], userId: 11 })).toEqual({
      kind: "user",
      name: "Fay Staff",
      role: "facilities",
      userId: 11,
    });
  });

  it("leaves a missing role empty, which the ledger's own validation then refuses", () => {
    const actor = ledgerUserActor({ name: "Fay Staff", roles: [], userId: null });
    expect(actor).toMatchObject({ role: "" });
    expect(() =>
      assertLedgerEntry({ action: "user.role_change", actor, subject: { id: 1, type: "app_user" } }),
    ).toThrow(/needs a role/);
  });
});

describe("resolveLedgerActor", () => {
  it("combines the verified name, the role and the AppUsers id", async () => {
    await expect(resolveLedgerActor(request, connection)).resolves.toEqual({
      kind: "user",
      name: "Fay Staff",
      role: "facilities",
      userId: 11,
    });
    expect(db.executeQuery).toHaveBeenCalledWith(
      connection,
      expect.stringContaining("FROM dbo.AppUsers WHERE EntraOid = @Oid"),
      [expect.objectContaining({ name: "Oid", value: "oid-fay" })],
    );
  });

  it("keeps the actor when the caller has no AppUsers row (id unknown)", async () => {
    db.executeQuery.mockResolvedValue([]);
    await expect(resolveLedgerActor(request, connection)).resolves.toMatchObject({ role: "facilities", userId: null });
  });

  it("returns null without touching the database when the token doesn't verify", async () => {
    auth.verifiedIdentityFromRequest.mockResolvedValue(null);
    await expect(resolveLedgerActor(request, connection)).resolves.toBeNull();
    expect(db.executeQuery).not.toHaveBeenCalled();
  });
});
