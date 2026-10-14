/// <reference types="jest" />
import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn() } };
});

jest.mock("../auth", () => {
  const actual = jest.requireActual("../auth");
  return {
    ...actual,
    errorResponse: jest.fn().mockReturnValue({ status: 500, jsonBody: { error: "Error" } }),
    extractToken: jest.fn().mockReturnValue("mock-token"),
    requireRole: jest.fn().mockResolvedValue(null),
    unauthorizedResponse: jest.fn().mockReturnValue({ status: 401, jsonBody: { error: "Unauthorized" } }),
    verifiedIdentityFromRequest: jest.fn().mockResolvedValue({ email: "c@rp.com", name: "Connor", oid: "oid-1" }),
  };
});

jest.mock("../db", () => {
  const actual = jest.requireActual("../db");
  return {
    ...actual,
    beginTransaction: jest.fn().mockResolvedValue(undefined),
    closeConnection: jest.fn(),
    commitTransaction: jest.fn().mockResolvedValue(undefined),
    createRequestConnection: jest.fn().mockResolvedValue({}),
    executeQuery: jest.fn().mockResolvedValue([]),
    rollbackTransaction: jest.fn().mockResolvedValue(undefined),
  };
});

jest.mock("../blob-storage", () => ({
  deleteBlob: jest.fn().mockResolvedValue(undefined),
  generateReadSasUrl: jest.fn().mockReturnValue("https://sas.example/x"),
  uploadBlob: jest.fn().mockResolvedValue({ blobName: "asset-1/x.pdf", url: "https://blob.example/x" }),
}));

import { AppRole } from "../auth";
import {
  ARCHIVE_ASSETS_ROLES,
  EDIT_ASSETS_ROLES,
  MANAGE_ASSET_TYPES_ROLES,
  VERIFY_ASSETS_ROLES,
  VIEW_ASSETS_ROLES,
} from "../assetRegister";
import { archiveAsset } from "../functions/archiveAsset";
import { getAsset } from "../functions/getAsset";
import { getAssetAttachments } from "../functions/getAssetAttachments";
import { getAssets } from "../functions/getAssets";
import { getAssetTypes } from "../functions/getAssetTypes";
import { getLocations } from "../functions/getLocations";
import { linkJobAsset } from "../functions/linkJobAsset";
import { unlinkJobAsset } from "../functions/unlinkJobAsset";
import { uploadAssetAttachment } from "../functions/uploadAssetAttachment";
import { upsertAsset } from "../functions/upsertAsset";
import { upsertAssetType } from "../functions/upsertAssetType";
import { upsertLocation } from "../functions/upsertLocation";
import { verifyAsset } from "../functions/verifyAsset";

// Captured at import time, before any beforeEach clears the mock.
const registrations = (app.http as unknown as jest.Mock).mock.calls.map(
  ([name, options]: [string, { methods: string[] }]) => ({ methods: options.methods, name }),
);

const auth = require("../auth") as {
  extractToken: jest.Mock;
  requireRole: jest.Mock;
  verifiedIdentityFromRequest: jest.Mock;
};
const db = require("../db") as { createRequestConnection: jest.Mock; executeQuery: jest.Mock };
const realAuth = jest.requireActual("../auth") as typeof import("../auth");

type Handler = (request: HttpRequest, context: InvocationContext) => Promise<HttpResponseInit>;

const FORBIDDEN = { jsonBody: { error: "Forbidden" }, status: 403 };
const context = new InvocationContext();
const request = { json: async () => ({}), query: new URLSearchParams() } as unknown as HttpRequest;

const READ = "GET";
const WRITE = "POST";

// [function name, handler, role gate, HTTP method]
const HANDLERS: Array<[string, Handler, readonly AppRole[], string]> = [
  ["getLocations", getLocations, VIEW_ASSETS_ROLES, READ],
  ["upsertLocation", upsertLocation, EDIT_ASSETS_ROLES, WRITE],
  ["getAssets", getAssets, VIEW_ASSETS_ROLES, READ],
  ["getAsset", getAsset, VIEW_ASSETS_ROLES, READ],
  ["upsertAsset", upsertAsset, EDIT_ASSETS_ROLES, WRITE],
  ["archiveAsset", archiveAsset, ARCHIVE_ASSETS_ROLES, WRITE],
  ["verifyAsset", verifyAsset, VERIFY_ASSETS_ROLES, WRITE],
  ["linkJobAsset", linkJobAsset, EDIT_ASSETS_ROLES, WRITE],
  ["unlinkJobAsset", unlinkJobAsset, EDIT_ASSETS_ROLES, WRITE],
  ["getAssetAttachments", getAssetAttachments, VIEW_ASSETS_ROLES, READ],
  ["uploadAssetAttachment", uploadAssetAttachment, EDIT_ASSETS_ROLES, WRITE],
  ["getAssetTypes", getAssetTypes, VIEW_ASSETS_ROLES, READ],
  ["upsertAssetType", upsertAssetType, MANAGE_ASSET_TYPES_ROLES, WRITE],
];

beforeEach(() => {
  jest.clearAllMocks();
  auth.extractToken.mockReturnValue("mock-token");
  auth.requireRole.mockResolvedValue(null);
  auth.verifiedIdentityFromRequest.mockResolvedValue({ email: "c@rp.com", name: "Connor", oid: "oid-1" });
});

describe("asset register: registered functions", () => {
  it("registers exactly the thirteen functions of the contract, with the right verbs", () => {
    const expected = HANDLERS.map(([name, , , method]) => ({ methods: [method], name }));
    const sortByName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
    expect([...registrations].sort(sortByName)).toEqual([...expected].sort(sortByName));
  });
});

describe("asset register: every handler is gated", () => {
  it.each(HANDLERS)("%s answers 401 to a request with no token, before any role check", async (_name, handler) => {
    auth.extractToken.mockReturnValue(null);
    const response = await handler(request, context);
    expect(response.status).toBe(401);
    expect(auth.requireRole).not.toHaveBeenCalled();
    expect(db.createRequestConnection).not.toHaveBeenCalled();
  });

  it.each(HANDLERS)("%s checks its own role list and stops on 403", async (_name, handler, roles) => {
    auth.requireRole.mockResolvedValue(FORBIDDEN);
    const response = await handler(request, context);
    expect(response.status).toBe(403);
    expect(auth.requireRole).toHaveBeenCalledWith(request, roles);
    expect(db.createRequestConnection).not.toHaveBeenCalled();
    expect(db.executeQuery).not.toHaveBeenCalled();
  });

  it.each(HANDLERS.filter(([, , , method]) => method === WRITE))(
    "%s refuses a write whose caller cannot be identified from the verified token",
    async (_name, handler) => {
      auth.verifiedIdentityFromRequest.mockResolvedValue(null);
      const response = await handler(request, context);
      expect(response.status).toBe(401);
      expect(db.createRequestConnection).not.toHaveBeenCalled();
    },
  );
});

// The effective allowlists, run through the REAL requireRole hierarchy: this is
// the table the frontend capability map has to mirror.
describe("asset register: who gets through each gate (real requireRole)", () => {
  const originalOverride = process.env.DEV_ROLE_OVERRIDE_ENABLED;
  const originalEnvironment = process.env.AZURE_FUNCTIONS_ENVIRONMENT;

  beforeAll(() => {
    process.env.DEV_ROLE_OVERRIDE_ENABLED = "true";
    process.env.AZURE_FUNCTIONS_ENVIRONMENT = "Development";
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterAll(() => {
    jest.restoreAllMocks();
    if (originalOverride === undefined) delete process.env.DEV_ROLE_OVERRIDE_ENABLED;
    else process.env.DEV_ROLE_OVERRIDE_ENABLED = originalOverride;
    if (originalEnvironment !== undefined) process.env.AZURE_FUNCTIONS_ENVIRONMENT = originalEnvironment;
  });

  const CALLERS = ["admin", "director", "facilities_manager", "facilities", "accounts_manager", "accounts", "user", "(no role)"];

  function requestAs(role: string): HttpRequest {
    const headers: Record<string, string> = role === "(no role)" ? {} : { "x-dev-roles": role };
    return { headers: { get: (key: string) => headers[key.toLowerCase()] ?? null } } as unknown as HttpRequest;
  }

  async function admitted(gate: readonly AppRole[]): Promise<string[]> {
    const result: string[] = [];
    for (const role of CALLERS) {
      if ((await realAuth.requireRole(requestAs(role), gate)) === null) result.push(role);
    }
    return result;
  }

  it("view: every operational role, but not the baseline user tier or an unassigned account", async () => {
    expect(await admitted(VIEW_ASSETS_ROLES)).toEqual([
      "admin",
      "director",
      "facilities_manager",
      "facilities",
      "accounts_manager",
      "accounts",
    ]);
  });

  it("edit, verify: facilities, facilities_manager, admin (plus director via the hierarchy)", async () => {
    const expected = ["admin", "director", "facilities_manager", "facilities"];
    expect(await admitted(EDIT_ASSETS_ROLES)).toEqual(expected);
    expect(await admitted(VERIFY_ASSETS_ROLES)).toEqual(expected);
  });

  it("archive and manage asset types: facilities_manager and admin only (plus director)", async () => {
    const expected = ["admin", "director", "facilities_manager"];
    expect(await admitted(ARCHIVE_ASSETS_ROLES)).toEqual(expected);
    expect(await admitted(MANAGE_ASSET_TYPES_ROLES)).toEqual(expected);
  });

  it("plain facilities staff cannot archive or grow the taxonomy", async () => {
    const staff = requestAs("facilities");
    expect((await realAuth.requireRole(staff, ARCHIVE_ASSETS_ROLES))?.status).toBe(403);
    expect((await realAuth.requireRole(staff, MANAGE_ASSET_TYPES_ROLES))?.status).toBe(403);
    expect(await realAuth.requireRole(staff, EDIT_ASSETS_ROLES)).toBeNull();
  });

  it("accounts can read the register but not change it", async () => {
    for (const role of ["accounts", "accounts_manager"]) {
      const caller = requestAs(role);
      expect(await realAuth.requireRole(caller, VIEW_ASSETS_ROLES)).toBeNull();
      expect((await realAuth.requireRole(caller, EDIT_ASSETS_ROLES))?.status).toBe(403);
    }
  });
});
