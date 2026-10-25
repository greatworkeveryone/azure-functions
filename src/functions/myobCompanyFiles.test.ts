/// <reference types="jest" />

// The MYOB entity endpoints (decision 14): the list (cfo; director and admin
// read), register, set mode and discover (cfo only; admin and director get 403).

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn(), storageQueue: jest.fn(), timer: jest.fn() } };
});
jest.mock("../moneyGate", () => ({ requireMoneyContext: jest.fn().mockResolvedValue(null) }));
jest.mock("../db", () => ({
  beginTransaction: jest.fn().mockResolvedValue(undefined),
  closeConnection: jest.fn(),
  commitTransaction: jest.fn().mockResolvedValue(undefined),
  createRequestConnection: jest.fn().mockResolvedValue({}),
  rollbackTransaction: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../auth", () => ({
  ...jest.requireActual("../auth"),
  extractToken: jest.fn().mockReturnValue("token"),
  requireRole: jest.fn().mockResolvedValue(null),
  rolesForRequest: jest.fn().mockResolvedValue(["cfo"]),
  verifiedIdentityFromRequest: jest.fn().mockResolvedValue({ email: "j@rp", name: "Johanne", oid: "cfo-oid" }),
}));
jest.mock("../ledger/actor", () => ({
  resolveLedgerActor: jest.fn().mockResolvedValue({ kind: "user", name: "Johanne", role: "cfo", userId: 12 }),
}));
jest.mock("../myob-company-files-admin", () => ({
  changeFileSettings: jest.fn(),
  recordDiscoveredFiles: jest.fn(),
  registerCompanyFile: jest.fn(),
}));
jest.mock("../myob-company-files-view", () => ({ loadCompanyFilesView: jest.fn().mockResolvedValue({ files: [] }) }));
jest.mock("../myob-api-log", () => ({ ...jest.requireActual("../myob-api-log"), myobRequest: jest.fn() }));
jest.mock("../myob-auth", () => ({ getValidMyobAccessToken: jest.fn().mockResolvedValue("access") }));

import type { HttpRequest, InvocationContext } from "@azure/functions";
import { discoverMyobCompanyFiles } from "./discoverMyobCompanyFiles";
import { getMyobCompanyFiles } from "./getMyobCompanyFiles";
import { registerMyobCompanyFile } from "./registerMyobCompanyFile";
import { setMyobFileMode } from "./setMyobFileMode";

const auth = require("../auth") as Record<string, jest.Mock>;
const db = require("../db") as Record<string, jest.Mock>;
const admin = require("../myob-company-files-admin") as Record<string, jest.Mock>;
const { myobRequest } = require("../myob-api-log") as { myobRequest: jest.Mock };

const CF = "0f9e8d7c-6b5a-4f3e-9d2c-1b0a99887766";
const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;
const post = (body: unknown) => ({ json: async () => body }) as unknown as HttpRequest;

beforeEach(() => {
  jest.clearAllMocks();
  auth.rolesForRequest.mockResolvedValue(["cfo"]);
  admin.changeFileSettings.mockResolvedValue({ changed: true, row: { companyFileId: CF, mode: "read" } });
  admin.registerCompanyFile.mockResolvedValue({ companyFileId: CF, mode: "off" });
  admin.recordDiscoveredFiles.mockResolvedValue({ added: [CF], seen: 1 });
  myobRequest.mockResolvedValue({ json: () => [{ Id: CF, Name: "Demo" }], ok: true, status: 200, text: "[]" });
});

describe("setMyobFileMode", () => {
  const valid = { companyFileId: CF, expectedRowVersion: "AAAAAAAAAAE=", mode: "read", note: "Mirror reads" };

  it("lets the CFO change a file's mode in one transaction", async () => {
    const res = await setMyobFileMode(post(valid), ctx);
    expect(res.status).toBe(200);
    expect(admin.changeFileSettings).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ role: "cfo" }), {
      changes: { mode: "read" },
      companyFileId: CF,
      expectedRowVersion: "AAAAAAAAAAE=",
      note: "Mirror reads",
    });
    expect(db.commitTransaction).toHaveBeenCalled();
  });

  it.each([["admin"], ["director"]])("403s %s", async (role) => {
    auth.rolesForRequest.mockResolvedValue([role]);
    expect((await setMyobFileMode(post(valid), ctx)).status).toBe(403);
    expect(admin.changeFileSettings).not.toHaveBeenCalled();
  });

  it.each([
    ["a mode that isn't off, read or write", { ...valid, mode: "propose" }],
    ["no note", { ...valid, note: "" }],
    ["nothing to change", { companyFileId: CF, expectedRowVersion: "x", note: "n" }],
    ["a bad file id", { ...valid, companyFileId: "rp" }],
  ])("400s %s", async (_label, body) => {
    expect((await setMyobFileMode(post(body), ctx)).status).toBe(400);
  });

  it("maps a stale version to 409 and rolls back", async () => {
    const { MyobControlsError } = jest.requireActual("../myob-controls-admin");
    admin.changeFileSettings.mockRejectedValue(new MyobControlsError(409, "stale"));
    expect((await setMyobFileMode(post(valid), ctx)).status).toBe(409);
    expect(db.rollbackTransaction).toHaveBeenCalled();
  });
});

describe("registerMyobCompanyFile", () => {
  it("registers a file by id for the CFO, and 403s admin", async () => {
    expect((await registerMyobCompanyFile(post({ companyFileId: CF, name: "Demo", note: "Sample" }), ctx)).status).toBe(200);
    expect(admin.registerCompanyFile).toHaveBeenCalledWith(expect.anything(), expect.anything(), { companyFileId: CF, name: "Demo", note: "Sample" });
    auth.rolesForRequest.mockResolvedValue(["admin"]);
    expect((await registerMyobCompanyFile(post({ companyFileId: CF, note: "x" }), ctx)).status).toBe(403);
  });
});

describe("discoverMyobCompanyFiles", () => {
  it("reads MYOB's file list through myobRequest (guarded, lazy token) and records it", async () => {
    const res = await discoverMyobCompanyFiles(post({}), ctx);
    expect(res.status).toBe(200);
    expect(res.jsonBody).toEqual({ added: [CF], seen: 1 });
    const call = myobRequest.mock.calls[0][0];
    expect(call).toMatchObject({ method: "GET", purpose: "discover-company-files" });
    expect(typeof call.headers).toBe("function");
  });

  it("reports a refusal inside Floorplan as 409 with the reason, recording nothing", async () => {
    const { MyobRequestRefusedError } = jest.requireActual("../myob-api-log");
    myobRequest.mockRejectedValue(new MyobRequestRefusedError("controls", "MYOB is off for company file x"));
    const res = await discoverMyobCompanyFiles(post({}), ctx);
    expect(res).toMatchObject({ jsonBody: { error: "MYOB is off for company file x" }, status: 409 });
    expect(admin.recordDiscoveredFiles).not.toHaveBeenCalled();
  });

  it("403s admin", async () => {
    auth.rolesForRequest.mockResolvedValue(["admin"]);
    expect((await discoverMyobCompanyFiles(post({}), ctx)).status).toBe(403);
    expect(myobRequest).not.toHaveBeenCalled();
  });

  it("401s, calling nothing, when the caller can't be identified (the log must name a person)", async () => {
    auth.verifiedIdentityFromRequest.mockResolvedValueOnce(null);
    expect((await discoverMyobCompanyFiles(post({}), ctx)).status).toBe(401);
    expect(myobRequest).not.toHaveBeenCalled();
    expect(admin.recordDiscoveredFiles).not.toHaveBeenCalled();
  });

  it("calls MYOB as the verified person", async () => {
    await discoverMyobCompanyFiles(post({}), ctx);
    expect(myobRequest.mock.calls[0][0].actor).toMatchObject({ kind: "user", name: "Johanne", oid: "cfo-oid" });
  });
});

describe("getMyobCompanyFiles", () => {
  it("returns the files and whether the caller may change them", async () => {
    auth.rolesForRequest.mockResolvedValue(["director"]);
    const res = await getMyobCompanyFiles({} as HttpRequest, ctx);
    expect(res).toMatchObject({ jsonBody: { canChange: false, files: [] }, status: 200 });
    expect(auth.requireRole).toHaveBeenCalledWith(expect.anything(), ["cfo"]);
  });
});
