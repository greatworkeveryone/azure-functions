/// <reference types="jest" />

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn(), storageQueue: jest.fn(), timer: jest.fn() } };
});
jest.mock("../db", () => ({ closeConnection: jest.fn(), createRequestConnection: jest.fn().mockResolvedValue({}) }));
jest.mock("../auth", () => ({
  ...jest.requireActual("../auth"),
  extractToken: jest.fn().mockReturnValue("token"),
  rolesForRequest: jest.fn().mockResolvedValue(["accounts_manager"]),
  verifiedIdentityFromRequest: jest.fn().mockResolvedValue({ email: "r@rp", name: "Ray", oid: "ray-oid" }),
}));
jest.mock("../ledger/actor", () => ({ resolveLedgerActor: jest.fn().mockResolvedValue({ kind: "user", name: "Ray", role: "accounts_manager", userId: 3 }) }));
jest.mock("../myob/proposalsStore", () => ({ proposalsForSubject: jest.fn() }));
jest.mock("../myob/readbackRun", () => ({ ...jest.requireActual("../myob/readbackRun"), readBackRows: jest.fn() }));
jest.mock("../rateLimit", () => ({ checkRateLimit: jest.fn().mockReturnValue({ allowed: true, retryAfterMs: 0 }) }));

import type { HttpRequest, InvocationContext } from "@azure/functions";
import { refreshMyobRecord } from "./refreshMyobRecord";

const auth = require("../auth") as Record<string, jest.Mock>;
const { proposalsForSubject } = require("../myob/proposalsStore") as { proposalsForSubject: jest.Mock };
const { readBackRows } = require("../myob/readbackRun") as { readBackRows: jest.Mock };
const { checkRateLimit } = require("../rateLimit") as { checkRateLimit: jest.Mock };

const ctx = { error: jest.fn(), log: jest.fn() } as unknown as InvocationContext;
const post = (body: unknown) => ({ json: async () => body }) as unknown as HttpRequest;
const BODY = { subjectId: 9, subjectType: "purchase_order" };
const NOW = Date.parse("2026-10-15T00:12:00Z");
const saved = { ...process.env };

beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...saved, MYOB_READBACK_ENABLED: "true" };
  jest.useFakeTimers().setSystemTime(NOW);
  proposalsForSubject.mockResolvedValue([
    { lastReadBackAt: "2026-10-15T00:00:00Z", myobUid: "a", proposalId: 7, state: "verified" },
    { lastReadBackAt: "2026-10-15T00:10:00Z", myobUid: "b", proposalId: 6, state: "verified" },
    { lastReadBackAt: null, myobUid: "a", proposalId: 5, state: "verified" },
  ]);
  readBackRows.mockResolvedValue({ read: 1 });
});

afterEach(() => jest.useRealTimers());
afterAll(() => {
  process.env = saved;
});

describe("refreshMyobRecord", () => {
  it("reads back only the latest record per MYOB uid that wasn't checked in the last 5 minutes", async () => {
    const res = await refreshMyobRecord(post(BODY), ctx);
    expect(res.status).toBe(200);
    expect(readBackRows.mock.calls[0][1].map((row: { proposalId: number }) => row.proposalId)).toEqual([7]);
    expect(readBackRows.mock.calls[0][2]).toMatchObject({ actors: { myob: { kind: "user", name: "Ray" } }, dryRun: false });
  });

  it("reads nothing while the read-back is off, and answers with what Floorplan last saw", async () => {
    delete process.env.MYOB_READBACK_ENABLED;
    const res = await refreshMyobRecord(post(BODY), ctx);
    expect(readBackRows).not.toHaveBeenCalled();
    expect(res.jsonBody).toMatchObject({ checked: 0, readback: "off" });
  });

  it("429s past the rate limit, 403s a role that can't see MYOB, 400s a bad subject", async () => {
    checkRateLimit.mockReturnValueOnce({ allowed: false, retryAfterMs: 30_000 });
    expect((await refreshMyobRecord(post(BODY), ctx)).status).toBe(429);
    auth.rolesForRequest.mockResolvedValueOnce(["facilities"]);
    expect((await refreshMyobRecord(post(BODY), ctx)).status).toBe(403);
    expect((await refreshMyobRecord(post({ subjectId: 9, subjectType: "invoice" }), ctx)).status).toBe(400);
  });
});
