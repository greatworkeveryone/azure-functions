/// <reference types="jest" />

// The three MYOB controls endpoints: read (cfo, admin, director), change and
// pause (the myobController capability: role cfo only, never admin).

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
jest.mock("../ledger/actor", () => ({
  resolveLedgerActor: jest.fn().mockResolvedValue({ kind: "user", name: "Johanne", role: "cfo", userId: 12 }),
}));
jest.mock("../myob-controls-admin", () => {
  const actual = jest.requireActual("../myob-controls-admin");
  return { ...actual, changeControl: jest.fn(), setPaused: jest.fn() };
});
jest.mock("../myob-controls-view", () => ({ loadControlsView: jest.fn().mockResolvedValue({ files: [], masterWritesEnabled: false }) }));

import type { HttpRequest, InvocationContext } from "@azure/functions";
import { getMyobControls } from "./getMyobControls";
import { pauseMyob } from "./pauseMyob";
import { setMyobControl } from "./setMyobControl";

const db = require("../db") as Record<string, jest.Mock>;
const auth = require("../auth") as Record<string, jest.Mock>;
const admin = require("../myob-controls-admin") as Record<string, jest.Mock> & { MyobControlsError: new (s: number, m: string) => Error };
const { loadControlsView } = require("../myob-controls-view") as { loadControlsView: jest.Mock };

const CF = "0f9e8d7c-6b5a-4f3e-9d2c-1b0a99887766";
const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;
const post = (body: unknown) => ({ json: async () => body }) as unknown as HttpRequest;
const VALID = { companyFileId: CF, enabled: true, expectedRowVersion: "AAAAAAAAAAE=", note: "Lab day", operation: "orders.create" };

beforeEach(() => {
  jest.clearAllMocks();
  auth.rolesForRequest.mockResolvedValue(["cfo"]);
  admin.changeControl.mockResolvedValue({ changed: true, row: { operation: "orders.create" }, seeded: false });
  admin.setPaused.mockResolvedValue({ files: [CF] });
});

describe("setMyobControl", () => {
  it("lets the CFO change a control in one transaction", async () => {
    const res = await setMyobControl(post(VALID), ctx);

    expect(res.status).toBe(200);
    expect(admin.changeControl).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ role: "cfo" }), {
      changes: { enabled: true },
      companyFileId: CF,
      expectedRowVersion: "AAAAAAAAAAE=",
      note: "Lab day",
      operation: "orders.create",
    });
    expect(db.beginTransaction).toHaveBeenCalled();
    expect(db.commitTransaction).toHaveBeenCalled();
  });

  it.each([["admin"], ["director"], ["accounts_manager"]])("403s %s: only the CFO may change MYOB controls", async (role) => {
    auth.rolesForRequest.mockResolvedValue([role]);

    const res = await setMyobControl(post(VALID), ctx);

    expect(res.status).toBe(403);
    expect(admin.changeControl).not.toHaveBeenCalled();
  });

  it("401s without a token", async () => {
    auth.extractToken.mockReturnValueOnce(null);
    expect((await setMyobControl(post(VALID), ctx)).status).toBe(401);
  });

  it.each([
    ["no note", { ...VALID, note: " " }],
    ["an unknown operation", { ...VALID, operation: "orders.delete" }],
    ["a bad file id", { ...VALID, companyFileId: "rp" }],
    ["nothing to change", { companyFileId: CF, note: "x", operation: "orders.create" }],
    ["a negative cap", { ...VALID, dailyCap: -1 }],
    ["a fractional cap", { ...VALID, dailyCap: 1.5 }],
    ["a non-boolean switch", { ...VALID, enabled: "yes" }],
  ])("400s %s", async (_label, body) => {
    expect((await setMyobControl(post(body), ctx)).status).toBe(400);
    expect(admin.changeControl).not.toHaveBeenCalled();
  });

  it("maps a stale version to 409 and rolls back", async () => {
    admin.changeControl.mockRejectedValue(new admin.MyobControlsError(409, "Someone else changed this control"));

    const res = await setMyobControl(post(VALID), ctx);

    expect(res.status).toBe(409);
    expect(db.rollbackTransaction).toHaveBeenCalled();
    expect(db.commitTransaction).not.toHaveBeenCalled();
  });
});

describe("pauseMyob", () => {
  it("lets the CFO pause everything", async () => {
    const res = await pauseMyob(post({ note: "Stop", paused: true }), ctx);

    expect(res.status).toBe(200);
    expect(admin.setPaused).toHaveBeenCalledWith(expect.anything(), expect.anything(), { companyFileId: null, note: "Stop", paused: true });
    expect(db.commitTransaction).toHaveBeenCalled();
  });

  it("403s admin", async () => {
    auth.rolesForRequest.mockResolvedValue(["admin"]);
    expect((await pauseMyob(post({ note: "Stop", paused: true }), ctx)).status).toBe(403);
    expect(admin.setPaused).not.toHaveBeenCalled();
  });

  it("400s without a note or a boolean", async () => {
    expect((await pauseMyob(post({ paused: true }), ctx)).status).toBe(400);
    expect((await pauseMyob(post({ note: "x", paused: "yes" }), ctx)).status).toBe(400);
  });
});

describe("getMyobControls", () => {
  it("returns the view and whether the caller may change it", async () => {
    auth.rolesForRequest.mockResolvedValue(["admin"]);

    const res = await getMyobControls({} as HttpRequest, ctx);

    expect(res.status).toBe(200);
    expect(res.jsonBody).toMatchObject({ canChange: false, files: [], masterWritesEnabled: false });
    expect(auth.requireRole).toHaveBeenCalledWith(expect.anything(), ["cfo"]);
    expect(loadControlsView).toHaveBeenCalled();
  });

  it("passes the role check's 403 through", async () => {
    auth.requireRole.mockResolvedValueOnce({ status: 403 });
    expect((await getMyobControls({} as HttpRequest, ctx)).status).toBe(403);
  });
});
