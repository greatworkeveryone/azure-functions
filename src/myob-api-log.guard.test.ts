/// <reference types="jest" />

// myobRequest's guards (allowlist, period, Floorplan-created records,
// company-file credentials) and its transport (timeout, one retry).

jest.mock("./db", () => ({
  closeConnection: jest.fn(),
  createServiceRequestConnection: jest.fn(),
  executeQuery: jest.fn(),
}));
jest.mock("./sentry", () => ({ Sentry: { captureException: jest.fn(), captureMessage: jest.fn() } }));
jest.mock("./myob-health", () => ({
  MYOB_HEALTH_SUBJECTS: { agreement: "myob_agreement", link: "myob_link" },
  raiseMyobHealth: jest.fn().mockResolvedValue(undefined),
}));

import { todayInDarwin } from "./darwinDate";
import { MyobRequestRefusedError, MyobTimeoutError, myobRequest, type MyobActor } from "./myob-api-log";
import { setFloorplanRecordLookup } from "./myob-request-guard";

const db = require("./db") as Record<string, jest.Mock>;
const { raiseMyobHealth } = require("./myob-health") as { raiseMyobHealth: jest.Mock };

const CF = "0f9e8d7c-6b5a-4f3e-9d2c-1b0a99887766";
const UID = "11111111-2222-4333-8444-555555555555";
const API = `https://api.myob.com/accountright/${CF}`;
const TODAY = todayInDarwin();
const USER: MyobActor = { kind: "user", name: "Johanne CFO", oid: "cfo-oid", role: "cfo" };
const fetchMock = jest.fn();
const saved = { ...process.env };

type Row = Record<string, unknown>;
const rows = (): Row[] =>
  db.executeQuery.mock.calls.map((c: unknown[]) =>
    Object.fromEntries((c[2] as { name: string; value: unknown }[]).map((p) => [p.name, p.value])),
  );

beforeEach(() => {
  jest.clearAllMocks();
  db.createServiceRequestConnection.mockResolvedValue({});
  db.executeQuery.mockReset().mockResolvedValue([]);
  fetchMock.mockReset().mockImplementation(async () => new Response("{}", { status: 200 }));
  global.fetch = fetchMock as unknown as typeof fetch;
  process.env = { ...saved, MYOB_WRITES_ENABLED: "true" };
  delete process.env.MYOB_CF_USER;
  delete process.env.MYOB_CF_PASSWORD;
  delete process.env.MYOB_PERIOD_START;
  setFloorplanRecordLookup(null);
  jest.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

afterAll(() => {
  process.env = saved;
});

const call = (over: Partial<Parameters<typeof myobRequest>[0]> = {}) =>
  myobRequest({
    actor: USER,
    body: { Date: TODAY },
    headers: { Authorization: "Bearer t" },
    method: "POST",
    purpose: "create-order",
    url: `${API}/Purchase/Order/Service`,
    ...over,
  });

describe("allowlist", () => {
  it("refuses a forbidden centre before anything is sent, logs one error row and raises system.health", async () => {
    const err = await call({ method: "GET", url: `${API}/Contact/Supplier` }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MyobRequestRefusedError);
    expect(err).toMatchObject({ code: "not_allowed", forbiddenCentre: "Card File" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ Method: "GET", Phase: "error", Path: `/accountright/${CF}/Contact/Supplier` });
    expect(String(rows()[0].ErrorMessage)).toContain("Card File");
    expect(raiseMyobHealth).toHaveBeenCalledWith(
      "myob_agreement",
      expect.stringContaining("Contact/Supplier"),
      expect.objectContaining({ actor: "Johanne CFO", centre: "Card File" }),
    );
  });

  it("refuses POST /Banking/SpendMoneyTxn even with writes switched on", async () => {
    await expect(call({ url: `${API}/Banking/SpendMoneyTxn` })).rejects.toMatchObject({ forbiddenCentre: "Banking" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a DELETE without raising system.health (no centre involved)", async () => {
    await expect(call({ method: "DELETE", url: `${API}/Purchase/Order/Service/${UID}` })).rejects.toMatchObject({
      code: "not_allowed",
      message: "Floorplan never deletes anything in MYOB",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(raiseMyobHealth).not.toHaveBeenCalled();
  });
});

describe("period guard", () => {
  it("refuses a backdated create before checking anything else", async () => {
    await expect(call({ body: { Date: "2026-01-05" } })).rejects.toMatchObject({ code: "outside_period" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(rows()).toHaveLength(1);
  });

  it("lets a create dated today through", async () => {
    await call();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("updates only to records Floorplan created", () => {
  const put = () => call({ method: "PUT", purpose: "update-order", url: `${API}/Purchase/Order/Service/${UID}` });

  it("refuses a PUT by default: no record is known to be Floorplan's", async () => {
    await expect(put()).rejects.toMatchObject({ code: "not_floorplan_record" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a PUT for a uid the lookup does not recognise, and sends one it does", async () => {
    const lookup = jest.fn(async ({ uid }: { uid: string }) => uid === UID);
    setFloorplanRecordLookup(lookup);

    await put();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledWith({ companyFileId: CF, operation: "orders.update", uid: UID });

    await expect(
      call({ method: "PUT", url: `${API}/Purchase/Order/Service/99999999-2222-4333-8444-555555555555` }),
    ).rejects.toMatchObject({ code: "not_floorplan_record" });
  });
});

describe("company-file credentials", () => {
  it("sends x-myobapi-cftoken from MYOB_CF_USER/MYOB_CF_PASSWORD and never logs it", async () => {
    process.env.MYOB_CF_USER = "Floorplan Integration";
    process.env.MYOB_CF_PASSWORD = "pa55";

    await call({ method: "GET", url: `${API}/Purchase/Order` });

    const sent = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    const token = Buffer.from("Floorplan Integration:pa55").toString("base64");
    expect(sent["x-myobapi-cftoken"]).toBe(token);
    expect(JSON.stringify(rows())).not.toContain(token);
  });

  it("does not add it to the OAuth token call, and keeps an approver's own", async () => {
    process.env.MYOB_CF_USER = "u";
    process.env.MYOB_CF_PASSWORD = "p";

    await call({ body: new URLSearchParams({ grant_type: "refresh_token" }), url: "https://secure.myob.com/oauth2/v1/authorize/" });
    await call({ headers: { "x-myobapi-cftoken": "approver" }, method: "GET", url: `${API}/Purchase/Order` });

    expect(fetchMock.mock.calls[0][1].headers["x-myobapi-cftoken"]).toBeUndefined();
    expect(fetchMock.mock.calls[1][1].headers["x-myobapi-cftoken"]).toBe("approver");
  });

  it("refuses when only one of the two is set", async () => {
    process.env.MYOB_CF_USER = "u";
    await expect(call({ method: "GET", url: `${API}/Purchase/Order` })).rejects.toMatchObject({ code: "config" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("timeout", () => {
  it("gives up after 30 s, logs an error row and throws MyobTimeoutError", async () => {
    jest.useFakeTimers();
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason))),
    );

    const pending = call({ method: "GET", url: `${API}/Purchase/Order` });
    const assertion = expect(pending).rejects.toBeInstanceOf(MyobTimeoutError);
    await jest.advanceTimersByTimeAsync(29_999);
    expect(rows().filter((r) => r.Phase === "error")).toHaveLength(0);
    await jest.advanceTimersByTimeAsync(1);
    await assertion;

    expect(rows().map((r) => r.Phase)).toEqual(["request", "error"]);
    expect(rows()[1].ErrorMessage).toBe("MYOB did not answer within 30 s");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("one retry", () => {
  const reply = (status: number) => new Response("{}", { headers: { "Retry-After": "0" }, status });

  it("retries a 429 once, logging each attempt", async () => {
    fetchMock.mockResolvedValueOnce(reply(429)).mockResolvedValueOnce(reply(200));

    const res = await call();

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(rows().map((r) => [r.Phase, r.Attempt])).toEqual([
      ["request", 1],
      ["response", 1],
      ["request", 2],
      ["response", 2],
    ]);
  });

  it("retries a 5xx on a read", async () => {
    fetchMock.mockResolvedValueOnce(reply(503)).mockResolvedValueOnce(reply(200));
    await expect(call({ method: "GET", url: `${API}/Purchase/Order` })).resolves.toMatchObject({ status: 200 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("never retries a 5xx on a write, which may have landed", async () => {
    fetchMock.mockImplementation(async () => reply(500));
    await expect(call()).resolves.toMatchObject({ status: 500 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries only once", async () => {
    fetchMock.mockImplementation(async () => reply(429));
    await expect(call({ method: "GET", url: `${API}/Purchase/Order` })).resolves.toMatchObject({ status: 429 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
