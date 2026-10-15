/// <reference types="jest" />
// The rent review adapter (WP26): the inbox links to /tenancy/reviews/{id},
// E1 and E2 hold or clear from the review's own date read for today in Darwin,
// a closed tenancy's review isn't chased, and only readers of tenancies (the
// CFO included) see these.
import type { Connection } from "tedious";
import { addDaysIso, todayInDarwin } from "../../darwinDate";
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

describe("a manual escalation on a review (any.manual)", () => {
  it("holds while the review is open", async () => {
    await expect(rentReviewAdapter.isConditionActive(conn, ref("any.manual"), NOW)).resolves.toBe(true);
    db.executeQuery.mockResolvedValue([row({ State: "waived" })]);
    await expect(rentReviewAdapter.isConditionActive(conn, ref("any.manual"), NOW)).resolves.toBe(false);
  });
});
