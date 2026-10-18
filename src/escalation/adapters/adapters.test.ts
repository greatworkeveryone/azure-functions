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

  describe("links open the step the escalation is about (J6)", () => {
    const ref = (policyKey: string, context: Record<string, unknown> | null = null) => ({ context, policyKey });

    it.each([
      ["job.invoice_waiting", "/jobs?jobId=12&step=invoices"],
      ["job.quote_not_back", "/jobs?jobId=12&step=quotes"],
      ["job.stalled_unacknowledged", "/jobs?jobId=12"],
      ["job.unassigned", "/jobs?jobId=12"],
      ["job.past_due", "/jobs?jobId=12"],
      ["job.critical", "/jobs?jobId=12"],
      ["job.manual", "/jobs?jobId=12"],
    ])("%s → %s", (policyKey, path) => {
      expect(jobAdapter.deepLink("12", ref(policyKey))).toBe(path);
    });

    it("a decision request opens the decision, naming the request", () => {
      const context = { decision: { assignmentMode: "role", question: "Replace or repair?", requestId: 77, tier: "routine" } };
      expect(jobAdapter.deepLink("12", ref("job.decision_pending", context))).toBe("/jobs?jobId=12&step=decision&decisionRequestId=77#decision");
    });

    it("a next step opens the decision that handed it on", () => {
      const context = { nextStep: { decisionId: 5, nextStep: "Book the plumber", requestId: 77 } };
      expect(jobAdapter.deepLink("12", ref("job.next_step", context))).toBe("/jobs?jobId=12&step=decision&decisionRequestId=77#decision");
    });

    it("still opens the decision step when the context is not what a request writes", () => {
      expect(jobAdapter.deepLink("12", ref("job.decision_pending"))).toBe("/jobs?jobId=12&step=decision#decision");
    });
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

  it("treats an Admin / Accounts job as outside the contractor-flow policies, and a facilities job with the same facts as inside", async () => {
    const ref = (policyKey: string) => ({ policyKey, subjectId: "12", subjectType: "job" });
    const quoteFacts = { FirstQuoteRequestAt: new Date(NOW.getTime() - 20 * DAY), RequestedContractors: 1, Status: "Quote" };
    const invoiceFacts = { OldestPendingInvoiceAt: new Date(NOW.getTime() - 20 * DAY), PendingInvoices: 1 };

    for (const [policyKey, facts] of [["job.quote_not_back", quoteFacts], ["job.invoice_waiting", invoiceFacts]] as const) {
      db.executeQuery.mockResolvedValueOnce([jobRow({ ...facts, Kind: "facilities" })]);
      expect(await jobAdapter.isConditionActive(conn, ref(policyKey), NOW)).toBe(true);

      db.executeQuery.mockResolvedValueOnce([jobRow({ ...facts, Kind: "admin" })]);
      expect(await jobAdapter.isConditionActive(conn, ref(policyKey), NOW)).toBe(false);
    }

    db.executeQuery.mockResolvedValueOnce([jobRow({ Kind: "admin" })]);
    expect(await jobAdapter.isConditionActive(conn, ref("job.manual"), NOW)).toBe(true);
  });

  describe("a next step (job.next_step, jobs plan A2)", () => {
    const ref = (subjectId = "12") => ({ policyKey: "job.next_step", subjectId, subjectType: "job" });

    it("holds while the job is live and a decision on it has handed on a step that is not closed", async () => {
      db.executeQuery.mockResolvedValueOnce([{ IsOpen: 1 }]);

      expect(await jobAdapter.isConditionActive(conn, ref(), NOW)).toBe(true);

      const [, sql, params] = lastCall();
      expect(sql).toContain("FROM dbo.JobDecisions d");
      expect(sql).toContain("d.NextStep IS NOT NULL AND d.NextStepClosedAt IS NULL");
      expect(sql).toContain("j.IsArchived = 0 AND j.Status <> N'Done'");
      expect(params).toEqual([{ name: "JobID", type: TYPES.Int, value: 12 }]);
    });

    it("no longer holds once the step is closed, or the job is archived or done", async () => {
      db.executeQuery.mockResolvedValueOnce([{ IsOpen: 0 }]);
      expect(await jobAdapter.isConditionActive(conn, ref(), NOW)).toBe(false);
      db.executeQuery.mockResolvedValueOnce([]);
      expect(await jobAdapter.isConditionActive(conn, ref(), NOW)).toBe(false);
    });

    it("is not asked of the job's own facts: one query, about the decisions, not the job", async () => {
      db.executeQuery.mockResolvedValueOnce([{ IsOpen: 1 }]);
      await jobAdapter.isConditionActive(conn, ref(), NOW);
      expect(db.executeQuery).toHaveBeenCalledTimes(1);
      expect(lastCall()[1]).not.toContain("dbo.JobInvoices");
    });

    it("never holds for a subject that isn't a job", async () => {
      expect(await jobAdapter.isConditionActive(conn, ref("abc"), NOW)).toBe(false);
      expect(db.executeQuery).not.toHaveBeenCalled();
    });
  });

  describe("keeping Jobs.EscalatedAt in step (the dashboard flag)", () => {
    it("sets it while any escalation on the job is open, and clears it when none is", async () => {
      db.executeQuery.mockResolvedValueOnce([]);

      await jobAdapter.onChange?.(conn, { subjectId: "12" } as never);

      const [, sql, params] = lastCall();
      expect(sql).toContain("UPDATE dbo.Jobs");
      expect(sql).toContain("WHEN EXISTS (SELECT 1 FROM dbo.Escalations e");
      expect(sql).toContain("e.Status = 'open'");
      expect(sql).toContain("THEN COALESCE(EscalatedAt,");
      expect(sql).toContain("ELSE NULL");
      expect(params).toEqual([
        { name: "JobID", type: TYPES.Int, value: 12 },
        { name: "SubjectId", type: TYPES.NVarChar, value: "12" },
        { name: "DecisionPolicy", type: TYPES.NVarChar, value: "job.decision_pending" },
        { name: "NextStepPolicy", type: TYPES.NVarChar, value: "job.next_step" },
      ]);
    });

    it("stamps only with a delivery on record (J6): the time the first email about an open escalation went, never 'now'", async () => {
      db.executeQuery.mockResolvedValueOnce([]);

      await jobAdapter.onChange?.(conn, { subjectId: "12" } as never);

      const sql = lastCall()[1] as string;
      expect(sql).toContain("SELECT MIN(d.LastNotifiedAt) FROM dbo.Escalations d");
      expect(sql).toContain("d.LastNotifiedAt IS NOT NULL");
      expect(sql).toContain("d.Status = 'open'");
      expect(sql).toContain("(d.PolicyKey NOT IN (@DecisionPolicy, @NextStepPolicy) OR d.ParentEscalationId IS NOT NULL)");
      expect(sql).not.toContain("SYSUTCDATETIME()");
    });

    it("does not count a decision request that has only been asked, nor a next step that has only been handed on: either flags the job once it has moved up", async () => {
      db.executeQuery.mockResolvedValueOnce([]);

      await jobAdapter.onChange?.(conn, { subjectId: "12" } as never);

      const sql = lastCall()[1] as string;
      expect(sql).toContain("(e.PolicyKey NOT IN (@DecisionPolicy, @NextStepPolicy) OR e.ParentEscalationId IS NOT NULL)");
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

  it("reads each job's kind, and a job with none as facilities", async () => {
    db.executeQuery.mockResolvedValueOnce([jobRow({ JobID: 1, Kind: "admin" }), jobRow({ JobID: 2, Kind: "maintenance" }), jobRow({ JobID: 3 })]);

    const jobs = await loadLiveJobFacts(conn);

    expect(lastCall()[1]).toContain("j.Kind");
    expect(jobs.map((job) => job.kind)).toEqual(["admin", "maintenance", "facilities"]);
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
