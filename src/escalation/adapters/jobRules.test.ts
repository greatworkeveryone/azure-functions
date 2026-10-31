/// <reference types="jest" />
import { NO_HOLIDAYS, parseHolidays } from "../businessTime";
import { toJobFacts } from "./jobFacts";
import {
  conditionEpoch,
  INVOICE_WAIT_DAYS,
  isCriticalJob,
  isInvoiceWaiting,
  isLiveJob,
  isPastDue,
  isQuoteNotBack,
  isStalled,
  isUnassigned,
  jobConditionActive,
  jobHeadline,
  policyAppliesToKind,
  POLICY_JOB_KINDS,
  quoteWaitDays,
  stallClockStart,
  SWEEP_JOB_POLICIES,
  type JobFacts,
} from "./jobRules";

// 2026-10-12 is a Monday. Times are Darwin wall clock (UTC+9:30).
function darwin(text: string): Date {
  const [date, time = "00:00"] = text.split(" ");
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  return new Date(Date.UTC(y, mo - 1, d, h, mi) - 9.5 * 3_600_000);
}

const DAY = 86_400_000;

function job(overrides: Partial<JobFacts> = {}): JobFacts {
  return {
    acknowledgedAt: null,
    assigned: true,
    assignedTo: "Fay",
    buildingId: 5,
    buildingName: "Tower A",
    createdAt: darwin("2026-09-01 09:00"),
    expectedProgressUpdate: null,
    firstQuoteRequestAt: null,
    isArchived: false,
    jobId: 12,
    kind: "facilities",
    oldestPendingInvoiceAt: null,
    pendingInvoices: 0,
    priority: "Normal",
    quoteCount: 0,
    requestedContractors: 0,
    status: "Work",
    statusSince: darwin("2026-10-01 09:00"),
    title: "Leaking roof",
    ...overrides,
  };
}

const ENV = {} as NodeJS.ProcessEnv;

describe("live jobs", () => {
  it("are not archived and not Done", () => {
    expect(isLiveJob(job())).toBe(true);
    expect(isLiveJob(job({ status: "Done" }))).toBe(false);
    expect(isLiveJob(job({ isArchived: true }))).toBe(false);
    expect(isLiveJob(job({ status: "Tenant" }))).toBe(true);
  });
});

describe("stalled and unacknowledged (the WP18a thresholds)", () => {
  const now = darwin("2026-10-13 12:00");

  it("starts the clock at the acknowledgement, else the last status change, else creation", () => {
    expect(stallClockStart(job({ acknowledgedAt: darwin("2026-10-05 10:00") }))).toEqual(darwin("2026-10-05 10:00"));
    expect(stallClockStart(job())).toEqual(darwin("2026-10-01 09:00"));
    expect(stallClockStart(job({ statusSince: null }))).toEqual(darwin("2026-09-01 09:00"));
  });

  it.each([
    ["Critical", 2],
    ["High", 4],
    ["Normal", 7],
    ["Low", 14],
    [null, 7],
  ])("escalates a %s job once it is more than %i days old", (priority, days) => {
    const since = new Date(now.getTime() - (days * DAY + 60_000));
    const fresh = new Date(now.getTime() - (days * DAY - 60_000));
    expect(isStalled(job({ priority, statusSince: since }), now, ENV)).toBe(true);
    expect(isStalled(job({ priority, statusSince: fresh }), now, ENV)).toBe(false);
  });

  it("reads the per-priority days from the environment", () => {
    const since = new Date(now.getTime() - 3 * DAY);
    expect(isStalled(job({ priority: "Normal", statusSince: since }), now, ENV)).toBe(false);
    expect(isStalled(job({ priority: "Normal", statusSince: since }), now, { ESCALATION_THRESHOLD_DAYS_NORMAL: "2" } as NodeJS.ProcessEnv)).toBe(true);
  });

  it("restarts when the job is acknowledged", () => {
    const old = job({ priority: "Critical", statusSince: darwin("2026-09-20 09:00") });
    expect(isStalled(old, now, ENV)).toBe(true);
    expect(isStalled({ ...old, acknowledgedAt: darwin("2026-10-13 09:00") }, now, ENV)).toBe(false);
  });

  it("applies to assigned jobs still moving: New, Quote, Work and Awaiting Approval", () => {
    for (const status of ["New", "Quote", "Work", "Awaiting Approval"]) {
      expect(isStalled(job({ priority: "Critical", status, statusSince: darwin("2026-09-20 09:00") }), now, ENV)).toBe(true);
    }
    for (const status of ["Tenant", "Done"]) {
      expect(isStalled(job({ priority: "Critical", status, statusSince: darwin("2026-09-20 09:00") }), now, ENV)).toBe(false);
    }
  });

  it("leaves unassigned jobs to job.unassigned", () => {
    expect(isStalled(job({ assigned: false, priority: "Critical", statusSince: darwin("2026-09-20 09:00") }), now, ENV)).toBe(false);
  });
});

describe("unassigned: a live job with no assignee past one business day", () => {
  it("waits one business day (8 business hours) from creation", () => {
    const created = darwin("2026-10-12 09:00"); // Monday
    const unassigned = job({ assigned: false, createdAt: created });
    expect(isUnassigned(unassigned, darwin("2026-10-13 08:59"), NO_HOLIDAYS)).toBe(false);
    expect(isUnassigned(unassigned, darwin("2026-10-13 09:00"), NO_HOLIDAYS)).toBe(true);
  });

  it("counts business time only: Friday afternoon's job isn't overdue on Saturday morning", () => {
    const friday = job({ assigned: false, createdAt: darwin("2026-10-16 15:00") });
    expect(isUnassigned(friday, darwin("2026-10-17 09:00"), NO_HOLIDAYS)).toBe(false);
    expect(isUnassigned(friday, darwin("2026-10-19 14:59"), NO_HOLIDAYS)).toBe(false);
    expect(isUnassigned(friday, darwin("2026-10-19 15:00"), NO_HOLIDAYS)).toBe(true);
  });

  it("skips public holidays", () => {
    // Created Monday 16:00: 30 minutes left that day, the other 7.5h land on Tuesday 16:00 ...
    const monday = job({ assigned: false, createdAt: darwin("2026-10-12 16:00") });
    const tuesdayOff = parseHolidays("2026-10-13").holidays;
    expect(isUnassigned(monday, darwin("2026-10-13 16:00"), NO_HOLIDAYS)).toBe(true);
    // ... unless Tuesday is a holiday, which pushes it to Wednesday 16:00.
    expect(isUnassigned(monday, darwin("2026-10-13 16:00"), tuesdayOff)).toBe(false);
    expect(isUnassigned(monday, darwin("2026-10-14 15:59"), tuesdayOff)).toBe(false);
    expect(isUnassigned(monday, darwin("2026-10-14 16:00"), tuesdayOff)).toBe(true);
  });

  it("is not for assigned, archived or finished jobs", () => {
    const old = darwin("2026-09-01 09:00");
    const now = darwin("2026-10-13 12:00");
    expect(isUnassigned(job({ assigned: true, createdAt: old }), now, NO_HOLIDAYS)).toBe(false);
    expect(isUnassigned(job({ assigned: false, createdAt: old, isArchived: true }), now, NO_HOLIDAYS)).toBe(false);
    expect(isUnassigned(job({ assigned: false, createdAt: old, status: "Done" }), now, NO_HOLIDAYS)).toBe(false);
  });

  it("counts a job assigned only by name as assigned (legacy rows)", () => {
    const base = { AssignedTo: "Fay", AssignedToUserID: null, BuildingID: 1, CreatedAt: darwin("2026-09-01 09:00"), IsArchived: false, JobID: 7, Status: "Work", Title: "t" };
    expect(toJobFacts(base).assigned).toBe(true);
    expect(toJobFacts({ ...base, AssignedTo: "  " }).assigned).toBe(false);
    expect(toJobFacts({ ...base, AssignedTo: null, AssignedToUserID: 3 }).assigned).toBe(true);
    expect(toJobFacts({ ...base, AssignedTo: null }).assigned).toBe(false);
  });
});

describe("quote not back", () => {
  const requested = job({ firstQuoteRequestAt: darwin("2026-10-12 09:00"), requestedContractors: 1, status: "Quote" }); // Mon 09:00

  it("waits 3 business days (24 business hours) after the first request", () => {
    // 24h from Mon 09:00: Mon 7.5h, Tue 8h, Wed 8h -> 23.5h, then 0.5h of Thursday -> Thu 09:00
    expect(isQuoteNotBack(requested, darwin("2026-10-15 08:59"), NO_HOLIDAYS)).toBe(false);
    expect(isQuoteNotBack(requested, darwin("2026-10-15 09:00"), NO_HOLIDAYS)).toBe(true);
  });

  it("waits 1 business day for Critical and High", () => {
    expect(quoteWaitDays({ priority: "Critical" })).toBe(1);
    expect(quoteWaitDays({ priority: "High" })).toBe(1);
    expect(quoteWaitDays({ priority: "Normal" })).toBe(3);
    expect(quoteWaitDays({ priority: null })).toBe(3);
    const urgent = { ...requested, priority: "High" };
    expect(isQuoteNotBack(urgent, darwin("2026-10-13 08:59"), NO_HOLIDAYS)).toBe(false);
    expect(isQuoteNotBack(urgent, darwin("2026-10-13 09:00"), NO_HOLIDAYS)).toBe(true);
  });

  it("clears the moment a quote is received", () => {
    const late = darwin("2026-10-20 12:00");
    expect(isQuoteNotBack(requested, late, NO_HOLIDAYS)).toBe(true);
    expect(isQuoteNotBack({ ...requested, quoteCount: 1 }, late, NO_HOLIDAYS)).toBe(false);
  });

  it("needs a quote to have been requested, and a job still waiting for one", () => {
    const late = darwin("2026-10-20 12:00");
    expect(isQuoteNotBack(job({ status: "Quote" }), late, NO_HOLIDAYS)).toBe(false);
    expect(isQuoteNotBack({ ...requested, requestedContractors: 0 }, late, NO_HOLIDAYS)).toBe(false);
    expect(isQuoteNotBack({ ...requested, status: "Work" }, late, NO_HOLIDAYS)).toBe(false);
    expect(isQuoteNotBack({ ...requested, status: "Awaiting Approval" }, late, NO_HOLIDAYS)).toBe(false);
    expect(isQuoteNotBack({ ...requested, status: "Done" }, late, NO_HOLIDAYS)).toBe(false);
    expect(isQuoteNotBack({ ...requested, status: "New" }, late, NO_HOLIDAYS)).toBe(true);
  });
});

describe("invoice waiting", () => {
  const waiting = job({ oldestPendingInvoiceAt: darwin("2026-10-12 09:00"), pendingInvoices: 1, status: "Awaiting Approval" });

  it("waits 5 business days (40 business hours) from when the invoice arrived", () => {
    expect(INVOICE_WAIT_DAYS).toBe(5);
    // 40h from Mon 09:00: Mon 7.5, Tue-Fri 8 each = 39.5, then 0.5h of the next Monday -> Mon 09:00
    expect(isInvoiceWaiting(waiting, darwin("2026-10-19 08:59"), NO_HOLIDAYS)).toBe(false);
    expect(isInvoiceWaiting(waiting, darwin("2026-10-19 09:00"), NO_HOLIDAYS)).toBe(true);
  });

  it("clears once the invoice is decided (no pending invoice)", () => {
    const late = darwin("2026-10-30 12:00");
    expect(isInvoiceWaiting(waiting, late, NO_HOLIDAYS)).toBe(true);
    expect(isInvoiceWaiting({ ...waiting, oldestPendingInvoiceAt: null, pendingInvoices: 0 }, late, NO_HOLIDAYS)).toBe(false);
  });
});

describe("past due uses the job's next-update date (there is no separate due date)", () => {
  it("is past due once the due day has ended in Darwin", () => {
    const due = job({ expectedProgressUpdate: new Date("2026-10-12T00:00:00Z") }); // Monday 12th
    expect(isPastDue(due, darwin("2026-10-12 23:59"))).toBe(false);
    expect(isPastDue(due, darwin("2026-10-13 00:00"))).toBe(true);
  });

  it("treats a due date saved as local midnight the same way", () => {
    const due = job({ expectedProgressUpdate: darwin("2026-10-12 00:00") });
    expect(isPastDue(due, darwin("2026-10-12 12:00"))).toBe(false);
    expect(isPastDue(due, darwin("2026-10-13 08:00"))).toBe(true);
  });

  it("needs a date, and a job that isn't done", () => {
    const now = darwin("2026-10-20 12:00");
    expect(isPastDue(job(), now)).toBe(false);
    expect(isPastDue(job({ expectedProgressUpdate: darwin("2026-10-01 00:00"), status: "Done" }), now)).toBe(false);
    expect(isPastDue(job({ expectedProgressUpdate: darwin("2026-10-01 00:00"), isArchived: true }), now)).toBe(false);
  });

  it("clears when someone posts a new update date", () => {
    const now = darwin("2026-10-20 12:00");
    expect(isPastDue(job({ expectedProgressUpdate: darwin("2026-10-01 00:00") }), now)).toBe(true);
    expect(isPastDue(job({ expectedProgressUpdate: darwin("2026-10-27 00:00") }), now)).toBe(false);
  });
});

describe("jobConditionActive", () => {
  const rule = { env: ENV, holidays: NO_HOLIDAYS, now: darwin("2026-10-20 12:00") };

  it("dispatches to each policy's rule", () => {
    expect(jobConditionActive("job.past_due", job({ expectedProgressUpdate: darwin("2026-10-01 00:00") }), rule)).toBe(true);
    expect(jobConditionActive("job.unassigned", job({ assigned: false }), rule)).toBe(true);
    expect(jobConditionActive("job.invoice_waiting", job({ oldestPendingInvoiceAt: darwin("2026-10-01 09:00"), pendingInvoices: 1 }), rule)).toBe(true);
    expect(jobConditionActive("job.quote_not_back", job({ firstQuoteRequestAt: darwin("2026-10-01 09:00"), requestedContractors: 1, status: "Quote" }), rule)).toBe(true);
    expect(jobConditionActive("job.stalled_unacknowledged", job({ statusSince: darwin("2026-09-01 09:00") }), rule)).toBe(true);
  });

  it("keeps job.critical while the job is Critical and live", () => {
    expect(jobConditionActive("job.critical", job({ priority: "Critical" }), rule)).toBe(true);
    expect(jobConditionActive("job.critical", job({ priority: "High" }), rule)).toBe(false);
    expect(jobConditionActive("job.critical", job({ priority: "Critical", status: "Done" }), rule)).toBe(false);
    expect(isCriticalJob(job({ priority: "Critical" }))).toBe(true);
  });

  it("keeps manual escalations while the job is live", () => {
    expect(jobConditionActive("job.manual", job(), rule)).toBe(true);
    expect(jobConditionActive("any.manual", job(), rule)).toBe(true);
    expect(jobConditionActive("job.manual", job({ status: "Done" }), rule)).toBe(false);
  });

  it("knows nothing about other policies", () => {
    expect(jobConditionActive("rent_review.overdue", job(), rule)).toBe(false);
  });

  it("covers the five sweep policies", () => {
    expect([...SWEEP_JOB_POLICIES]).toEqual([
      "job.stalled_unacknowledged",
      "job.unassigned",
      "job.quote_not_back",
      "job.invoice_waiting",
      "job.past_due",
    ]);
  });
});

describe("the job kinds each sweep policy applies to (plan D2)", () => {
  const rule = { env: ENV, holidays: NO_HOLIDAYS, now: darwin("2026-10-20 12:00") };
  const POLICIES = [...SWEEP_JOB_POLICIES];

  // A job that meets each policy's rule, before its kind is considered.
  const MEETS: Record<(typeof SWEEP_JOB_POLICIES)[number], Partial<JobFacts>> = {
    "job.stalled_unacknowledged": { statusSince: darwin("2026-09-01 09:00") },
    "job.unassigned": { assigned: false },
    "job.quote_not_back": { firstQuoteRequestAt: darwin("2026-10-01 09:00"), requestedContractors: 1, status: "Quote" },
    "job.invoice_waiting": { oldestPendingInvoiceAt: darwin("2026-10-01 09:00"), pendingInvoices: 1 },
    "job.past_due": { expectedProgressUpdate: darwin("2026-10-01 00:00") },
  };

  it.each(POLICIES)("%s applies to facilities and maintenance jobs", (policyKey) => {
    for (const kind of ["facilities", "maintenance"]) {
      expect(jobConditionActive(policyKey, job({ ...MEETS[policyKey], kind }), rule)).toBe(true);
    }
  });

  it.each(POLICIES)("%s never applies to an Admin / Accounts job, whatever else is true of it", (policyKey) => {
    expect(jobConditionActive(policyKey, job({ ...MEETS[policyKey], kind: "admin" }), rule)).toBe(false);
  });

  it.each(POLICIES)("%s lists its kinds by name, so a kind nobody listed gets nothing", (policyKey) => {
    expect(jobConditionActive(policyKey, job({ ...MEETS[policyKey], kind: "projects" }), rule)).toBe(false);
  });

  it("names the kinds of every sweep policy, and only those", () => {
    expect(Object.keys(POLICY_JOB_KINDS).sort()).toEqual([...SWEEP_JOB_POLICIES].sort());
    for (const policyKey of POLICIES) expect([...POLICY_JOB_KINDS[policyKey]]).toEqual(["facilities", "maintenance"]);
  });

  it("asks job.critical and the manual policies of every kind: the job save or a person raised those", () => {
    const admin = job({ kind: "admin", priority: "Critical" });
    expect(jobConditionActive("job.critical", admin, rule)).toBe(true);
    expect(jobConditionActive("job.manual", admin, rule)).toBe(true);
    expect(jobConditionActive("any.manual", admin, rule)).toBe(true);
    expect(policyAppliesToKind("job.critical", "admin")).toBe(true);
  });

  it("answers by policy name, and not for a name that only exists on Object", () => {
    expect(policyAppliesToKind("job.quote_not_back", "maintenance")).toBe(true);
    expect(policyAppliesToKind("job.quote_not_back", "admin")).toBe(false);
    expect(policyAppliesToKind("constructor", "admin")).toBe(true);
    expect(jobConditionActive("constructor", job({ kind: "admin" }), rule)).toBe(false);
  });

  it("reads the kind from the row, and a row without one as facilities", () => {
    const row = { AssignedTo: "Fay", AssignedToUserID: 3, BuildingID: 1, CreatedAt: darwin("2026-09-01 09:00"), IsArchived: false, JobID: 7, Status: "Work", Title: "t" };
    expect(toJobFacts({ ...row, Kind: "admin" }).kind).toBe("admin");
    expect(toJobFacts({ ...row, Kind: "maintenance" }).kind).toBe("maintenance");
    expect(toJobFacts(row).kind).toBe("facilities");
    expect(toJobFacts({ ...row, Kind: "  " }).kind).toBe("facilities");
  });
});

describe("conditionEpoch", () => {
  it("is the start of the window each condition is measured from", () => {
    const j = job({
      acknowledgedAt: darwin("2026-10-05 10:00"),
      expectedProgressUpdate: darwin("2026-10-08 00:00"),
      firstQuoteRequestAt: darwin("2026-10-02 09:00"),
      oldestPendingInvoiceAt: darwin("2026-10-03 09:00"),
    });
    expect(conditionEpoch("job.stalled_unacknowledged", j)).toEqual(darwin("2026-10-05 10:00"));
    expect(conditionEpoch("job.unassigned", j)).toEqual(j.createdAt);
    expect(conditionEpoch("job.quote_not_back", j)).toEqual(darwin("2026-10-02 09:00"));
    expect(conditionEpoch("job.invoice_waiting", j)).toEqual(darwin("2026-10-03 09:00"));
    expect(conditionEpoch("job.past_due", j)).toEqual(darwin("2026-10-08 00:00"));
  });
});

describe("jobHeadline", () => {
  const now = darwin("2026-10-13 12:00");

  it("says what is wrong in a sentence", () => {
    expect(jobHeadline("job.unassigned", job({ assigned: false }), now)).toBe("Needs an owner: no one is assigned");
    expect(jobHeadline("job.stalled_unacknowledged", job({ statusSince: new Date(now.getTime() - 9 * DAY) }), now)).toBe(
      "Stalled: no acknowledgement or update for 9 days",
    );
    expect(jobHeadline("job.quote_not_back", job({ priority: "High" }), now)).toBe("No quote back 1 business day after it was requested");
    expect(jobHeadline("job.quote_not_back", job(), now)).toBe("No quote back 3 business days after it was requested");
    expect(jobHeadline("job.invoice_waiting", job({ oldestPendingInvoiceAt: darwin("2026-10-02 09:00") }), now)).toBe("Invoice waiting for a decision since 02/10/2026");
    expect(jobHeadline("job.past_due", job({ expectedProgressUpdate: darwin("2026-10-08 00:00") }), now)).toBe("Past due: the next update was due 08/10/2026");
    expect(jobHeadline("job.critical", job(), now)).toMatch(/Critical/);
  });
});
