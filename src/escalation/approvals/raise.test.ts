import { EscalationError } from "../errors";
import { concludeApproval, raiseApproval } from "./raise";

const mockRaise = jest.fn();
const mockConclude = jest.fn();
jest.mock("../engine", () => ({
  concludeForSubject: (...args: unknown[]) => mockConclude(...args),
  raise: (...args: unknown[]) => mockRaise(...args),
}));
jest.mock("../../sentry", () => ({ Sentry: { captureException: jest.fn() } }));

const conn = {} as never;
const actor = { kind: "user", name: "Ann", role: "facilities", userId: 1 } as never;
const base = { actor, headline: "h", policyKey: "leave.decision", subjectId: "9", subjectType: "leave_request" };

beforeEach(() => {
  mockRaise.mockReset();
  mockConclude.mockReset();
});

describe("raiseApproval", () => {
  it("is a quiet no-op when the policy is switched off (the seeded state) or not migrated", async () => {
    const log = jest.fn();
    mockRaise.mockRejectedValueOnce(new EscalationError("policy_inactive", "off"));
    expect(await raiseApproval(conn, { ...base, log })).toBeNull();
    mockRaise.mockRejectedValueOnce(new EscalationError("unknown_policy", "none"));
    expect(await raiseApproval(conn, { ...base, log })).toBeNull();
    expect(log).toHaveBeenCalledTimes(2);
  });

  it("never throws, even when the engine fails or the logger does", async () => {
    mockRaise.mockRejectedValueOnce(new Error("sql down"));
    await expect(raiseApproval(conn, { ...base, log: () => { throw new Error("no logger"); } })).resolves.toBeNull();
  });

  it("returns the row it wrote, and passes the named approvers and the people who may not approve", async () => {
    mockRaise.mockResolvedValueOnce({ created: true, escalation: { escalationId: 5 } });
    const row = await raiseApproval(conn, { ...base, excludeUserIds: [1], startAtRole: "director", userTargets: [2, 3] });
    expect(row).toEqual({ escalationId: 5 });
    expect(mockRaise).toHaveBeenCalledWith(conn, expect.objectContaining({ excludeUserIds: [1], startAtRole: "director", userTargets: [2, 3] }));
  });

  it("returns null for one that was already live, so nobody is told twice", async () => {
    mockRaise.mockResolvedValueOnce({ created: false, escalation: { escalationId: 5 } });
    expect(await raiseApproval(conn, base)).toBeNull();
  });
});

describe("concludeApproval", () => {
  it("ends only the named policies and counts what ended", async () => {
    mockConclude.mockResolvedValueOnce([{}, {}]);
    const n = await concludeApproval(conn, { actor, code: "approved", policyKeys: ["leave.decision"], subjectId: "9", subjectType: "leave_request" });
    expect(n).toBe(2);
    expect(mockConclude).toHaveBeenCalledWith(conn, expect.objectContaining({ policyKeys: ["leave.decision"], withdrawOpen: false }));
  });

  it("never throws", async () => {
    mockConclude.mockRejectedValueOnce(new Error("boom"));
    expect(await concludeApproval(conn, { actor, code: "approved", policyKeys: ["x"], subjectId: "9", subjectType: "leave_request" })).toBe(0);
  });
});
