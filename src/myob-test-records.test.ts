/// <reference types="jest" />
// D9: myobRequest itself refuses a test record — reads (M10's read-back) and
// writes (M3's push) alike — and a company-file write must say which Floorplan
// record it is for. This replaces "demonstration file only" as the rule that
// keeps test data out of MYOB.

jest.mock("./db", () => ({
  closeConnection: jest.fn(),
  createServiceRequestConnection: jest.fn().mockResolvedValue({}),
  executeQuery: jest.fn().mockResolvedValue([]),
}));
jest.mock("./sentry", () => ({ Sentry: { captureException: jest.fn(), captureMessage: jest.fn() } }));
jest.mock("./myob-controls", () => ({ assertMyobControlsAllow: jest.fn().mockResolvedValue(undefined) }));
jest.mock("./myob-health", () => ({
  MYOB_HEALTH_SUBJECTS: { agreement: "myob_agreement", link: "myob_link" },
  raiseMyobHealth: jest.fn().mockResolvedValue(undefined),
}));

import { todayInDarwin } from "./darwinDate";
import { myobRequest, MyobRequestRefusedError, type MyobActor } from "./myob-api-log";
import { setMyobTestRecordLookup } from "./myob-request-guard";
import { lookupMyobTestRecord, PROPOSAL_SUBJECT_SQL } from "./myob-test-records";
import { IS_TEST_SQL, TestDataEgressError } from "./test-data";

const db = require("./db") as Record<string, jest.Mock>;

const CF = "0f9e8d7c-6b5a-4f3e-9d2c-1b0a99887766";
const API = `https://api.myob.com/accountright/${CF}`;
const CORRELATION = "6f1c2d3e-4b5a-4c6d-8e7f-901234567890";
const USER: MyobActor = { kind: "user", name: "Johanne CFO", oid: "cfo-oid", role: "cfo" };
const fetchMock = jest.fn();
const saved = { ...process.env };
const lookup = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  db.executeQuery.mockReset().mockResolvedValue([]);
  fetchMock.mockReset().mockImplementation(async () => new Response("{}", { status: 200 }));
  global.fetch = fetchMock as unknown as typeof fetch;
  process.env = { ...saved, MYOB_WRITES_ENABLED: "true" };
  lookup.mockReset().mockResolvedValue({ isTest: false, named: true });
  setMyobTestRecordLookup(lookup);
  jest.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => jest.restoreAllMocks());
afterAll(() => {
  process.env = saved;
  setMyobTestRecordLookup(null);
});

const read = () =>
  myobRequest({ actor: USER, correlationId: CORRELATION, headers: {}, method: "GET", purpose: "read-back-order", url: `${API}/Purchase/Order/Service/11111111-2222-4333-8444-555555555555` });
const write = (over: Record<string, unknown> = {}) =>
  myobRequest({
    actor: USER,
    body: JSON.stringify({ Date: todayInDarwin() }),
    correlationId: CORRELATION,
    headers: {},
    method: "POST",
    purpose: "create-order",
    url: `${API}/Purchase/Order/Service`,
    ...over,
  });

describe("myobRequest and test records", () => {
  it("refuses a read about a test record (M10's read-back) without calling MYOB", async () => {
    lookup.mockResolvedValue({ isTest: true, named: true });
    await expect(read()).rejects.toBeInstanceOf(TestDataEgressError);
    expect(lookup).toHaveBeenCalledWith({ correlationId: CORRELATION, record: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a write about a test record (M3's push) and logs why", async () => {
    lookup.mockResolvedValue({ isTest: true, named: true });
    await expect(write({ record: { id: 5, kind: "purchase_order" } })).rejects.toThrow("Not sent: test record");
    expect(lookup).toHaveBeenCalledWith({ correlationId: CORRELATION, record: { id: 5, kind: "purchase_order" } });
    expect(fetchMock).not.toHaveBeenCalled();
    const logged = db.executeQuery.mock.calls.map((c: unknown[]) => c[2] as { name: string; value: unknown }[]);
    expect(logged.some((params) => params.some((p) => p.name === "ErrorMessage" && p.value === "Not sent: test record"))).toBe(true);
  });

  it("refuses a company-file write that names no Floorplan record", async () => {
    lookup.mockResolvedValue({ isTest: false, named: false });
    const err = await write().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MyobRequestRefusedError);
    expect((err as MyobRequestRefusedError).code).toBe("no_record");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("lets a real record's write and a read about no record through", async () => {
    await expect(write()).resolves.toMatchObject({ ok: true });
    lookup.mockResolvedValue({ isTest: false, named: false });
    await expect(read()).resolves.toMatchObject({ ok: true });
  });

  it("never asks about the OAuth token call", async () => {
    await myobRequest({ actor: USER, body: new URLSearchParams({ grant_type: "refresh_token" }), headers: {}, method: "POST", purpose: "refresh", url: "https://secure.myob.com/oauth2/v1/authorize" });
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe("lookupMyobTestRecord (the default lookup)", () => {
  it("names nothing and reads nothing when the call names no record or proposal", async () => {
    await expect(lookupMyobTestRecord({ correlationId: null, record: null })).resolves.toEqual({ isTest: false, named: false });
    expect(db.createServiceRequestConnection).not.toHaveBeenCalled();
  });

  it("reads a named record's flag", async () => {
    db.executeQuery.mockResolvedValueOnce([{ IsTest: true }]);
    await expect(lookupMyobTestRecord({ correlationId: null, record: { id: 5, kind: "purchase_order" } })).resolves.toEqual({ isTest: true, named: true });
    expect(db.executeQuery.mock.calls[0][1]).toBe(IS_TEST_SQL.purchase_order);
  });

  it("finds the record through the proposal a call's correlation id belongs to", async () => {
    db.executeQuery.mockResolvedValueOnce([{ SubjectId: 9, SubjectType: "quote" }]).mockResolvedValueOnce([{ IsTest: false }]);
    await expect(lookupMyobTestRecord({ correlationId: CORRELATION, record: null })).resolves.toEqual({ isTest: false, named: true });
    expect(db.executeQuery.mock.calls[0][1]).toBe(PROPOSAL_SUBJECT_SQL);
    expect(PROPOSAL_SUBJECT_SQL).toMatch(/IF OBJECT_ID\(N'dbo\.MyobProposals', N'U'\) IS NOT NULL/);
    expect(db.executeQuery.mock.calls[1][1]).toBe(IS_TEST_SQL.quote);
    expect(db.executeQuery.mock.calls[1][2]).toEqual([expect.objectContaining({ value: 9 })]);
  });

  it("names nothing when the correlation id is no proposal's", async () => {
    await expect(lookupMyobTestRecord({ correlationId: CORRELATION, record: null })).resolves.toEqual({ isTest: false, named: false });
  });
});

describe("a named record that doesn't exist (D11, from the M review: fail closed)", () => {
  it("the default lookup says so, for a record named by the caller or through a proposal", async () => {
    db.executeQuery.mockResolvedValueOnce([]);
    await expect(lookupMyobTestRecord({ correlationId: null, record: { id: 404, kind: "purchase_order" } })).resolves.toEqual({
      isTest: false,
      missing: true,
      named: true,
    });
    db.executeQuery.mockResolvedValueOnce([{ SubjectId: 404, SubjectType: "quote" }]).mockResolvedValueOnce([]);
    await expect(lookupMyobTestRecord({ correlationId: CORRELATION, record: null })).resolves.toEqual({ isTest: false, missing: true, named: true });
  });

  it("an existing real record is not missing", async () => {
    db.executeQuery.mockResolvedValueOnce([{ IsTest: false }]);
    await expect(lookupMyobTestRecord({ correlationId: null, record: { id: 5, kind: "purchase_order" } })).resolves.toEqual({ isTest: false, named: true });
  });

  it("myobRequest refuses a read or a write about it (no_record) and never reaches MYOB", async () => {
    lookup.mockResolvedValue({ isTest: false, missing: true, named: true });
    for (const call of [() => read(), () => write({ record: { id: 404, kind: "purchase_order" } })]) {
      const err = await call().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(MyobRequestRefusedError);
      expect((err as MyobRequestRefusedError).code).toBe("no_record");
      expect((err as Error).message).toMatch(/doesn't exist/);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("when the test-record check itself fails (D9 review: fail closed)", () => {
  it("myobRequest refuses the call and never reaches MYOB", async () => {
    lookup.mockRejectedValue(new Error("database unreachable"));
    await expect(read()).rejects.toThrow("database unreachable");
    await expect(write({ record: { id: 5, kind: "purchase_order" } })).rejects.toThrow("database unreachable");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("the default lookup lets the failure through instead of answering 'not a test record'", async () => {
    db.executeQuery.mockRejectedValueOnce(new Error("database unreachable"));
    await expect(lookupMyobTestRecord({ correlationId: null, record: { id: 5, kind: "purchase_order" } })).rejects.toThrow("database unreachable");
    db.executeQuery.mockRejectedValueOnce(new Error("database unreachable"));
    await expect(lookupMyobTestRecord({ correlationId: CORRELATION, record: null })).rejects.toThrow("database unreachable");
  });
});
