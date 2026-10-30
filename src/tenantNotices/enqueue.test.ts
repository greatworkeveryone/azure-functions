import type { Connection } from "tedious";
import { executeQuery } from "../db";
import { enqueueTenantNotice, noticeEventFor } from "./enqueue";

jest.mock("../db", () => ({ executeQuery: jest.fn().mockResolvedValue([]) }));
const query = jest.mocked(executeQuery);
const conn = {} as Connection;
const state = (status: string, awaitingRole = "facilities") => ({ awaitingRole, status });

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.TENANT_NOTICES_ENABLED;
  delete process.env.TENANT_NOTICES_DRY_RUN;
});

describe("noticeEventFor", () => {
  it("is 'attendance' when the job enters Work from anywhere but Work or the tenant block", () => {
    expect(noticeEventFor(state("Awaiting Approval"), state("Work"))).toBe("attendance");
    expect(noticeEventFor(state("New"), state("Work"))).toBe("attendance");
    expect(noticeEventFor(state("Tenant"), state("Work"))).toBeNull();
    expect(noticeEventFor(state("Work"), state("Work"))).toBeNull();
  });

  it("is 'completed' when the work is complete (on to accounts approval, or Done), once", () => {
    expect(noticeEventFor(state("Work"), state("Awaiting Approval", "accounts"))).toBe("completed");
    expect(noticeEventFor(state("New"), state("Done", "accounts"))).toBe("completed");
    expect(noticeEventFor(state("Awaiting Approval", "accounts"), state("Done", "accounts"))).toBeNull();
  });

  it("is nothing for the quote steps, the tenant block or a missing state", () => {
    expect(noticeEventFor(state("New"), state("Quote"))).toBeNull();
    expect(noticeEventFor(state("Quote"), state("Awaiting Approval"))).toBeNull();
    expect(noticeEventFor(state("Work"), state("Tenant"))).toBeNull();
    expect(noticeEventFor(null, state("Work"))).toBeNull();
  });
});

describe("enqueueTenantNotice", () => {
  it("queues nothing and touches nothing while the switch is off", async () => {
    expect(await enqueueTenantNotice(conn, 5, state("New"), state("Work"))).toBe(false);
    expect(query).not.toHaveBeenCalled();
  });

  it("inserts one outbox row, guarded by NOT EXISTS, for a booked job when enabled (and in dry run)", async () => {
    for (const env of ["TENANT_NOTICES_ENABLED", "TENANT_NOTICES_DRY_RUN"]) {
      query.mockClear();
      process.env[env] = "true";
      expect(await enqueueTenantNotice(conn, 5, state("Awaiting Approval"), state("Work"))).toBe(true);
      expect(query).toHaveBeenCalledTimes(1);
      const [, sql, params] = query.mock.calls[0];
      expect(sql).toMatch(/INSERT INTO dbo\.TenantNotices[\s\S]*WorkRequestID IS NOT NULL[\s\S]*IsTest = 0[\s\S]*NOT EXISTS/);
      expect(params).toEqual(expect.arrayContaining([expect.objectContaining({ name: "Event", value: "attendance" }), expect.objectContaining({ name: "JobId", value: 5 })]));
      delete process.env[env];
    }
  });

  it("does nothing for a transition that tells the tenant nothing", async () => {
    process.env.TENANT_NOTICES_ENABLED = "true";
    expect(await enqueueTenantNotice(conn, 5, state("New"), state("Quote"))).toBe(false);
    expect(query).not.toHaveBeenCalled();
  });

  it("never throws: a failing insert (migration 186 not applied) must not stop the job moving", async () => {
    process.env.TENANT_NOTICES_ENABLED = "true";
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
    query.mockRejectedValueOnce(new Error("Invalid object name 'dbo.TenantNotices'."));
    await expect(enqueueTenantNotice(conn, 5, state("Work"), state("Done", "accounts"))).resolves.toBe(false);
  });
});
