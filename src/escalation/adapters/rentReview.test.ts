/// <reference types="jest" />
// The rent review adapter (WP26): the inbox links to /tenancy/reviews/{id},
// E1 and E2 hold or clear from the review's own date read for today in Darwin,
// a closed tenancy's review isn't chased, and only readers of tenancies (the
// CFO included) see these.
import type { Connection } from "tedious";
import { addDaysIso, todayInDarwin } from "../../darwinDate";
import { runSweep, type SweepDeps } from "../sweep";
import type { EscalationRow } from "../types";
import { getAdapter, registeredSubjectTypes } from "./registry";
import { rentReviewAdapter } from "./rentReview";
import "./index";

jest.mock("../../db", () => ({ executeQuery: jest.fn() }));
const db = require("../../db") as { executeQuery: jest.Mock };

const conn = {} as Connection;
const NOW = new Date();
const TODAY = todayInDarwin(NOW);
const asDate = (iso: string) => new Date(`${iso}T00:00:00Z`);
const ref = (policyKey: string, subjectId = "rev-1") => ({ policyKey, subjectId, subjectType: "rent_review" });

const row = (over: Record<string, unknown> = {}) => ({
  ArchivedAt: null,
  BuildingId: 5,
  ExpectedIndexAt: null,
  ScheduleSignedOffAt: new Date("2026-09-01T00:00:00Z"),
  BuildingName: "Tower A",
  LegalName: "Acme Pty Ltd",
  Method: "cpi",
  ReviewId: "rev-1",
  ScheduledFor: asDate(addDaysIso(TODAY, 10)),
  State: "due",
  TenantArchivedAt: null,
  TenantId: 42,
  TenantStatus: "current",
  TradingName: "Acme Coffee",
  ...over,
});

beforeEach(() => {
  db.executeQuery.mockReset();
  db.executeQuery.mockResolvedValue([row()]);
});

describe("registration", () => {
  it("is registered with the engine for subject type rent_review", () => {
    expect(registeredSubjectTypes()).toEqual(expect.arrayContaining(["job", "rent_review", "system", "tenancy"]));
    expect(getAdapter("rent_review")).toBe(rentReviewAdapter);
  });
});

describe("the deep link", () => {
  it("is the review workspace, /tenancy/reviews/{id}, and can't be bent into another path", () => {
    expect(rentReviewAdapter.deepLink("rev-1")).toBe("/tenancy/reviews/rev-1");
    expect(rentReviewAdapter.deepLink("../admin")).toBe("/tenancy/reviews/..%2Fadmin");
  });
});

describe("who sees these", () => {
  const viewer = (...roles: string[]) => ({ name: "Ann", roles, userId: 7 });
  it.each(["accounts", "accounts_manager", "cfo", "director", "admin"])("%s, who may read a tenancy (the CFO too)", (role) => {
    expect(rentReviewAdapter.visibleTo(viewer(role), ref("rent_review.overdue"))).toBe(true);
  });
  it.each(["facilities", "facilities_manager", "user"])("not %s", (role) => {
    expect(rentReviewAdapter.visibleTo(viewer(role), ref("rent_review.overdue"))).toBe(false);
  });
});

describe("the summary", () => {
  it("names the method and date (day first), the tenant and the building", async () => {
    const scheduledFor = addDaysIso(TODAY, 10);
    const [year, month, day] = scheduledFor.split("-");
    const summary = await rentReviewAdapter.loadSummary(conn, "rev-1");
    expect(summary).toEqual({
      buildingId: 5,
      context: { buildingName: "Tower A", method: "cpi", reviewId: "rev-1", scheduledFor, state: "due", tenantId: 42, tenantName: "Acme Coffee" },
      summary: `CPI review ${day}/${month}/${year} · Acme Coffee · Tower A`,
    });
    expect(db.executeQuery.mock.calls[0][1]).toContain("r.State IS NOT NULL");
  });

  it("is null for a review that doesn't exist, a legacy row, or an id that isn't one", async () => {
    db.executeQuery.mockResolvedValue([]);
    await expect(rentReviewAdapter.loadSummary(conn, "nope")).resolves.toBeNull();
    db.executeQuery.mockResolvedValue([row({ State: "upcoming" })]);
    await expect(rentReviewAdapter.loadSummary(conn, "rev-1")).resolves.toBeNull();
    db.executeQuery.mockClear();
    await expect(rentReviewAdapter.loadSummary(conn, "x; DROP TABLE y")).resolves.toBeNull();
    expect(db.executeQuery).not.toHaveBeenCalled();
  });

  it("scopes the ledger rows to the tenancy", () => {
    expect(rentReviewAdapter.ledgerScope?.({ context: { tenantId: 42 }, subjectId: "rev-1" })).toEqual({ tenantId: 42 });
    expect(rentReviewAdapter.ledgerScope?.({ context: null, subjectId: "rev-1" })).toEqual({ tenantId: null });
  });
});

describe("E1 rent_review.not_commenced", () => {
  const active = (over: Record<string, unknown>) => {
    db.executeQuery.mockResolvedValue([row(over)]);
    return rentReviewAdapter.isConditionActive(conn, ref("rent_review.not_commenced"), NOW);
  };

  it("holds for a review not commenced from 14 days before its date, overdue ones included", async () => {
    await expect(active({ ScheduledFor: asDate(addDaysIso(TODAY, 14)), State: "due" })).resolves.toBe(true);
    await expect(active({ ScheduledFor: asDate(addDaysIso(TODAY, -3)), State: "scheduled" })).resolves.toBe(true);
  });

  it("doesn't hold yet 15 days out", async () => {
    await expect(active({ ScheduledFor: asDate(addDaysIso(TODAY, 15)), State: "due" })).resolves.toBe(false);
  });

  it("clears once it is commenced, or the tenancy is vacated or archived", async () => {
    await expect(active({ State: "in_progress" })).resolves.toBe(false);
    await expect(active({ TenantStatus: "vacated" })).resolves.toBe(false);
    await expect(active({ TenantArchivedAt: new Date() })).resolves.toBe(false);
  });
});

describe("E2 rent_review.overdue", () => {
  const active = (over: Record<string, unknown>) => {
    db.executeQuery.mockResolvedValue([row(over)]);
    return rentReviewAdapter.isConditionActive(conn, ref("rent_review.overdue"), NOW);
  };

  it("holds for an open review whose date has passed (Darwin), not on the date itself", async () => {
    await expect(active({ ScheduledFor: asDate(addDaysIso(TODAY, -1)), State: "awaiting_approval" })).resolves.toBe(true);
    await expect(active({ ScheduledFor: asDate(TODAY), State: "in_progress" })).resolves.toBe(false);
  });

  it.each(["approved", "completed", "waived", "cancelled"])("clears once it is %s", async (state) => {
    await expect(active({ ScheduledFor: asDate(addDaysIso(TODAY, -30)), State: state })).resolves.toBe(false);
  });

  it("clears for a review that has gone", async () => {
    db.executeQuery.mockResolvedValue([]);
    await expect(rentReviewAdapter.isConditionActive(conn, ref("rent_review.overdue"), NOW)).resolves.toBe(false);
  });
});

describe("H2 and M5: what isn't chased", () => {
  const active = (policyKey: string, over: Record<string, unknown>) => {
    db.executeQuery.mockResolvedValue([row(over)]);
    return rentReviewAdapter.isConditionActive(conn, ref(policyKey), NOW);
  };

  it("clears E1 and E2 while the tenancy's schedule isn't signed off", async () => {
    await expect(active("rent_review.not_commenced", { ScheduleSignedOffAt: null, ScheduledFor: asDate(addDaysIso(TODAY, 3)) })).resolves.toBe(false);
    await expect(active("rent_review.overdue", { ScheduleSignedOffAt: null, ScheduledFor: asDate(addDaysIso(TODAY, -9)), State: "in_progress" })).resolves.toBe(false);
    expect(db.executeQuery.mock.calls.at(-1)?.[1]).toContain("t.ScheduleSignedOffAt");
  });

  it("clears E2 while the index is awaited until a week past its expected date", async () => {
    const waiting = (days: number) => ({ ExpectedIndexAt: asDate(addDaysIso(TODAY, days)), ScheduledFor: asDate(addDaysIso(TODAY, -40)), State: "awaiting_index" });
    await expect(active("rent_review.overdue", waiting(-7))).resolves.toBe(false);
    await expect(active("rent_review.overdue", waiting(-8))).resolves.toBe(true);
  });

  it("is withdrawn by the escalation sweep when the sign-off goes: the live E2 ends as condition_cleared", async () => {
    const live = {
      acknowledgedAt: null,
      dueAt: null,
      escalationId: 31,
      kind: "attention",
      level: 1,
      notificationAttempts: 1,
      notificationState: "sent",
      policyKey: "rent_review.overdue",
      rowVersion: "v1",
      status: "open",
      subjectId: "rev-1",
      subjectType: "rent_review",
    } as unknown as EscalationRow;
    db.executeQuery.mockResolvedValue([row({ ScheduleSignedOffAt: null, ScheduledFor: asDate(addDaysIso(TODAY, -9)), State: "in_progress" })]);
    const autoResolve = jest.fn().mockImplementation(async () => ({ ...live, resolutionCode: "condition_cleared", status: "withdrawn" }));
    const deps = {
      autoResolve,
      countExhaustedNotifications: async () => 0,
      escalateFurther: jest.fn(),
      getAdapter: (type: string) => (type === "rent_review" ? rentReviewAdapter : null),
      getPolicy: async () => null,
      hasNextLevel: async () => false,
      latestEmailArrivals: async () => new Map(),
      latestTimesBySubject: async () => new Map(),
      // Jobs plan A2: no deferred decisions are due in this world.
      listDueDeferrals: async () => [],
      listLiveEscalations: async () => [live],
      loadLiveJobFacts: async () => [],
      notifyTargets: jest.fn(),
      // The sweep's own health checks raise system.health; nothing to do with the review.
      raise: jest.fn(async () => ({ created: false, escalation: live })),
    } as unknown as SweepDeps;
    const report = await runSweep(conn, { dryRun: false, env: {}, log: jest.fn(), now: NOW, warn: jest.fn() }, deps);
    expect(autoResolve).toHaveBeenCalledWith(conn, expect.objectContaining({ escalationId: 31, expectedRowVersion: "v1" }));
    expect(report.autoResolved).toBe(1);
    expect(report.errors).toEqual([]);
  });
});

describe("a manual escalation on a review (any.manual)", () => {
  it("holds while the review is open", async () => {
    await expect(rentReviewAdapter.isConditionActive(conn, ref("any.manual"), NOW)).resolves.toBe(true);
    db.executeQuery.mockResolvedValue([row({ State: "waived" })]);
    await expect(rentReviewAdapter.isConditionActive(conn, ref("any.manual"), NOW)).resolves.toBe(false);
  });
});
