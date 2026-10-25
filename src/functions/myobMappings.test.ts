/// <reference types="jest" />

// The MYOB mappings endpoints (plan M2): read and export (cfo, admin,
// director), import (the myobController capability: role cfo only).

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
}));
jest.mock("../ledger/actor", () => ({ resolveLedgerActor: jest.fn().mockResolvedValue({ kind: "user", name: "Johanne", role: "cfo", userId: 12 }) }));
jest.mock("../myob/mappingsAdmin/importMappings", () => ({ importMappings: jest.fn() }));
jest.mock("../myob/mappingsAdmin/mappingsView", () => ({
  exportMappingsCsv: jest.fn().mockResolvedValue({ filename: "floorplan-myob-suppliers-2026-10-17.csv", text: "a\r\n" }),
  loadMappingsView: jest.fn().mockResolvedValue({ columns: [], kind: "suppliers", rows: [] }),
}));

import type { HttpRequest, InvocationContext } from "@azure/functions";
import { getMyobMappings } from "./getMyobMappings";
import { importMyobMappings } from "./importMyobMappings";

const db = require("../db") as Record<string, jest.Mock>;
const auth = require("../auth") as Record<string, jest.Mock>;
const { importMappings } = require("../myob/mappingsAdmin/importMappings") as { importMappings: jest.Mock };
const view = require("../myob/mappingsAdmin/mappingsView") as Record<string, jest.Mock>;

const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;
const post = (body: unknown) => ({ json: async () => body }) as unknown as HttpRequest;
const get = (query: Record<string, string>) => ({ query: new URLSearchParams(query) }) as unknown as HttpRequest;
const PREVIEW = { csv: "company_file_id,contractor_id,supplier_uid,supplier_name\nx,1,y,z\n", kind: "suppliers", mode: "preview" };
const PLAN = { counts: { add: 1, change: 0, skip: 0, unchanged: 0 }, hash: "f".repeat(64), kind: "suppliers", rows: [{ after: { supplierUid: "secret" }, before: null, changes: [], line: 2, message: "Adds …", outcome: "add" }] };

beforeEach(() => {
  jest.clearAllMocks();
  auth.rolesForRequest.mockResolvedValue(["cfo"]);
  importMappings.mockResolvedValue({ applied: false, plan: PLAN });
});

describe("importMyobMappings", () => {
  it("lets the CFO preview in one transaction, answering every row's outcome", async () => {
    const res = await importMyobMappings(post(PREVIEW), ctx);
    expect(res.status).toBe(200);
    expect(res.jsonBody).toEqual({ applied: false, counts: PLAN.counts, hash: PLAN.hash, kind: "suppliers", rows: [{ changes: [], line: 2, message: "Adds …", outcome: "add" }] });
    expect(importMappings).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ role: "cfo" }), expect.objectContaining({ kind: "suppliers", mode: "preview" }));
    expect(db.commitTransaction).toHaveBeenCalled();
  });

  it.each([["admin"], ["director"], ["accounts_manager"]])("403s %s: only the CFO may import mappings", async (role) => {
    auth.rolesForRequest.mockResolvedValue([role]);
    expect((await importMyobMappings(post(PREVIEW), ctx)).status).toBe(403);
    expect(importMappings).not.toHaveBeenCalled();
  });

  it.each([
    ["an unknown kind", { ...PREVIEW, kind: "contacts" }],
    ["no file", { ...PREVIEW, csv: " " }],
    ["a file over 1 MB", { ...PREVIEW, csv: "x".repeat(1_000_001) }],
    ["an apply without a preview", { ...PREVIEW, mode: "apply" }],
    ["an unknown mode", { ...PREVIEW, mode: "write" }],
  ])("400s %s before any database work", async (_label, body) => {
    expect((await importMyobMappings(post(body), ctx)).status).toBe(400);
    expect(db.createRequestConnection).not.toHaveBeenCalled();
  });
});

describe("getMyobMappings", () => {
  it("shows the mappings and whether the caller may change them", async () => {
    const res = await getMyobMappings(get({ kind: "accounts" }), ctx);
    expect(res).toMatchObject({ jsonBody: { canChange: true, kind: "suppliers" }, status: 200 });
    expect(view.loadMappingsView).toHaveBeenCalledWith(expect.anything(), "accounts");
    auth.rolesForRequest.mockResolvedValue(["director"]);
    expect((await getMyobMappings(get({ kind: "accounts" }), ctx)).jsonBody).toMatchObject({ canChange: false });
  });

  it("exports the CSV template with the current mappings", async () => {
    const res = await getMyobMappings(get({ format: "csv", kind: "suppliers" }), ctx);
    expect(res.jsonBody).toEqual({ filename: "floorplan-myob-suppliers-2026-10-17.csv", text: "a\r\n" });
  });

  it("passes the role check's 403 through, and 400s an unknown kind", async () => {
    auth.requireRole.mockResolvedValueOnce({ jsonBody: { error: "Forbidden" }, status: 403 });
    expect((await getMyobMappings(get({ kind: "suppliers" }), ctx)).status).toBe(403);
    expect((await getMyobMappings(get({ kind: "contacts" }), ctx)).status).toBe(400);
  });
});
