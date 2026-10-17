/// <reference types="jest" />
import { HttpRequest, InvocationContext } from "@azure/functions";

// SEC-10: a flood of unauthenticated registerSelf calls naming the office's IP
// must not lock the office out; the token is verified before anything counts.

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn(), storageQueue: jest.fn(), timer: jest.fn() } };
});
jest.mock("../auth", () => ({
  ...jest.requireActual("../auth"),
  errorResponse: jest.fn().mockReturnValue({ status: 500, jsonBody: { error: "Error" } }),
  unauthorizedResponse: jest.fn().mockReturnValue({ status: 401, jsonBody: { error: "Unauthorized" } }),
  verifiedIdentityFromRequest: jest.fn(),
}));
jest.mock("../db", () => ({
  beginTransaction: jest.fn(),
  closeConnection: jest.fn(),
  commitTransaction: jest.fn(),
  createRequestConnection: jest.fn(),
  createServiceRequestConnection: jest.fn().mockResolvedValue({}),
  executeQuery: jest.fn(),
  rollbackTransaction: jest.fn(),
}));
jest.mock("../sentry", () => ({ Sentry: { captureException: jest.fn(), captureMessage: jest.fn() } }));

type Handler = (req: HttpRequest, ctx: InvocationContext) => Promise<{ status: number }>;
const auth = require("../auth") as { verifiedIdentityFromRequest: jest.Mock };
const db = require("../db") as { executeQuery: jest.Mock };
const { _resetRateLimitForTests } = require("../rateLimit") as { _resetRateLimitForTests: () => void };
const { registerSelf } = require("./users") as { registerSelf: Handler };

const OFFICE = "203.0.113.5";
const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;
const req = (xff: string) =>
  ({ headers: { get: (k: string) => (k.toLowerCase() === "x-forwarded-for" ? xff : null) }, json: jest.fn() }) as unknown as HttpRequest;
const staff = (oid: string) => ({ email: `${oid}@randazzo.properties`, name: oid, oid });

beforeEach(() => {
  jest.clearAllMocks();
  _resetRateLimitForTests();
  db.executeQuery.mockResolvedValue([{ Role: "facilities", UserID: 1 }]);
});

describe("registerSelf rate limiting", () => {
  it("ignores unauthenticated floods when counting the office's sign-ins", async () => {
    auth.verifiedIdentityFromRequest.mockResolvedValue(null);
    for (let i = 0; i < 500; i++) {
      expect((await registerSelf(req(`${OFFICE}, ${OFFICE}`), ctx)).status).toBe(401);
    }

    auth.verifiedIdentityFromRequest.mockResolvedValue(staff("fay"));
    expect((await registerSelf(req(OFFICE), ctx)).status).toBe(200);
  });

  it("is not fooled by a spoofed first X-Forwarded-For entry", async () => {
    for (let i = 0; i < 120; i++) {
      auth.verifiedIdentityFromRequest.mockResolvedValueOnce(staff(`insider-${i % 10}`));
      await registerSelf(req(`${OFFICE}, 192.0.2.66`), ctx);
    }

    auth.verifiedIdentityFromRequest.mockResolvedValue(staff("fay"));
    expect((await registerSelf(req(OFFICE), ctx)).status).toBe(200);
  });

  it("answers 429 once one user passes 20 a minute", async () => {
    auth.verifiedIdentityFromRequest.mockResolvedValue(staff("loop"));
    for (let i = 0; i < 20; i++) expect((await registerSelf(req(OFFICE), ctx)).status).toBe(200);
    expect((await registerSelf(req(OFFICE), ctx)).status).toBe(429);
  });
});
