/// <reference types="jest" />

jest.mock("./db", () => ({
  closeConnection: jest.fn(),
  createServiceRequestConnection: jest.fn(),
  executeQuery: jest.fn(),
}));
jest.mock("./sentry", () => ({ Sentry: { captureException: jest.fn(), captureMessage: jest.fn() } }));

import {
  MAX_LOGGED_RESPONSE_CHARS,
  MyobAuditLogError,
  MyobWritesDisabledError,
  myobRequest,
  redactSecrets,
  userActor,
  type MyobActor,
} from "./myob-api-log";

const db = require("./db") as {
  closeConnection: jest.Mock;
  createServiceRequestConnection: jest.Mock;
  executeQuery: jest.Mock;
};
const { Sentry } = require("./sentry") as { Sentry: { captureException: jest.Mock } };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const API = "https://api.myob.com/accountright/cf-guid";
const OAUTH = "https://secure.myob.com/oauth2/v1/authorize/";
const USER: MyobActor = { kind: "user", name: "Johanne CFO", oid: "cfo-oid", role: "accounts_manager" };
const SYSTEM: MyobActor = { kind: "system", name: "someTimer" };
const SECRET_HEADERS = { Authorization: "Bearer super-secret-access-token", "x-myobapi-key": "the-api-key" };

const fetchMock = jest.fn();

type Row = Record<string, unknown>;
const rows = (): Row[] =>
  db.executeQuery.mock.calls.map((c: unknown[]) =>
    Object.fromEntries((c[2] as { name: string; value: unknown }[]).map((p) => [p.name, p.value])),
  );

const original = { writes: process.env.MYOB_WRITES_ENABLED, version: process.env.APP_VERSION };

beforeEach(() => {
  jest.clearAllMocks();
  db.createServiceRequestConnection.mockResolvedValue({});
  db.executeQuery.mockReset().mockResolvedValue([]);
  fetchMock.mockReset().mockImplementation(async () => new Response("{}", { status: 200 }));
  global.fetch = fetchMock as unknown as typeof fetch;
  process.env.MYOB_WRITES_ENABLED = "true";
  delete process.env.APP_VERSION;
  jest.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
  for (const [key, value] of [
    ["MYOB_WRITES_ENABLED", original.writes],
    ["APP_VERSION", original.version],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const call = (over: Partial<Parameters<typeof myobRequest>[0]> = {}) =>
  myobRequest({
    actor: USER,
    headers: SECRET_HEADERS,
    method: "POST",
    purpose: "create-bill",
    url: `${API}/Purchase/Bill/Service`,
    ...over,
  });

describe("redactSecrets", () => {
  it.each(["client_secret", "access_token", "refresh_token", "password", "Code", "authorization", "RefreshToken"])(
    "redacts %s",
    (key) => {
      expect(redactSecrets({ [key]: "value", keep: "kept" })).toEqual({ [key]: "[redacted]", keep: "kept" });
    },
  );

  it("recurses through objects and arrays, replacing a matching key's whole value", () => {
    expect(
      redactSecrets({
        Lines: [{ Amount: 5, Auth: { Token: { nested: true } }, TaxCode: { UID: "x" } }],
        Name: "Acme",
      }),
    ).toEqual({ Lines: [{ Amount: 5, Auth: { Token: "[redacted]" }, TaxCode: "[redacted]" }], Name: "Acme" });
  });

  it("leaves scalars and null alone", () => {
    expect(redactSecrets("token")).toBe("token");
    expect(redactSecrets(null)).toBeNull();
    expect(redactSecrets(42)).toBe(42);
  });
});

describe("myobRequest logging", () => {
  it("writes the request row before calling MYOB and the response row after, sharing a CorrelationId", async () => {
    fetchMock.mockResolvedValue(new Response("", { headers: { Location: `${API}/Purchase/Bill/Service/uid-123` }, status: 201 }));

    const res = await call({ body: { Amount: 5 } });

    const [request, response] = rows();
    expect(db.executeQuery).toHaveBeenCalledTimes(2);
    expect(request.Phase).toBe("request");
    expect(response.Phase).toBe("response");
    expect(request.CorrelationId).toMatch(UUID);
    expect(response.CorrelationId).toBe(request.CorrelationId);
    expect(res.correlationId).toBe(request.CorrelationId);
    const order = (m: jest.Mock, n: number) => m.mock.invocationCallOrder[n];
    expect(order(db.executeQuery, 0)).toBeLessThan(order(fetchMock, 0));
    expect(order(fetchMock, 0)).toBeLessThan(order(db.executeQuery, 1));
  });

  it("uses a service connection for the log and closes it each time", async () => {
    await call();

    expect(db.createServiceRequestConnection).toHaveBeenCalledTimes(2);
    expect(db.closeConnection).toHaveBeenCalledTimes(2);
  });

  it("records method, path (no host), purpose, actor and request body", async () => {
    await call({ body: { Amount: 5 }, url: `${API}/Purchase/Bill/Service?$top=5` });

    const [request] = rows();
    expect(request).toMatchObject({
      ActorKind: "user",
      ActorName: "Johanne CFO",
      ActorOid: "cfo-oid",
      ActorRole: "accounts_manager",
      Attempt: 1,
      Method: "POST",
      Path: "/accountright/cf-guid/Purchase/Bill/Service?$top=5",
      Purpose: "create-bill",
      RequestBody: '{"Amount":5}',
    });
    expect(String(request.Path)).not.toContain("api.myob.com");
  });

  it("records a system actor with no role or oid", async () => {
    await call({ actor: SYSTEM });

    expect(rows()[0]).toMatchObject({ ActorKind: "system", ActorName: "someTimer", ActorOid: null, ActorRole: null });
  });

  it("records the response status, redacted body, duration, MYOB uid and app version", async () => {
    process.env.APP_VERSION = "2026.10.13";
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ UID: "uid-9", access_token: "leak-me", Name: "x" }), { status: 200 }),
    );

    await call({ method: "GET" });

    const [, response] = rows();
    expect(response).toMatchObject({ AppVersion: "2026.10.13", ErrorMessage: null, HttpStatus: 200, MyobUid: "uid-9" });
    expect(response.ResponseBody).toBe('{"UID":"uid-9","access_token":"[redacted]","Name":"x"}');
    expect(typeof response.DurationMs).toBe("number");
  });

  it("takes the MYOB uid from the Location header", async () => {
    fetchMock.mockResolvedValue(new Response("", { headers: { Location: `${API}/Purchase/Bill/Service/abc-def/` }, status: 201 }));

    const res = await call();

    expect(res.myobUid).toBe("abc-def");
    expect(rows()[1].MyobUid).toBe("abc-def");
  });

  it("never logs headers, whatever the caller sends", async () => {
    await call({ body: { Amount: 5 } });

    const everything = JSON.stringify(rows());
    expect(everything).not.toContain("super-secret-access-token");
    expect(everything).not.toContain("the-api-key");
    expect(everything).not.toContain("Bearer");
  });

  it("redacts credentials in a JSON request body", async () => {
    await call({ body: { Lines: [{ Amount: 5 }], refresh_token: "r-1", Number: "PAY-1" } });

    const body = JSON.parse(String(rows()[0].RequestBody));
    expect(body).toEqual({ Lines: [{ Amount: 5 }], Number: "PAY-1", refresh_token: "[redacted]" });
  });

  it("redacts a form-encoded OAuth body", async () => {
    await call({
      body: new URLSearchParams({ client_id: "id", client_secret: "shh", code: "auth-code", grant_type: "authorization_code" }),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
      url: OAUTH,
    });

    expect(JSON.parse(String(rows()[0].RequestBody))).toEqual({
      client_id: "id",
      client_secret: "[redacted]",
      code: "[redacted]",
      grant_type: "authorization_code",
    });
    expect(fetchMock.mock.calls[0][1].body).toContain("client_secret=shh");
  });

  it("does not store a body it cannot parse", async () => {
    await call({ body: "plain text with token=abc" });

    expect(rows()[0].RequestBody).toBe("[non-JSON body not logged]");
  });

  it("redacts credential-looking query parameters in the logged path", async () => {
    await call({ method: "GET", url: `${API}/Contact?access_token=abc&$filter=Name` });

    const path = String(rows()[0].Path);
    expect(path).not.toContain("abc");
    expect(path).toContain("access_token=[redacted]");
  });

  it("truncates a long response body to the cap and marks it", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ Items: "x".repeat(40_000) }), { status: 200 }));

    await call({ method: "GET" });

    const stored = String(rows()[1].ResponseBody);
    expect(stored.length).toBeLessThanOrEqual(MAX_LOGGED_RESPONSE_CHARS);
    expect(stored.endsWith("…[truncated]")).toBe(true);
  });

  it("returns the full response to the caller even though the log is truncated", async () => {
    const big = JSON.stringify({ Items: "x".repeat(40_000) });
    fetchMock.mockResolvedValue(new Response(big, { status: 200 }));

    const res = await call({ method: "GET" });

    expect(res.text).toBe(big);
    expect(res.json<{ Items: string }>().Items).toHaveLength(40_000);
  });

  it("logs a non-2xx as a response row carrying the status and a message, and returns it", async () => {
    fetchMock.mockResolvedValue(new Response('{"Errors":[{"Message":"bad"}]}', { status: 400, statusText: "Bad Request" }));

    const res = await call();

    expect(res.ok).toBe(false);
    expect(res.status).toBe(400);
    expect(rows()[1]).toMatchObject({ ErrorMessage: "MYOB responded HTTP 400", HttpStatus: 400, Phase: "response" });
  });

  it("logs a transport failure as an error row and rethrows the original error", async () => {
    const boom = new Error("socket hang up");
    fetchMock.mockRejectedValue(boom);

    await expect(call()).rejects.toBe(boom);

    expect(rows()[1]).toMatchObject({ ErrorMessage: "socket hang up", HttpStatus: null, Phase: "error" });
  });

  it("records the attempt number", async () => {
    await call({ attempt: 3 });

    expect(rows().map((r) => r.Attempt)).toEqual([3, 3]);
  });

  it("clips values to their column widths so a long name can't fail the insert", async () => {
    await call({ actor: { kind: "user", name: "n".repeat(500), role: "r".repeat(200) }, purpose: "p".repeat(500) });

    const [request] = rows();
    expect(String(request.ActorName)).toHaveLength(200);
    expect(String(request.ActorRole)).toHaveLength(50);
    expect(String(request.Purpose)).toHaveLength(100);
  });
});

describe("myobRequest write order and failure handling", () => {
  it("does not call MYOB, and throws, when the request row cannot be written", async () => {
    db.executeQuery.mockRejectedValue(new Error("sql down"));

    await expect(call()).rejects.toBeInstanceOf(MyobAuditLogError);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not call MYOB when it cannot even connect to write the request row", async () => {
    db.createServiceRequestConnection.mockRejectedValue(new Error("no connection"));

    await expect(call()).rejects.toBeInstanceOf(MyobAuditLogError);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still returns the MYOB result, and reports loudly, when the response row cannot be written", async () => {
    fetchMock.mockResolvedValue(new Response("", { headers: { Location: `${API}/Purchase/Bill/Service/uid-1` }, status: 201 }));
    db.executeQuery.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error("sql went away"));

    const res = await call();

    expect(res.status).toBe(201);
    expect(res.myobUid).toBe("uid-1");
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: "sql went away" }),
      expect.objectContaining({ extra: expect.objectContaining({ phase: "response" }) }),
    );
    expect(console.error).toHaveBeenCalled();
  });

  it("still rethrows the original transport error when the error row cannot be written either", async () => {
    const boom = new Error("socket hang up");
    fetchMock.mockRejectedValue(boom);
    db.executeQuery.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error("sql went away"));

    await expect(call()).rejects.toBe(boom);

    expect(Sentry.captureException).toHaveBeenCalled();
  });
});

describe("MYOB_WRITES_ENABLED kill switch", () => {
  it.each([undefined, "", "false", "TRUE", "True", "1", "yes", " true"])(
    "refuses a write when MYOB_WRITES_ENABLED is %p: one error row, nothing sent",
    async (value) => {
      if (value === undefined) delete process.env.MYOB_WRITES_ENABLED;
      else process.env.MYOB_WRITES_ENABLED = value;

      await expect(call({ body: { Amount: 5 } })).rejects.toBeInstanceOf(MyobWritesDisabledError);

      expect(fetchMock).not.toHaveBeenCalled();
      const logged = rows();
      expect(logged).toHaveLength(1);
      expect(logged[0]).toMatchObject({
        ActorName: "Johanne CFO",
        ErrorMessage: "MYOB writes disabled (MYOB_WRITES_ENABLED)",
        Method: "POST",
        Phase: "error",
        Purpose: "create-bill",
      });
      expect(logged[0].RequestBody).toBeNull();
    },
  );

  it.each(["POST", "PUT", "DELETE"] as const)("refuses %s", async (method) => {
    delete process.env.MYOB_WRITES_ENABLED;

    await expect(call({ method })).rejects.toBeInstanceOf(MyobWritesDisabledError);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("lets a GET through while writes are off", async () => {
    delete process.env.MYOB_WRITES_ENABLED;

    const res = await call({ method: "GET" });

    expect(res.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("sends a write only for the exact string 'true'", async () => {
    process.env.MYOB_WRITES_ENABLED = "true";

    await call();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(rows().map((r) => r.Phase)).toEqual(["request", "response"]);
  });

  it("exempts the OAuth token exchange and refresh POSTs", async () => {
    delete process.env.MYOB_WRITES_ENABLED;

    await call({ body: new URLSearchParams({ grant_type: "refresh_token" }), url: OAUTH });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(rows().map((r) => r.Phase)).toEqual(["request", "response"]);
  });

  it("does not let another host, or a company-file path, claim the OAuth exemption", async () => {
    delete process.env.MYOB_WRITES_ENABLED;

    await expect(call({ url: "https://evil.example.com/oauth2/v1/authorize/" })).rejects.toBeInstanceOf(
      MyobWritesDisabledError,
    );
    await expect(call({ url: `${API}/oauth2/v1/authorize/` })).rejects.toBeInstanceOf(MyobWritesDisabledError);
    await expect(call({ url: "https://secure.myob.com/other/path" })).rejects.toBeInstanceOf(MyobWritesDisabledError);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still throws MyobWritesDisabledError, and reports, when the refusal row cannot be written", async () => {
    delete process.env.MYOB_WRITES_ENABLED;
    db.executeQuery.mockRejectedValue(new Error("sql down"));

    await expect(call()).rejects.toBeInstanceOf(MyobWritesDisabledError);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(Sentry.captureException).toHaveBeenCalled();
  });
});

describe("myobRequest correlationId", () => {
  it("uses a caller-supplied correlationId for every row of the call", async () => {
    const correlationId = "9b1f2c34-5d6e-4f70-8a91-0b2c3d4e5f60";

    const res = await call({ correlationId });

    expect(res.correlationId).toBe(correlationId);
    expect(rows().map((r) => r.CorrelationId)).toEqual([correlationId, correlationId]);
  });

  it("uses a caller-supplied correlationId on the kill-switch refusal row too", async () => {
    delete process.env.MYOB_WRITES_ENABLED;
    const correlationId = "9b1f2c34-5d6e-4f70-8a91-0b2c3d4e5f60";

    await expect(call({ correlationId })).rejects.toBeInstanceOf(MyobWritesDisabledError);

    expect(rows()[0].CorrelationId).toBe(correlationId);
  });

  it("generates a UUID when none is supplied, shared by the request and response rows", async () => {
    const res = await call();

    const [request, response] = rows();
    expect(res.correlationId).toMatch(UUID);
    expect(request.CorrelationId).toBe(res.correlationId);
    expect(response.CorrelationId).toBe(res.correlationId);
  });

  it("generates a fresh id for each call", async () => {
    const a = await call();
    const b = await call();

    expect(a.correlationId).not.toBe(b.correlationId);
  });

  it("rejects a correlationId that isn't a UUID before writing or sending anything", async () => {
    await expect(call({ correlationId: "not-a-uuid" })).rejects.toThrow(TypeError);

    expect(db.executeQuery).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("userActor", () => {
  it("carries name, oid and the first role", () => {
    expect(userActor({ name: "J", oid: "o" }, ["accounts_manager", "admin"])).toEqual({
      kind: "user",
      name: "J",
      oid: "o",
      role: "accounts_manager",
    });
  });

  it("omits role and oid when unknown", () => {
    expect(userActor({ name: "J" }, [])).toEqual({ kind: "user", name: "J" });
  });
});
