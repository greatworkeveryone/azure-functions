/// <reference types="jest" />

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn(), storageQueue: jest.fn(), timer: jest.fn() } };
});
jest.mock("../myob-link", () => ({ completeMyobLink: jest.fn() }));

import type { HttpRequest, InvocationContext } from "@azure/functions";
import { myobAuthCallback } from "./myobAuthCallback";

const { completeMyobLink } = require("../myob-link") as { completeMyobLink: jest.Mock };

const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;
const request = (query: string) => ({ query: new URLSearchParams(query) }) as unknown as HttpRequest;
const FILE = "0f9e8d7c-6b5a-4f3e-9d2c-1b0a99887766";

beforeEach(() => jest.clearAllMocks());

describe("myobAuthCallback", () => {
  it("passes code, state and MYOB's businessId to the link", async () => {
    completeMyobLink.mockResolvedValue({ businessId: FILE, myobUsername: "fp", ok: true, relinked: false });

    const res = await myobAuthCallback(request(`code=abc&state=s&businessId=${FILE}`), ctx);

    expect(res.status).toBe(200);
    expect(completeMyobLink).toHaveBeenCalledWith({ businessId: FILE, code: "abc", state: "s" });
    expect(String(res.body)).toContain(FILE);
  });

  it.each([400, 409] as const)("answers %i with the reason when the link is refused", async (status) => {
    completeMyobLink.mockResolvedValue({ detail: "why <b>", ok: false, status, title: "Refused" });

    const res = await myobAuthCallback(request("code=abc&state=s"), ctx);

    expect(res.status).toBe(status);
    expect(String(res.body)).toContain("why &lt;b&gt;");
  });

  it("400 without calling the link when code or state is missing, or MYOB returned an error", async () => {
    expect((await myobAuthCallback(request("state=s"), ctx)).status).toBe(400);
    expect((await myobAuthCallback(request("error=access_denied"), ctx)).status).toBe(400);
    expect(completeMyobLink).not.toHaveBeenCalled();
  });

  it("500 without leaking internal error text", async () => {
    completeMyobLink.mockRejectedValue(new Error("Login failed for user 'sa' at 10.0.0.4"));

    const res = await myobAuthCallback(request("code=abc&state=s"), ctx);

    expect(res.status).toBe(500);
    expect(String(res.body)).not.toContain("10.0.0.4");
  });
});
