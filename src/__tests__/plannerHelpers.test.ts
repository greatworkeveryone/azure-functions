import assert from "node:assert";
import {
  buildTaskTitle,
  computeEventDate,
  formatDDMMYYYY,
  isInWindow,
  type PlannerTenantRow,
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
