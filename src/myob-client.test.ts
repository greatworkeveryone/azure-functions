/// <reference types="jest" />

jest.mock("./myob-auth", () => ({
  getValidMyobAccessToken: jest.fn().mockResolvedValue("access-token"),
}));
jest.mock("./myob-api-log", () => ({
  ...jest.requireActual("./myob-api-log"),
  myobRequest: jest.fn(),
}));

import { applyMyobPayment, createMyobBill } from "./myob-client";
import { MyobWritesDisabledError, type MyobActor } from "./myob-api-log";

const { myobRequest } = require("./myob-api-log") as { myobRequest: jest.Mock };
const { getValidMyobAccessToken } = require("./myob-auth") as { getValidMyobAccessToken: jest.Mock };

const ACTOR: MyobActor = { kind: "user", name: "Johanne CFO", oid: "cfo-oid", role: "accounts_manager" };
const TIMER: MyobActor = { kind: "system", name: "someTimer" };
const CORRELATION = "9b1f2c34-5d6e-4f70-8a91-0b2c3d4e5f60";

const response = (over: Record<string, unknown> = {}) => ({
  correlationId: CORRELATION,
  headers: new Headers(),
  json: () => ({ UID: "o-1" }),
  myobUid: "new-uid",
  ok: true,
  status: 201,
  statusText: "Created",
  text: "",
  ...over,
});

// Like myobRequest, build the headers (refreshing the token) only when called.
const respond = (over: Record<string, unknown> = {}) =>
  myobRequest.mockImplementation(async (req: { headers: unknown; resolvedHeaders?: unknown }) => {
    req.resolvedHeaders = typeof req.headers === "function" ? await req.headers() : req.headers;
    return response(over);
  });

beforeEach(() => {
  jest.clearAllMocks();
  getValidMyobAccessToken.mockResolvedValue("access-token");
  respond();
});

const lastRequest = () => myobRequest.mock.calls[myobRequest.mock.calls.length - 1][0];

describe("createMyobBill", () => {
  const bill = { amount: 100, jobId: 9, jobTitle: "Roof", referenceNumber: "PAY-9-1", sqlToken: "sql-token" };

  it("goes through myobRequest as a POST with the actor and bearer token", async () => {
    const result = await createMyobBill({ ...bill, actor: ACTOR });

    expect(result.uid).toBe("new-uid");
    expect(lastRequest()).toMatchObject({
      actor: ACTOR,
      method: "POST",
      purpose: "create-bill",
      resolvedHeaders: { Authorization: "Bearer access-token" },
    });
    expect(lastRequest().url).toMatch(/\/Purchase\/Bill\/Service$/);
  });

  it("passes a supplied correlationId to the request and to the token lookup", async () => {
    await createMyobBill({ ...bill, actor: ACTOR, correlationId: CORRELATION });

    expect(lastRequest().correlationId).toBe(CORRELATION);
    expect(getValidMyobAccessToken).toHaveBeenCalledWith("sql-token", ACTOR, CORRELATION);
  });

  it("leaves the correlationId unset when none is supplied, so myobRequest generates one", async () => {
    await createMyobBill({ ...bill, actor: TIMER });

    expect(lastRequest().correlationId).toBeUndefined();
    expect(getValidMyobAccessToken).toHaveBeenCalledWith("sql-token", TIMER, undefined);
  });

  it("throws on a non-2xx response", async () => {
    respond({ ok: false, status: 400, text: "bad supplier" });

    await expect(createMyobBill({ ...bill, actor: ACTOR })).rejects.toThrow("MYOB createBill 400: bad supplier");
  });

  it("lets MyobWritesDisabledError reach the caller", async () => {
    myobRequest.mockRejectedValue(new MyobWritesDisabledError());

    await expect(createMyobBill({ ...bill, actor: ACTOR })).rejects.toBeInstanceOf(MyobWritesDisabledError);
  });
});

describe("headers", () => {
  it("are built inside myobRequest, after its guards, so a refused call never refreshes the token", async () => {
    myobRequest.mockResolvedValue(response());

    await createMyobBill({ actor: ACTOR, amount: 1, jobId: 1, jobTitle: "t", referenceNumber: "r", sqlToken: null });

    expect(typeof lastRequest().headers).toBe("function");
    expect(getValidMyobAccessToken).not.toHaveBeenCalled();
  });
});

describe("applyMyobPayment", () => {
  it("POSTs through myobRequest with the actor and correlationId", async () => {
    respond({ status: 204 });

    await applyMyobPayment({ actor: ACTOR, amount: 50, billUid: "bill-1", correlationId: CORRELATION, sqlToken: "t" });

    expect(lastRequest()).toMatchObject({
      actor: ACTOR,
      correlationId: CORRELATION,
      method: "POST",
      purpose: "apply-payment",
    });
    expect(lastRequest().url).toMatch(/\/Purchase\/PaymentPurchase$/);
    expect(lastRequest().body.Bills).toEqual([{ AmountApplied: 50, UID: "bill-1" }]);
    expect(getValidMyobAccessToken).toHaveBeenCalledWith("t", ACTOR, CORRELATION);
  });

  it("leaves the correlationId unset when none is supplied", async () => {
    respond({ status: 204 });

    await applyMyobPayment({ actor: TIMER, amount: 50, billUid: "bill-1", sqlToken: null });

    expect(lastRequest().correlationId).toBeUndefined();
  });

  it("throws on a non-2xx response", async () => {
    respond({ ok: false, status: 404, statusText: "Not Found", text: "no bill" });

    await expect(applyMyobPayment({ actor: ACTOR, amount: 50, billUid: "x", sqlToken: null })).rejects.toThrow(
      "MYOB API 404 Not Found: no bill",
    );
  });
});
