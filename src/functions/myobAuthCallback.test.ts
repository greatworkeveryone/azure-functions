/// <reference types="jest" />

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn(), storageQueue: jest.fn(), timer: jest.fn() } };
});
jest.mock("../myob-auth", () => ({
  exchangeCodeForTokens: jest.fn().mockResolvedValue({ linked: true }),
  verifyAuthState: jest.fn().mockReturnValue(true),
}));

import type { HttpRequest, InvocationContext } from "@azure/functions";

const myobAuth = require("../myob-auth") as { exchangeCodeForTokens: jest.Mock };

require("./myobAuthCallback");
const { app } = require("@azure/functions") as { app: { http: jest.Mock } };
const handler = (app.http.mock.calls.find((c: unknown[]) => c[0] === "myobAuthCallback")?.[1] as {
  handler: (r: HttpRequest, c: InvocationContext) => Promise<{ status?: number }>;
}).handler;

const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;
const request = (query: string) => ({ query: new URLSearchParams(query) }) as unknown as HttpRequest;

describe("myobAuthCallback", () => {
  it("exchanges the code as the system actor, because MYOB drives this redirect with no user token", async () => {
    const res = await handler(request("code=abc&state=s"), ctx);

    expect(res.status).toBe(200);
    expect(myobAuth.exchangeCodeForTokens).toHaveBeenCalledWith({
      actor: { kind: "system", name: "myobAuthCallback" },
      authorizedBy: null,
      code: "abc",
      sqlToken: null,
    });
  });
});
