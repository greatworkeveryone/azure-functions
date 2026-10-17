/// <reference types="jest" />

jest.mock("./db", () => ({
  beginTransaction: jest.fn().mockResolvedValue(undefined),
  closeConnection: jest.fn(),
  commitTransaction: jest.fn().mockResolvedValue(undefined),
  createServiceRequestConnection: jest.fn().mockResolvedValue({}),
  executeQuery: jest.fn(),
  rollbackTransaction: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("./myob-auth-state", () => ({ consumeAuthState: jest.fn() }));
jest.mock("./myob-auth", () => {
  const actual = jest.requireActual("./myob-auth");
  return { MyobScopeError: actual.MyobScopeError, exchangeCode: jest.fn() };
});
jest.mock("./myob-auth-store", () => ({
  lockMyobTokens: jest.fn().mockResolvedValue(undefined),
  readMyobAuthRow: jest.fn(),
  saveLinkedTokens: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("./ledger", () => ({
  newCorrelationId: jest.fn().mockReturnValue("9b1f2c34-5d6e-4f70-8a91-0b2c3d4e5f60"),
  record: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("./myob-health", () => ({
  MYOB_HEALTH_SUBJECTS: { agreement: "myob_agreement", link: "myob_link" },
  raiseMyobHealth: jest.fn().mockResolvedValue(undefined),
}));

import { MyobScopeError } from "./myob-auth";
import { completeMyobLink } from "./myob-link";

const db = require("./db") as Record<string, jest.Mock>;
const { consumeAuthState } = require("./myob-auth-state") as { consumeAuthState: jest.Mock };
const { exchangeCode } = require("./myob-auth") as { exchangeCode: jest.Mock };
const store = require("./myob-auth-store") as Record<string, jest.Mock>;
const { record } = require("./ledger") as { record: jest.Mock };
const { raiseMyobHealth } = require("./myob-health") as { raiseMyobHealth: jest.Mock };

const FILE = "0f9e8d7c-6b5a-4f3e-9d2c-1b0a99887766";
const OTHER = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const OWNER = { name: "Will Admin", oid: "admin-oid" };
const TOKENS = {
  access_token: "a",
  expires_in: "1200",
  refresh_token: "r",
  scope: "sme-company-file sme-purchases",
  user: { uid: "myob-user-uid", username: "floorplan.integration" },
};
const original = process.env.MYOB_COMPANY_FILE_ID;

/** The file's mode at each read, in order (the last repeats); null = not registered. */
let modes: (string | null)[] = ["write"];

beforeEach(() => {
  jest.clearAllMocks();
  modes = ["write"];
  db.executeQuery.mockImplementation(async (_c: unknown, sql: string) => {
    if (!/FROM dbo\.MyobCompanyFiles/.test(sql)) return [{ UserID: 7 }];
    const mode = modes.length > 1 ? modes.shift() : modes[0];
    return mode === null || mode === undefined ? [] : [{ Mode: mode }];
  });
  delete process.env.MYOB_COMPANY_FILE_ID;
  consumeAuthState.mockResolvedValue(OWNER);
  exchangeCode.mockResolvedValue(TOKENS);
  store.readMyobAuthRow.mockResolvedValue(null);
});

afterAll(() => {
  if (original === undefined) delete process.env.MYOB_COMPANY_FILE_ID;
  else process.env.MYOB_COMPANY_FILE_ID = original;
});

const link = (over: Partial<{ businessId: string | null; code: string; state: string }> = {}) =>
  completeMyobLink({ businessId: FILE, code: "code", state: "state", ...over });

describe("completeMyobLink refusals: nothing is exchanged or stored", () => {
  it("400 when the state was already used, expired or unknown", async () => {
    consumeAuthState.mockResolvedValue(null);

    await expect(link()).resolves.toMatchObject({ ok: false, status: 400 });
    expect(exchangeCode).not.toHaveBeenCalled();
    expect(store.saveLinkedTokens).not.toHaveBeenCalled();
  });

  it("400 when MYOB sends no businessId, or one that is not a file id", async () => {
    await expect(link({ businessId: null })).resolves.toMatchObject({ ok: false, status: 400 });
    await expect(link({ businessId: "../x" })).resolves.toMatchObject({ ok: false, status: 400 });
    expect(exchangeCode).not.toHaveBeenCalled();
  });

  it("409 when the approved file is not the configured one", async () => {
    process.env.MYOB_COMPANY_FILE_ID = FILE;

    const outcome = await link({ businessId: OTHER });

    expect(outcome).toMatchObject({ ok: false, status: 409 });
    expect(exchangeCode).not.toHaveBeenCalled();
    expect(store.saveLinkedTokens).not.toHaveBeenCalled();
  });

  it("409 when, with no file configured, a re-link names a different file from the linked one", async () => {
    store.readMyobAuthRow.mockResolvedValue({ BusinessId: FILE });

    await expect(link({ businessId: OTHER })).resolves.toMatchObject({ ok: false, status: 409 });
    expect(exchangeCode).not.toHaveBeenCalled();
  });

  it("409 when the approved file isn't registered in Entities (decision 14)", async () => {
    modes = [null];

    const outcome = await link();

    expect(outcome).toMatchObject({ ok: false, status: 409, title: expect.stringContaining("not registered") });
    expect(exchangeCode).not.toHaveBeenCalled();
    expect(store.saveLinkedTokens).not.toHaveBeenCalled();
  });

  it("409 when the approved file is registered but switched off, before anything is exchanged", async () => {
    modes = ["off"];

    const outcome = await link();

    expect(outcome).toMatchObject({ ok: false, status: 409, title: expect.stringContaining("switched off") });
    expect(exchangeCode).not.toHaveBeenCalled();
  });

  it("409, storing nothing, when the file is switched off between the first check and the token lock", async () => {
    modes = ["read", "off"];

    const outcome = await link();

    expect(outcome).toMatchObject({ ok: false, status: 409, title: expect.stringContaining("switched off") });
    expect(exchangeCode).toHaveBeenCalled();
    expect(store.lockMyobTokens).toHaveBeenCalled();
    expect(store.saveLinkedTokens).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    expect(db.rollbackTransaction).toHaveBeenCalled();
    expect(raiseMyobHealth).not.toHaveBeenCalled();
  });

  it("re-reads the mode under the token lock with the row's update lock", async () => {
    await link();
    const modeReads = db.executeQuery.mock.calls.map((c: unknown[]) => String(c[1])).filter((sql: string) => /FROM dbo\.MyobCompanyFiles/.test(sql));
    expect(modeReads).toHaveLength(2);
    expect(modeReads[0]).not.toMatch(/UPDLOCK/);
    expect(modeReads[1]).toMatch(/WITH \(UPDLOCK, HOLDLOCK\)/);
  });

  it("409, storing nothing, when another file was linked between the first check and the token lock", async () => {
    store.readMyobAuthRow.mockResolvedValueOnce(null).mockResolvedValueOnce({ BusinessId: OTHER });

    const outcome = await link();

    expect(outcome).toMatchObject({ ok: false, status: 409, title: "That is not the company file Floorplan is set up for" });
    expect(store.saveLinkedTokens).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    expect(db.rollbackTransaction).toHaveBeenCalled();
  });

  it("409 when MYOB grants a scope beyond the agreement", async () => {
    exchangeCode.mockRejectedValue(new MyobScopeError(["sme-banking"]));

    await expect(link()).resolves.toMatchObject({ ok: false, status: 409 });
    expect(store.saveLinkedTokens).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it("500 when the code exchange fails", async () => {
    exchangeCode.mockRejectedValue(new Error("MYOB token endpoint 400: invalid_grant"));

    await expect(link()).resolves.toMatchObject({ detail: "MYOB token endpoint 400: invalid_grant", ok: false, status: 500 });
  });
});

describe("completeMyobLink success", () => {
  it("first link: records the file, stores tokens under the lock, ledgers myob.link and raises system.health", async () => {
    const outcome = await link({ businessId: FILE.toUpperCase() });

    expect(outcome).toEqual({ businessId: FILE, myobUsername: "floorplan.integration", ok: true, relinked: false });
    expect(exchangeCode).toHaveBeenCalledWith(
      "code",
      { kind: "user", name: "Will Admin", oid: "admin-oid", role: "admin" },
      "9b1f2c34-5d6e-4f70-8a91-0b2c3d4e5f60",
    );
    expect(store.lockMyobTokens).toHaveBeenCalled();
    expect(store.saveLinkedTokens).toHaveBeenCalledWith(expect.anything(), { businessId: FILE, linkedBy: OWNER, tokens: TOKENS });
    expect(record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "myob.link",
        actor: { kind: "user", name: "Will Admin", role: "admin", userId: 7 },
        after: expect.objectContaining({ businessId: FILE, myobUsername: "floorplan.integration" }),
        before: null,
        ruleApplied: "link",
        subject: { id: FILE, type: "myob_link" },
      }),
    );
    expect(db.commitTransaction).toHaveBeenCalled();
    expect(raiseMyobHealth).toHaveBeenCalledWith("myob_link", expect.stringContaining("linked by Will Admin"), expect.any(Object));
  });

  it("re-link: ledgers the previous link as before and says relink", async () => {
    process.env.MYOB_COMPANY_FILE_ID = FILE;
    const prior = { AuthorizedAt: new Date("2026-10-01T00:00:00Z"), AuthorizedBy: null, BusinessId: FILE, LinkedByName: "Old Admin", MyobUsername: "old" };
    store.readMyobAuthRow.mockResolvedValue(prior);

    const outcome = await link();

    expect(outcome).toMatchObject({ ok: true, relinked: true });
    expect(record.mock.calls[0][1]).toMatchObject({
      before: { businessId: FILE, linkedBy: "Old Admin", myobUsername: "old" },
      ruleApplied: "relink",
    });
    expect(raiseMyobHealth.mock.calls[0][1]).toContain("re-linked");
  });

  it("rolls back, and raises nothing, when the ledger row can't be written", async () => {
    record.mockRejectedValueOnce(new Error("ledger down"));

    await expect(link()).rejects.toThrow("ledger down");
    expect(db.rollbackTransaction).toHaveBeenCalled();
    expect(db.commitTransaction).not.toHaveBeenCalled();
    expect(raiseMyobHealth).not.toHaveBeenCalled();
  });
});
