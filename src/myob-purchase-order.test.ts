/// <reference types="jest" />

jest.mock("./myob-client", () => ({ myobHeaders: jest.fn().mockResolvedValue({ Authorization: "Bearer t" }) }));
jest.mock("./myob-api-log", () => ({ ...jest.requireActual("./myob-api-log"), myobRequest: jest.fn() }));

import * as purchases from "./myob-purchase-order";

const { myobRequest } = require("./myob-api-log") as { myobRequest: jest.Mock };
const { myobHeaders } = require("./myob-client") as { myobHeaders: jest.Mock };

const CF = "0f9e8d7c-6b5a-4f3e-9d2c-1b0a99887766";
const UID = "44444444-2222-4333-8444-555555555555";
const ACTOR = { kind: "user" as const, name: "Johanne" };
const ok = (over: Record<string, unknown> = {}) => ({ json: () => ({}), myobUid: UID, ok: true, status: 201, text: "", ...over });
const last = () => myobRequest.mock.calls[myobRequest.mock.calls.length - 1][0];

beforeEach(() => {
  jest.clearAllMocks();
  myobRequest.mockResolvedValue(ok());
});

describe("purchases client", () => {
  it("has no delete and no convert-to-bill: Floorplan never deletes in MYOB (decision 11)", () => {
    expect(Object.keys(purchases).filter((name) => /delete|remove|convert/i.test(name))).toEqual([]);
  });

  it("looks a number up with an OData filter on the service list, escaping quotes", async () => {
    myobRequest.mockResolvedValue(ok({ json: () => ({ Items: [{ Number: "O'1", UID }] }), status: 200 }));
    const found = await purchases.findPurchaseByNumber("Order", CF, "O'1", ACTOR, "c");
    expect(found).toMatchObject({ UID });
    expect(last()).toMatchObject({ method: "GET", url: `https://api.myob.com/accountright/${CF}/Purchase/Order/Service?$filter=${encodeURIComponent("Number eq 'O''1'")}` });
  });

  it("POSTs the exact string given and returns MYOB's uid", async () => {
    await expect(purchases.createPurchase("Quote", CF, '{"Number":"Q1"}', ACTOR, "c")).resolves.toBe(UID);
    expect(last()).toMatchObject({ body: '{"Number":"Q1"}', method: "POST", url: `https://api.myob.com/accountright/${CF}/Purchase/Quote/Service` });
  });

  it("builds headers lazily: no token is fetched until myobRequest asks", async () => {
    await purchases.createPurchase("Order", CF, "{}", ACTOR, "c");
    expect(typeof last().headers).toBe("function");
    expect(myobHeaders).not.toHaveBeenCalled();
    await last().headers();
    expect(myobHeaders).toHaveBeenCalledWith(null, ACTOR, "c");
  });

  it("PUTs to the record's own address", async () => {
    await purchases.putPurchase("Order", CF, UID, "{}", ACTOR, "c");
    expect(last()).toMatchObject({ method: "PUT", url: `https://api.myob.com/accountright/${CF}/Purchase/Order/Service/${UID}` });
  });

  it("turns a MYOB refusal into MyobPurchaseError with MYOB's words", async () => {
    myobRequest.mockResolvedValue(ok({ ok: false, status: 400, text: "Supplier is inactive" }));
    await expect(purchases.createPurchase("Order", CF, "{}", ACTOR)).rejects.toThrow("Supplier is inactive");
  });
});
