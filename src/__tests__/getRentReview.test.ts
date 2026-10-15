/// <reference types="jest" />
// getRentReview: the review, a summary of its tenancy, the step it is linked to
// and, for a CPI review, the two index values for the reference quarter.
import type { InvocationContext } from "@azure/functions";
import { clearRoleCache } from "../auth";
import { addMonthsClamped } from "../darwinDate";
import { getRentReview } from "../functions/getRentReview";
import { referenceQuarter } from "../rentReview/cpi";
import { asDate, callsMatching, DAY, getRequest, reviewRow, routeSql, tenancyRow, TODAY } from "./fixtures/rentReviewFakes";

jest.mock("../db", () => ({
  closeConnection: jest.fn(),
  createRequestConnection: jest.fn(),
  executeQuery: jest.fn(),
}));

const db = require("../db") as { closeConnection: jest.Mock; createRequestConnection: jest.Mock; executeQuery: jest.Mock };
const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;

type Body = {
  asOf: string;
  cpiSuggestion: null | {
    expectedRelease: string | null;
    previousQuarter: string;
    referenceQuarter: string;
    region: string;
    rule: string;
    values: null | { current: number; previous: number; referenceBase: string };
  };
  review: Record<string, any>;
  step: Record<string, any> | null;
  tenancy: Record<string, any>;
};

const ask = (query: string, roles: string | null = "accounts") => getRentReview(getRequest(query, roles), ctx);

const STEP_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const BASE = "Sep 2025 = 100.0";

function serve(options: { cpi?: Array<{ Period: string; IndexValue: number; ReferenceBase: string | null }>; review?: Record<string, unknown>; sqm?: number; tenancy?: Record<string, unknown> | null } = {}) {
  routeSql(db.executeQuery, [
    [/FROM dbo\.RentReviews r/, () => [reviewRow(options.review ?? {})]],
    [/FROM dbo\.Tenants t\s+LEFT JOIN dbo\.Buildings/, () => (options.tenancy === null ? [] : [tenancyRow(options.tenancy ?? {})])],
    [/FROM dbo\.TenantOccupancies/, () => [{ Sqm: options.sqm ?? 400 }]],
    [/FROM dbo\.CpiIndex/, () => options.cpi ?? []],
  ]);
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "warn").mockImplementation(() => undefined); // the dev role override warns on every call
  clearRoleCache();
  process.env.DEV_ROLE_OVERRIDE_ENABLED = "true";
  delete process.env.AZURE_FUNCTIONS_ENVIRONMENT;
  db.createRequestConnection.mockResolvedValue({});
  serve();
});

describe("who may ask, and what", () => {
  it("needs a token and one of the tenancy viewer roles", async () => {
    expect((await ask("reviewId=rev-1", null)).status).toBe(401);
    for (const role of ["facilities", "facilities_manager", "user"]) expect((await ask("reviewId=rev-1", role)).status).toBe(403);
    for (const role of ["accounts", "accounts_manager", "cfo", "director", "admin"]) expect((await ask("reviewId=rev-1", role)).status).toBe(200);
  });

  it.each(["", "reviewId=", "reviewId=a b", "reviewId=" + "x".repeat(41), "reviewId=rev;DROP"])("refuses %j", async (query) => {
    const res = await ask(query);
    expect(res.status).toBe(400);
    expect(db.executeQuery).not.toHaveBeenCalled();
  });

  it("is a 404 for a review that doesn't exist, and for one written before the workflow", async () => {
    routeSql(db.executeQuery, [[/FROM dbo\.RentReviews r/, () => []]]);
    expect((await ask("reviewId=nope")).status).toBe(404);
    const [{ sql }] = callsMatching(db.executeQuery, /FROM dbo\.RentReviews r/);
    expect(sql).toContain("r.State IS NOT NULL");
  });

  it("looks the review up by a parameter", async () => {
    await ask("reviewId=rev-1");
    const [{ params }] = callsMatching(db.executeQuery, /FROM dbo\.RentReviews r/);
    expect(params.ReviewId).toBe("rev-1");
  });
});

describe("the review and its tenancy", () => {
  it("returns the review with its rowVersion, the derived overdue flag and the day it is as of", async () => {
    serve({ review: { ScheduledFor: asDate(DAY(-2)), State: "in_progress", OwnerUserId: 7, OwnerName: "Ann Accounts", Basis: '{"method":"cpi","region":"DARWIN"}' } });

    const body = (await ask("reviewId=rev-1")).jsonBody as Body;

    expect(body.asOf).toBe(TODAY);
    expect(body.review).toMatchObject({
      basis: { method: "cpi", region: "DARWIN" },
      overdue: true,
      ownerName: "Ann Accounts",
      ownerUserId: 7,
      reviewId: "rev-1",
      rowVersion: "0000000000000a01",
      scheduledFor: DAY(-2),
      state: "in_progress",
      tenantId: 7,
    });
  });

  it("summarises the tenancy: names, lease terms, the rent in force today", async () => {
    const steps = JSON.stringify([
      { baseRentPerAnnum: 100000, effectiveFrom: DAY(-400), id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", methodKind: "commencement", ratePercent: 0 },
    ]);
    serve({ sqm: 250, tenancy: { ScheduledRateSteps: steps, TradingName: "Acme Trading" } });

    const { tenancy } = (await ask("reviewId=rev-1")).jsonBody as Body;

    expect(tenancy).toMatchObject({
      buildingId: 5,
      buildingName: "Tower A",
      cpiCapPercent: 5,
      cpiFloorPercent: 1,
      cpiRegion: "DARWIN",
      effectiveRentPerAnnum: 100000,
      fixedReviewPercent: null,
      legalName: "Acme Pty Ltd",
      reviewIntervalMonths: 12,
      reviewRatchet: true,
      reviewType: "CPI Darwin (June)",
      scheduleVersion: 4,
      status: "current",
      tenantId: 7,
      tradingName: "Acme Trading",
    });
    expect(tenancy.commencement).toBe(addMonthsClamped(DAY(10), -24));
  });

  it("falls back to the stored rent when the tenancy has no schedule", async () => {
    const { tenancy } = (await ask("reviewId=rev-1")).jsonBody as Body;
    expect(tenancy.effectiveRentPerAnnum).toBe(120000);
  });

  it("is a 404 when the review's tenancy is gone", async () => {
    serve({ tenancy: null });
    expect((await ask("reviewId=rev-1")).status).toBe(404);
  });
});

describe("the linked step", () => {
  const steps = JSON.stringify([
    { effectiveFrom: DAY(-400), id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", methodKind: "commencement", ratePercent: 0 },
    { cpiValue: 103.2, cpiValuePrev: 99.1, effectiveFrom: DAY(10), id: STEP_ID, methodKind: "cpi", ratePercent: 4.1 },
  ]);

  it("is the schedule step the review points at", async () => {
    serve({ review: { StepId: STEP_ID }, tenancy: { ScheduledRateSteps: steps } });
    const { step } = (await ask("reviewId=rev-1")).jsonBody as Body;
    expect(step).toMatchObject({ cpiValue: 103.2, effectiveFrom: DAY(10), id: STEP_ID, methodKind: "cpi" });
  });

  it("is null before the review is linked, and when the step has since gone", async () => {
    serve({ review: { StepId: null }, tenancy: { ScheduledRateSteps: steps } });
    expect(((await ask("reviewId=rev-1")).jsonBody as Body).step).toBeNull();
    serve({ review: { StepId: "cccccccc-cccc-cccc-cccc-cccccccccccc" }, tenancy: { ScheduledRateSteps: steps } });
    expect(((await ask("reviewId=rev-1")).jsonBody as Body).step).toBeNull();
  });
});

describe("the CPI suggestion", () => {
  const reviewDate = DAY(10);
  const reference = referenceQuarter(reviewDate);
  const previous = (() => {
    const year = Number(reference.slice(0, 4)) - 1;
    return `${year}${reference.slice(4)}`;
  })();

  it("is the two index values for the reference quarter, on one base, once both are published", async () => {
    serve({
      cpi: [
        { IndexValue: 103.2, Period: reference, ReferenceBase: BASE },
        { IndexValue: 99.1, Period: previous, ReferenceBase: BASE },
      ],
    });

    const { cpiSuggestion } = (await ask("reviewId=rev-1")).jsonBody as Body;

    expect(cpiSuggestion).toEqual({
      expectedRelease: null,
      previousQuarter: previous,
      referenceQuarter: reference,
      region: "DARWIN",
      rule: "quarter_before_review_date",
      values: { current: 103.2, previous: 99.1, referenceBase: BASE },
    });
    const [{ params, sql }] = callsMatching(db.executeQuery, /FROM dbo\.CpiIndex/);
    expect(sql).toContain("Region = @Region AND Period IN (@PeriodA, @PeriodB)");
    expect(params).toEqual({ PeriodA: reference, PeriodB: previous, Region: "DARWIN" });
  });

  it("has no values until the reference quarter is published, and says when it is expected", async () => {
    serve({ cpi: [{ IndexValue: 99.1, Period: previous, ReferenceBase: BASE }] });

    const { cpiSuggestion } = (await ask("reviewId=rev-1")).jsonBody as Body;

    expect(cpiSuggestion?.values).toBeNull();
    expect(cpiSuggestion?.referenceQuarter).toBe(reference);
    expect(cpiSuggestion?.expectedRelease).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("has no values when the two quarters aren't on one base", async () => {
    serve({
      cpi: [
        { IndexValue: 103.2, Period: reference, ReferenceBase: BASE },
        { IndexValue: 99.1, Period: previous, ReferenceBase: "Dec 2011 = 100.0" },
      ],
    });
    expect(((await ask("reviewId=rev-1")).jsonBody as Body).cpiSuggestion?.values).toBeNull();
  });

  it("reads the region and interval the review was commenced on, not the lease's today", async () => {
    serve({
      cpi: [],
      review: { Basis: JSON.stringify({ intervalMonths: 24, method: "cpi", region: "AUS" }), State: "in_progress" },
      tenancy: { CpiRegion: "DARWIN" },
    });

    const { cpiSuggestion } = (await ask("reviewId=rev-1")).jsonBody as Body;

    expect(cpiSuggestion?.region).toBe("AUS");
    expect(cpiSuggestion?.previousQuarter).toBe(`${Number(reference.slice(0, 4)) - 2}${reference.slice(4)}`);
    expect(callsMatching(db.executeQuery, /FROM dbo\.CpiIndex/)[0].params.Region).toBe("AUS");
  });

  it("is null for a review that isn't CPI, and doesn't look the index up", async () => {
    for (const method of ["fixed", "market", "other"]) {
      serve({ review: { Method: method } });
      expect(((await ask("reviewId=rev-1")).jsonBody as Body).cpiSuggestion).toBeNull();
    }
    expect(callsMatching(db.executeQuery, /FROM dbo\.CpiIndex/)).toHaveLength(0);
  });

  it("is null when the lease has no CPI region to read", async () => {
    serve({ tenancy: { CpiRegion: null } });
    expect(((await ask("reviewId=rev-1")).jsonBody as Body).cpiSuggestion).toBeNull();
    expect(callsMatching(db.executeQuery, /FROM dbo\.CpiIndex/)).toHaveLength(0);
  });
});
