/// <reference types="jest" />

// Decision 14: the CFO decides, per MYOB company file, whether Floorplan may
// touch it at all. These run the real guard (allowlist → period → write
// switch → entity mode → controls) over a mocked database, and prove that a
// file set to off, or missing from MyobCompanyFiles, never reaches the HTTP
// client, never even builds its headers (so no token refresh), and leaves a
// refusal in the MYOB log.

jest.mock("../db", () => ({
  closeConnection: jest.fn(),
  createServiceRequestConnection: jest.fn().mockResolvedValue({}),
  executeQuery: jest.fn(),
}));
jest.mock("../sentry", () => ({ Sentry: { captureException: jest.fn() } }));
jest.mock("../myob-health", () => ({
  MYOB_HEALTH_SUBJECTS: { agreement: "myob_agreement", link: "myob_link" },
  raiseMyobHealth: jest.fn().mockResolvedValue(undefined),
}));

import { todayInDarwin } from "../darwinDate";
import { myobRequest, MyobRequestRefusedError } from "../myob-api-log";
import { setMyobTestRecordLookup } from "../myob-request-guard";

const db = require("../db") as { executeQuery: jest.Mock };
const CF = "0f9e8d7c-6b5a-4f3e-9d2c-1b0a99887766";
const API = `https://api.myob.com/accountright/${CF}`;
const fetchMock = jest.fn();
const headers = jest.fn(async () => ({ Authorization: "Bearer t" }));
const saved = { ...process.env };

const control = (Operation: string) => ({
  CompanyFileId: CF, DailyCap: 10, DryRun: false, Enabled: true, Operation, PausedAll: false, RequireReview: true, RowVersion: Buffer.alloc(8),
});

/** mode: the file's MyobCompanyFiles.Mode, or null for a file that isn't registered. */
function world(mode: string | null) {
  db.executeQuery.mockImplementation(async (_c: unknown, sql: string) => {
    if (/FROM dbo\.MyobCompanyFiles/.test(sql)) return mode === null ? [] : [{ Mode: mode }];
    if (/FROM dbo\.MyobControls/.test(sql)) return [control("purchases.read"), control("orders.create")];
    return [];
  });
}

const logRows = () =>
  db.executeQuery.mock.calls
    .filter((c: unknown[]) => /INSERT INTO dbo\.MyobApiLog/.test(String(c[1])))
    .map((c: unknown[]) => Object.fromEntries((c[2] as { name: string; value: unknown }[]).map((p) => [p.name, p.value])));

const read = () => myobRequest({ actor: { kind: "system", name: "t" }, headers, method: "GET", purpose: "read", url: `${API}/Purchase/Order` });
const write = () =>
  myobRequest({
    actor: { kind: "system", name: "t" },
    body: { Date: todayInDarwin() },
    headers,
    method: "POST",
    purpose: "create-order",
    url: `${API}/Purchase/Order/Service`,
  });


// D9's test-record check has its own suite (myob-test-records.test.ts); here
// every call is about a real record.
beforeAll(() => setMyobTestRecordLookup(async () => ({ isTest: false, named: true })));
afterAll(() => setMyobTestRecordLookup(null));

beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...saved, MYOB_WRITES_ENABLED: "true" };
  fetchMock.mockReset().mockImplementation(async () => new Response("{}", { status: 200 }));
  global.fetch = fetchMock as unknown as typeof fetch;
  jest.spyOn(console, "error").mockImplementation(() => undefined);
});

afterAll(() => {
  process.env = saved;
});

describe.each([
  ["set to off", "off"],
  ["missing from MyobCompanyFiles", null],
  ["holding a mode the code doesn't know", "propose"],
])("a company file %s", (_label, mode) => {
  it.each([["a read", read], ["a write", write]])("never lets %s reach the HTTP client", async (_kind, send) => {
    world(mode);

    const err = await send().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MyobRequestRefusedError);
    expect((err as Error).message).toContain("off for company file");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(headers).not.toHaveBeenCalled();
    expect(logRows().map((r) => r.Phase)).toEqual(["error"]);
  });
});

describe("a company file set to read", () => {
  it("lets reads through and refuses writes before the HTTP client", async () => {
    world("read");

    await read();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await expect(write()).rejects.toMatchObject({ code: "controls", message: expect.stringContaining("read only") });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("a company file set to write", () => {
  it("lets a write through when its control is on", async () => {
    world("write");
    await write();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("the file list", () => {
  it("follows the configured file's mode", async () => {
    process.env.MYOB_COMPANY_FILE_ID = CF;
    world("off");
    const list = () => myobRequest({ actor: { kind: "system", name: "t" }, headers, method: "GET", purpose: "files", url: "https://api.myob.com/accountright/" });
    await expect(list()).rejects.toBeInstanceOf(MyobRequestRefusedError);
    world("read");
    await list();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
