/// <reference types="jest" />
import type { Connection } from "tedious";
import { TYPES } from "tedious";
import { jobAdapter, jobLabel } from "./job";
import { latestEmailArrivals, loadJobFacts, loadLiveJobFacts } from "./jobFacts";
import { getAdapter, registerAdapter, registeredSubjectTypes, requireAdapter, unregisterAdapter, type EscalationAdapter } from "./registry";
import { countExhaustedNotifications, SYSTEM_SUBJECTS, systemAdapter } from "./system";
import "./index";

jest.mock("../../db", () => ({ executeQuery: jest.fn() }));
const db = require("../../db") as { executeQuery: jest.Mock };

const conn = {} as Connection;
const NOW = new Date("2026-10-13T02:00:00Z");
const DAY = 86_400_000;

type Call = [unknown, string, { name: string; type: unknown; value: unknown }[] | undefined];
const lastCall = (): Call => db.executeQuery.mock.calls[db.executeQuery.mock.calls.length - 1] as Call;

function jobRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    AcknowledgedAt: null,
    AssignedTo: "Fay",
    AssignedToUserID: 8,
    BuildingID: 5,
    BuildingName: "Tower A",
    CreatedAt: new Date(NOW.getTime() - 40 * DAY),
    ExpectedProgressUpdate: null,
    FirstQuoteRequestAt: null,
    IsArchived: false,
    JobID: 12,
    OldestPendingInvoiceAt: null,
    PendingInvoices: 0,
    Priority: "Normal",
    QuoteCount: 0,
    RequestedContractors: 0,
    Status: "Work",
    StatusSince: new Date(NOW.getTime() - 20 * DAY),
    Title: "Leaking roof",
    ...over,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  db.executeQuery.mockReset();
});

describe("the registry", () => {
  const fake: EscalationAdapter = {
    deepLink: (id) => `/things/${id}`,
    isConditionActive: async () => true,
    loadSummary: async () => null,
    subjectType: "thing",
    visibleTo: () => true,
  };

  afterEach(() => unregisterAdapter("thing"));

  it("ships with the job and system adapters registered", () => {
    expect(registeredSubjectTypes()).toEqual(expect.arrayContaining(["job", "system"]));
    expect(getAdapter("job")).toBe(jobAdapter);
    expect(getAdapter("system")).toBe(systemAdapter);
  });

  it("lets other packages register theirs", () => {
    expect(getAdapter("thing")).toBeNull();
    registerAdapter(fake);
    expect(getAdapter("thing")).toBe(fake);
    expect(requireAdapter("thing").deepLink("7")).toBe("/things/7");
    unregisterAdapter("thing");
    expect(getAdapter("thing")).toBeNull();
  });

  it("refuses an unknown subject type with a 422", () => {
    expect(() => requireAdapter("mystery")).toThrow(expect.objectContaining({ code: "unknown_subject_type", status: 422 }));
  });
});

describe("the job adapter", () => {
  it("links to /jobs?jobId=", () => {
    expect(jobAdapter.deepLink("12")).toBe("/jobs?jobId=12");
    expect(jobAdapter.deepLink("1&x=2")).toBe("/jobs?jobId=1%26x%3D2");
  });

  it("scopes ledger rows to the job", () => {
    expect(jobAdapter.ledgerScope?.({ context: null, subjectId: "12" })).toEqual({ jobId: 12 });
    expect(jobAdapter.ledgerScope?.({ context: null, subjectId: "abc" })).toEqual({ jobId: null });
  });

  it("names the job, its title and its building", async () => {
    db.executeQuery.mockResolvedValueOnce([jobRow()]);

    const summary = await jobAdapter.loadSummary(conn, "12");

    expect(summary).toEqual({
      buildingId: 5,
      context: { assignedTo: "Fay", buildingName: "Tower A", jobId: 12, priority: "Normal", status: "Work", title: "Leaking roof" },
      summary: "Job #12 · Leaking roof · Tower A",
    });
    expect(lastCall()[2]).toEqual([{ name: "JobID", type: TYPES.Int, value: 12 }]);
  });

  it("finds no summary for a job that doesn't exist or an id that isn't one", async () => {
    db.executeQuery.mockResolvedValueOnce([]);
    expect(await jobAdapter.loadSummary(conn, "404")).toBeNull();
    for (const bad of ["abc", "0", "-3", "1.5", ""]) expect(await jobAdapter.loadSummary(conn, bad)).toBeNull();
    expect(db.executeQuery).toHaveBeenCalledTimes(1);
  });

  it("shortens a very long name", () => {
    expect(jobLabel({ buildingName: "B", jobId: 1, title: "t".repeat(500) })).toHaveLength(160);
    expect(jobLabel({ buildingName: null, jobId: 3, title: "  " })).toBe("Job #3");
  });

  it("asks the shared rules whether a job's condition still holds", async () => {
    const ref = (policyKey: string, subjectId = "12") => ({ policyKey, subjectId, subjectType: "job" });

    db.executeQuery.mockResolvedValueOnce([jobRow()]); // stalled for 20 days (Normal: 7)
    expect(await jobAdapter.isConditionActive(conn, ref("job.stalled_unacknowledged"), NOW)).toBe(true);

    db.executeQuery.mockResolvedValueOnce([jobRow({ AcknowledgedAt: new Date(NOW.getTime() - 1000) })]);
    expect(await jobAdapter.isConditionActive(conn, ref("job.stalled_unacknowledged"), NOW)).toBe(false);

    db.executeQuery.mockResolvedValueOnce([jobRow({ Status: "Done" })]);
    expect(await jobAdapter.isConditionActive(conn, ref("job.manual"), NOW)).toBe(false);

    db.executeQuery.mockResolvedValueOnce([jobRow({ AssignedTo: null, AssignedToUserID: null })]);
    expect(await jobAdapter.isConditionActive(conn, ref("job.unassigned"), NOW)).toBe(true);

    db.executeQuery.mockResolvedValueOnce([]);
    expect(await jobAdapter.isConditionActive(conn, ref("job.manual"), NOW)).toBe(false);

    expect(await jobAdapter.isConditionActive(conn, ref("job.manual", "abc"), NOW)).toBe(false);
  });

  describe("keeping Jobs.EscalatedAt in step (the dashboard flag)", () => {
    it("sets it while any escalation on the job is open, and clears it when none is", async () => {
      db.executeQuery.mockResolvedValueOnce([]);

      await jobAdapter.onChange?.(conn, { subjectId: "12" } as never);

      const [, sql, params] = lastCall();
      expect(sql).toContain("UPDATE dbo.Jobs");
      expect(sql).toContain("WHEN EXISTS (SELECT 1 FROM dbo.Escalations e");
      expect(sql).toContain("e.Status = 'open'");
      expect(sql).toContain("THEN COALESCE(EscalatedAt, SYSUTCDATETIME())");
      expect(sql).toContain("ELSE NULL");
      expect(params).toEqual([
        { name: "JobID", type: TYPES.Int, value: 12 },
        { name: "SubjectId", type: TYPES.NVarChar, value: "12" },
      ]);
    });

    it("leaves acknowledged escalations out of the flag: acknowledging clears it", async () => {
      db.executeQuery.mockResolvedValueOnce([]);
      await jobAdapter.onChange?.(conn, { subjectId: "12" } as never);
      expect(lastCall()[1]).not.toContain("acknowledged");
    });

    it("does nothing for a subject id that isn't a job", async () => {
      await jobAdapter.onChange?.(conn, { subjectId: "abc" } as never);
      expect(db.executeQuery).not.toHaveBeenCalled();
    });
  });

  it("shows escalations about jobs to whoever may read jobs", () => {
    const viewer = (...roles: string[]) => ({ name: "x", roles, userId: 1 });
    const ref = { policyKey: "job.manual", subjectId: "12", subjectType: "job" };
    for (const role of ["facilities", "facilities_manager", "accounts", "accounts_manager", "cfo", "director", "admin"]) {
      expect(jobAdapter.visibleTo(viewer(role), ref)).toBe(true);
    }
    expect(jobAdapter.visibleTo(viewer("user"), ref)).toBe(false);
    expect(jobAdapter.visibleTo(viewer(), ref)).toBe(false);
    expect(jobAdapter.visibleTo(viewer("Facilities_Manager "), ref)).toBe(true);
  });
});

describe("job facts", () => {
  it("loads live jobs with the quote, invoice and request facts the rules need", async () => {
    db.executeQuery.mockResolvedValueOnce([jobRow()]);

    const jobs = await loadLiveJobFacts(conn);

    const sql = lastCall()[1];
    expect(sql).toContain("WHERE j.IsArchived = 0 AND j.Status <> 'Done'");
    expect(sql).toContain("FROM dbo.JobRequestedContractors rc");
    expect(sql).toContain("FROM dbo.Quotes q");
    expect(sql).toContain("ji.Direction = 'incoming' AND ji.Status = 'pending'");
    expect(sql).not.toContain("SELECT *");
    expect(jobs[0]).toMatchObject({ assigned: true, buildingName: "Tower A", jobId: 12, pendingInvoices: 0, priority: "Normal", requestedContractors: 0 });
  });

  it("loads one job whether or not it is live", async () => {
    db.executeQuery.mockResolvedValueOnce([jobRow({ IsArchived: true })]).mockResolvedValueOnce([]);

    expect((await loadJobFacts(conn, 12))?.isArchived).toBe(true);
    expect(lastCall()[1]).toContain("WHERE j.JobID = @JobID");
    expect(lastCall()[1]).not.toContain("IsArchived = 0");
    expect(await loadJobFacts(conn, 99)).toBeNull();
  });

  it("finds when the newest email linked to each job arrived, ignoring archived mail", async () => {
    const at = new Date("2026-10-12T00:00:00Z");
    db.executeQuery.mockResolvedValueOnce([{ JobID: 3, LatestAt: at }, { JobID: 4, LatestAt: null }]);

    const map = await latestEmailArrivals(conn, [3, 4, 5]);

    expect([...map]).toEqual([[3, at]]);
    const [, sql, params] = lastCall();
    expect(sql).toContain("e.MatchedJobID IN (@J0, @J1, @J2)");
    expect(sql).toContain("e.Status <> 'archived'");
    expect(sql).toContain("MAX(e.CreatedAt)");
    expect(params?.map((p) => p.value)).toEqual([3, 4, 5]);
  });

  it("asks in chunks, and not at all for no jobs", async () => {
    db.executeQuery.mockResolvedValue([]);
    await latestEmailArrivals(conn, []);
    expect(db.executeQuery).not.toHaveBeenCalled();

    await latestEmailArrivals(conn, Array.from({ length: 1100 }, (_, i) => i + 1));
    expect(db.executeQuery).toHaveBeenCalledTimes(3);
    expect(db.executeQuery.mock.calls.map((c) => c[2].length)).toEqual([500, 500, 100]);
  });
});

describe("the system adapter", () => {
  const original = { ...process.env };
  afterEach(() => {
    process.env = { ...original };
  });

  it("describes the three system problems and no others", async () => {
    expect((await systemAdapter.loadSummary(conn, SYSTEM_SUBJECTS.notificationConfig))?.summary).toMatch(/can't be sent/);
    expect((await systemAdapter.loadSummary(conn, SYSTEM_SUBJECTS.notifications))?.summary).toMatch(/keep failing/);
    expect((await systemAdapter.loadSummary(conn, SYSTEM_SUBJECTS.sweep))?.summary).toMatch(/sweep/);
    expect(await systemAdapter.loadSummary(conn, "other")).toBeNull();
  });

  it("clears the settings problem once the settings are there", async () => {
    const ref = { policyKey: "system.health", subjectId: SYSTEM_SUBJECTS.notificationConfig, subjectType: "system" };
    for (const name of ["APP_BASE_URL", "GRAPH_SENDER_EMAIL", "GRAPH_TENANT_ID", "GRAPH_CLIENT_ID", "GRAPH_CLIENT_SECRET"]) delete process.env[name];
    expect(await systemAdapter.isConditionActive(conn, ref, NOW)).toBe(true);

    Object.assign(process.env, {
      APP_BASE_URL: "https://x",
      GRAPH_CLIENT_ID: "a",
      GRAPH_CLIENT_SECRET: "b",
      GRAPH_SENDER_EMAIL: "f@x",
      GRAPH_TENANT_ID: "c",
    });
    expect(await systemAdapter.isConditionActive(conn, ref, NOW)).toBe(false);
  });

  it("clears the failing-emails problem when no send has run out of attempts", async () => {
    const ref = { policyKey: "system.health", subjectId: SYSTEM_SUBJECTS.notifications, subjectType: "system" };
    db.executeQuery.mockResolvedValueOnce([{ Total: 2 }]).mockResolvedValueOnce([{ Total: 0 }]);
    expect(await systemAdapter.isConditionActive(conn, ref, NOW)).toBe(true);
    expect(await systemAdapter.isConditionActive(conn, ref, NOW)).toBe(false);
    expect(lastCall()[1]).toContain("NotificationState = 'failed' AND NotificationAttempts >= @MaxAttempts");
  });

  it("leaves the sweep problem for the next clean run to end", async () => {
    expect(await systemAdapter.isConditionActive(conn, { policyKey: "system.health", subjectId: SYSTEM_SUBJECTS.sweep, subjectType: "system" }, NOW)).toBe(true);
  });

  it("counts failed notifications that ran out of attempts", async () => {
    db.executeQuery.mockResolvedValueOnce([{ Total: 4 }]);
    expect(await countExhaustedNotifications(conn, 6)).toBe(4);
    expect(lastCall()[2]).toEqual([{ name: "MaxAttempts", type: TYPES.Int, value: 6 }]);
  });

  it("is for directors and admin, and opens the inbox", () => {
    const ref = { policyKey: "system.health", subjectId: "sweep", subjectType: "system" };
    const viewer = (...roles: string[]) => ({ name: "x", roles, userId: 1 });
    expect(systemAdapter.visibleTo(viewer("admin"), ref)).toBe(true);
    expect(systemAdapter.visibleTo(viewer("director"), ref)).toBe(true);
    expect(systemAdapter.visibleTo(viewer("facilities_manager"), ref)).toBe(false);
    expect(systemAdapter.deepLink("sweep")).toBe("/escalations");
  });
});
