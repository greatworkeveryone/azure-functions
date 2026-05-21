import assert from "node:assert";
import {
  buildTaskTitle,
  buildTenantTaskDescription,
  buildJobTaskDescription,
  computeEventDate,
  formatDDMMYYYY,
  isInWindow,
  toIsoDateString,
  addDaysUTC,
  buildStalledJobTaskDescription,
  buildAwaitingAccountsTaskDescription,
  buildDirectorApprovalTaskDescription,
  type PlannerTenantRow,
  type PlannerJobRow,
  type PlannerStalledJobRow,
  type PlannerAccountsJobRow,
} from "../plannerHelpers";

const BASE_TENANT: PlannerTenantRow = {
  tenantId: 1,
  legalName: "Acme Corp",
  tradingName: null,
  buildingName: "Smith Tower",
  firstOccupancy: "L3 / Suite 3A",
  expiry: "2026-09-15",
  optionNoticeMonths: 3,
  nextReviewDate: "2026-07-01",
  reviewType: "CPI Darwin",
};

describe("formatDDMMYYYY", () => {
  test("converts YYYY-MM-DD to DD/MM/YYYY", () => {
    assert.strictEqual(formatDDMMYYYY("2026-09-15"), "15/09/2026");
  });

  test("handles first of month", () => {
    assert.strictEqual(formatDDMMYYYY("2026-01-01"), "01/01/2026");
  });
});

describe("computeEventDate", () => {
  test("lease_expiry returns the expiry date", () => {
    const d = computeEventDate(BASE_TENANT, "lease_expiry");
    assert.ok(d instanceof Date);
    assert.strictEqual(d.getUTCFullYear(), 2026);
    assert.strictEqual(d.getUTCMonth(), 8); // September = 8
    assert.strictEqual(d.getUTCDate(), 15);
  });

  test("option_notice subtracts optionNoticeMonths from expiry", () => {
    const d = computeEventDate(BASE_TENANT, "option_notice");
    assert.ok(d instanceof Date);
    // 2026-09-15 minus 3 months = 2026-06-15
    assert.strictEqual(d.getUTCMonth(), 5); // June = 5
    assert.strictEqual(d.getUTCDate(), 15);
  });

  test("option_notice returns null when optionNoticeMonths is null", () => {
    const t = { ...BASE_TENANT, optionNoticeMonths: null };
    assert.strictEqual(computeEventDate(t, "option_notice"), null);
  });

  test("option_notice returns null when expiry is null", () => {
    const t = { ...BASE_TENANT, expiry: null };
    assert.strictEqual(computeEventDate(t, "option_notice"), null);
  });

  test("rent_review returns nextReviewDate", () => {
    const d = computeEventDate(BASE_TENANT, "rent_review");
    assert.ok(d instanceof Date);
    assert.strictEqual(d.getUTCMonth(), 6); // July = 6
    assert.strictEqual(d.getUTCDate(), 1);
  });

  test("rent_review returns null when nextReviewDate is null", () => {
    const t = { ...BASE_TENANT, nextReviewDate: null };
    assert.strictEqual(computeEventDate(t, "rent_review"), null);
  });
});

describe("isInWindow", () => {
  const eventDate = new Date("2026-09-15T00:00:00Z");

  test("returns true on the event date", () => {
    assert.ok(isInWindow(new Date("2026-09-15T00:00:00Z"), eventDate, 90));
  });

  test("returns true 90 days before (2026-06-17)", () => {
    assert.ok(isInWindow(new Date("2026-06-17T00:00:00Z"), eventDate, 90));
  });

  test("returns false 91 days before", () => {
    assert.strictEqual(
      isInWindow(new Date("2026-06-16T00:00:00Z"), eventDate, 90),
      false,
    );
  });

  test("returns false the day after the event", () => {
    assert.strictEqual(
      isInWindow(new Date("2026-09-16T00:00:00Z"), eventDate, 90),
      false,
    );
  });

  test("30-day window: true at exactly 30 days", () => {
    // 30 days before 2026-09-15 = 2026-08-16
    assert.ok(isInWindow(new Date("2026-08-16T00:00:00Z"), eventDate, 30));
  });

  test("30-day window: false at 31 days", () => {
    assert.strictEqual(
      isInWindow(new Date("2026-08-15T00:00:00Z"), eventDate, 30),
      false,
    );
  });
});

describe("buildTaskTitle", () => {
  test("lease_expiry", () => {
    assert.strictEqual(
      buildTaskTitle("Acme Corp", "lease_expiry", 90),
      "Lease expiry — Acme Corp (90 days)",
    );
  });

  test("option_notice", () => {
    assert.strictEqual(
      buildTaskTitle("Acme Corp", "option_notice", 60),
      "Option deadline — Acme Corp (60 days)",
    );
  });

  test("rent_review", () => {
    assert.strictEqual(
      buildTaskTitle("Acme Corp", "rent_review", 30),
      "Rent review — Acme Corp (30 days)",
    );
  });

  test("job_update_due ignores leadTimeDays in title", () => {
    assert.strictEqual(
      buildTaskTitle("Job #42: Replace HVAC", "job_update_due", 0),
      "Update overdue — Job #42: Replace HVAC",
    );
  });
});

const STALLED_JOB: PlannerStalledJobRow = {
  jobId: 7,
  title: "Fix air con",
  buildingName: "Smith Tower",
  stalledAt: "2026-05-20T03:00:00.000Z",
  assignedToEntraOid: null,
};

const ACCOUNTS_JOB: PlannerAccountsJobRow = {
  jobId: 8,
  title: "Invoice ABC",
  buildingName: "Jones Building",
};

describe("buildStalledJobTaskDescription", () => {
  test("includes building name and link", () => {
    const desc = buildStalledJobTaskDescription(STALLED_JOB, "https://app.example.com");
    assert.ok(desc.includes("Smith Tower"));
    assert.ok(desc.includes("https://app.example.com/jobs/7"));
  });
});

describe("buildAwaitingAccountsTaskDescription", () => {
  test("includes building name and link", () => {
    const desc = buildAwaitingAccountsTaskDescription(ACCOUNTS_JOB, "https://app.example.com");
    assert.ok(desc.includes("Jones Building"));
    assert.ok(desc.includes("https://app.example.com/jobs/8"));
  });
});

describe("buildDirectorApprovalTaskDescription", () => {
  test("includes building name and link", () => {
    const desc = buildDirectorApprovalTaskDescription(ACCOUNTS_JOB, "https://app.example.com");
    assert.ok(desc.includes("Jones Building"));
    assert.ok(desc.includes("https://app.example.com/jobs/8"));
  });
});

describe("buildTaskTitle — remaining trigger types", () => {
  test("stalled_facilities", () => {
    assert.strictEqual(
      buildTaskTitle("Fix air con", "stalled_facilities", 0),
      "Job stalled — Fix air con",
    );
  });

  test("awaiting_accounts", () => {
    assert.strictEqual(
      buildTaskTitle("Replace roof", "awaiting_accounts", 0),
      "Awaiting accounts — Replace roof",
    );
  });

  test("director_approval", () => {
    assert.strictEqual(
      buildTaskTitle("Replace roof", "director_approval", 0),
      "Director approval needed — Replace roof",
    );
  });
});

describe("toIsoDateString", () => {
  test("formats a UTC date as YYYY-MM-DD", () => {
    assert.strictEqual(toIsoDateString(new Date("2026-09-15T00:00:00Z")), "2026-09-15");
  });

  test("zero-pads month and day", () => {
    assert.strictEqual(toIsoDateString(new Date("2026-01-05T00:00:00Z")), "2026-01-05");
  });
});

describe("addDaysUTC", () => {
  test("adds days correctly across month boundary", () => {
    const result = addDaysUTC(new Date("2026-01-30T00:00:00Z"), 3);
    assert.strictEqual(toIsoDateString(result), "2026-02-02");
  });

  test("adding 0 days returns the same date", () => {
    const d = new Date("2026-05-21T00:00:00Z");
    assert.strictEqual(toIsoDateString(addDaysUTC(d, 0)), "2026-05-21");
  });
});

describe("buildTenantTaskDescription", () => {
  const BASE_URL = "https://app.example.com";

  test("lease_expiry includes location, formatted expiry date, and tenant link", () => {
    const desc = buildTenantTaskDescription(BASE_TENANT, "lease_expiry", BASE_URL);
    assert.ok(desc.includes("Smith Tower"));
    assert.ok(desc.includes("L3 / Suite 3A"));
    assert.ok(desc.includes("15/09/2026"));
    assert.ok(desc.includes(`${BASE_URL}/tenancy/1`));
  });

  test("option_notice includes computed deadline and lease expiry", () => {
    const desc = buildTenantTaskDescription(BASE_TENANT, "option_notice", BASE_URL);
    // 2026-09-15 minus 3 months = 2026-06-15
    assert.ok(desc.includes("15/06/2026"), `expected 15/06/2026 in: ${desc}`);
    assert.ok(desc.includes("15/09/2026"));
    assert.ok(desc.includes(`${BASE_URL}/tenancy/1`));
  });

  test("rent_review includes review date and review type", () => {
    const desc = buildTenantTaskDescription(BASE_TENANT, "rent_review", BASE_URL);
    assert.ok(desc.includes("01/07/2026"));
    assert.ok(desc.includes("CPI Darwin"));
    assert.ok(desc.includes(`${BASE_URL}/tenancy/1`));
  });

  test("omits building prefix when buildingName is empty", () => {
    const t = { ...BASE_TENANT, buildingName: "", firstOccupancy: null };
    const desc = buildTenantTaskDescription(t, "lease_expiry", BASE_URL);
    assert.ok(!desc.startsWith("\n"));
    assert.ok(desc.includes(`${BASE_URL}/tenancy/1`));
  });

  test("uses tradingName over legalName in task title (via buildTaskTitle)", () => {
    // buildTenantTaskDescription doesn't include the name — just confirm description
    // still links to the correct tenant regardless of name
    const t = { ...BASE_TENANT, tradingName: "Acme Trading" };
    const desc = buildTenantTaskDescription(t, "lease_expiry", BASE_URL);
    assert.ok(desc.includes(`${BASE_URL}/tenancy/1`));
  });
});

describe("buildJobTaskDescription", () => {
  const BASE_URL = "https://app.example.com";

  const JOB: PlannerJobRow = {
    jobId: 42,
    title: "Replace HVAC",
    buildingName: "Smith Tower",
    expectedProgressUpdate: "2026-06-01T00:00:00.000Z",
  };

  test("includes building name, formatted due date, and jobs link", () => {
    const desc = buildJobTaskDescription(JOB, BASE_URL);
    assert.ok(desc.includes("Smith Tower"));
    assert.ok(desc.includes("01/06/2026"));
    assert.ok(desc.includes(`${BASE_URL}/jobs`));
  });

  test("shows — for missing expectedProgressUpdate", () => {
    const desc = buildJobTaskDescription({ ...JOB, expectedProgressUpdate: null }, BASE_URL);
    assert.ok(desc.includes("—"));
  });

  test("omits building prefix when buildingName is null", () => {
    const desc = buildJobTaskDescription({ ...JOB, buildingName: null }, BASE_URL);
    assert.ok(!desc.startsWith("\n"));
  });
});
