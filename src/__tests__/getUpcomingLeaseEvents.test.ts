/// <reference types="jest" />
// getUpcomingLeaseEvents: who may ask, the window, the building filter, and that
// nothing but names and dates is read or returned (LAUNCH-READINESS §4.4).
import type { InvocationContext } from "@azure/functions";
import { clearRoleCache } from "../auth";
import { addMonthsClamped } from "../darwinDate";
import { getUpcomingLeaseEvents } from "../functions/getUpcomingLeaseEvents";
import { asDate, callsMatching, DAY, getRequest, routeSql, TODAY, type Row } from "./fixtures/rentReviewFakes";

jest.mock("../db", () => ({
  closeConnection: jest.fn(),
  createRequestConnection: jest.fn(),
  executeQuery: jest.fn(),
}));

const db = require("../db") as { closeConnection: jest.Mock; createRequestConnection: jest.Mock; executeQuery: jest.Mock };
const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;

type Event = Record<string, any>;
type Body = { asOf: string; days: number; events: Event[] };

let tenancies: Row[];
let reviews: Row[];

const tenancyRow = (id: number, over: Row = {}): Row => ({
  BuildingId: 5,
  Expiry: null,
  LegalName: `Tenant ${id} Pty Ltd`,
  OptionNoticeMonths: null,
  OptionPeriods: null,
  ScheduleSignedOffAt: new Date("2026-10-01T00:00:00Z"),
  TenantId: id,
  TradingName: null,
  ...over,
});

const reviewRow = (id: number, date: string, over: Row = {}): Row => ({
  BuildingId: 5,
  LegalName: `Tenant ${id} Pty Ltd`,
  Method: "cpi",
  OwnerName: null,
  OwnerUserId: null,
  ReviewId: `rev-${id}`,
  ScheduleSignedOffAt: new Date("2026-10-01T00:00:00Z"),
  ScheduledFor: asDate(date),
  State: "due",
  TenantId: id,
  TradingName: null,
  ...over,
});

const ask = (query = "", roles: string | null = "accounts") => getUpcomingLeaseEvents(getRequest(query, roles), ctx);
const sqlOf = (pattern: RegExp) => callsMatching(db.executeQuery, pattern)[0];

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "warn").mockImplementation(() => undefined); // the dev role override warns on every call
  clearRoleCache();
  process.env.DEV_ROLE_OVERRIDE_ENABLED = "true";
  process.env.AZURE_FUNCTIONS_ENVIRONMENT = "Development"; // the override only applies there (jwt.ts isDevOverrideEnabled)
  db.createRequestConnection.mockResolvedValue({});
  tenancies = [];
  reviews = [];
  routeSql(db.executeQuery, [[/FROM dbo\.ScheduleChangeRequests c/, () => []], 
    [/FROM dbo\.RentReviews r/, () => reviews],
    [/FROM dbo\.Tenants t\s+WHERE/, () => tenancies],
  ]);
});

describe("who may ask", () => {
  it("needs a token", async () => {
    expect((await ask("", null)).status).toBe(401);
    expect(db.createRequestConnection).not.toHaveBeenCalled();
  });

  it.each(["accounts", "accounts_manager", "cfo", "director", "admin"])("lets %s, a reader of tenancies", async (role) => {
    expect((await ask("", role)).status).toBe(200);
  });

  it.each(["facilities", "facilities_manager", "user"])(
    "refuses %s, who could see whole tenancies through getReviewsDue and now can't see this",
    async (role) => {
      expect((await ask("", role)).status).toBe(403);
      expect(db.createRequestConnection).not.toHaveBeenCalled();
    },
  );
});

describe("the window", () => {
  it("looks 90 days ahead unless told otherwise", async () => {
    const body = (await ask()).jsonBody as Body;
    expect(body).toMatchObject({ asOf: TODAY, days: 90 });
    expect(callsMatching(db.executeQuery, /FROM dbo\.RentReviews r/)[0].params.Until).toBe(DAY(90));
  });

  it("takes ?days, from 1 to 365", async () => {
    expect(((await ask("days=30")).jsonBody as Body).days).toBe(30);
    expect(((await ask("days=365")).jsonBody as Body).days).toBe(365);
    expect(((await ask("days=1")).jsonBody as Body).days).toBe(1);
  });

  it.each(["days=0", "days=366", "days=-5", "days=abc", "days=7.5", "days=90%20OR%201=1"])("refuses %s", async (query) => {
    const res = await ask(query);
    expect(res.status).toBe(400);
    expect(db.executeQuery).not.toHaveBeenCalled();
  });

  it("counts the window in days from today in Darwin, inclusive", async () => {
    tenancies = [tenancyRow(1, { Expiry: asDate(DAY(30)) }), tenancyRow(2, { Expiry: asDate(DAY(31)) })];
    expect(((await ask("days=30")).jsonBody as Body).events.map((e) => e.tenantId)).toEqual([1]);
  });
});

describe("the building filter", () => {
  it("covers every building unless one is named", async () => {
    await ask();
    expect(sqlOf(/FROM dbo\.RentReviews r/).sql).not.toContain("@BuildingId");
    expect(sqlOf(/FROM dbo\.Tenants t/).sql).not.toContain("@BuildingId");
  });

  it("narrows both queries to the building, by parameter", async () => {
    await ask("buildingId=5");
    for (const pattern of [/FROM dbo\.RentReviews r/, /FROM dbo\.Tenants t/]) {
      const { params, sql } = sqlOf(pattern);
      expect(sql).toContain("t.BuildingId = @BuildingId");
      expect(params.BuildingId).toBe(5);
    }
  });

  it.each(["buildingId=0", "buildingId=abc", "buildingId=-2", "buildingId=1.5", "buildingId=99999999999"])("refuses %s", async (query) => {
    expect((await ask(query)).status).toBe(400);
    expect(db.executeQuery).not.toHaveBeenCalled();
  });
});

describe("what it reads: names and dates only", () => {
  const SENSITIVE = [
    "RentPerAnnum", "RentPerSqm", "Abn", "Acn", "AccountsEmail", "AccountsPhone", "PrimaryContact", "PostalAddress",
    "StreetAddress", "MyobId", "SecurityDeposit", "Comments", "Incentives", "ScheduledRateSteps", "MiscFees",
    "CarparkScheduleGroups", "InfoSheet", "LeaseAdministration", "IdNo", "Basis", "Calc", "Notes",
  ];

  it("selects no rent, ABN, contact or notes column from the tenancy or the review", async () => {
    await ask();
    for (const pattern of [/FROM dbo\.RentReviews r/, /FROM dbo\.Tenants t/]) {
      const { sql } = sqlOf(pattern);
      for (const column of SENSITIVE) expect(sql).not.toContain(column);
      expect(sql).not.toMatch(/SELECT\s+\*/i);
      expect(sql).not.toMatch(/\bt\.\*|\br\.\*/);
    }
  });

  it("reads only active tenancies and open reviews of active tenancies", async () => {
    await ask();
    expect(sqlOf(/FROM dbo\.Tenants t/).sql).toContain("t.Status <> 'vacated'");
    const reviewSql = sqlOf(/FROM dbo\.RentReviews r/).sql;
    expect(reviewSql).toContain("t.Status <> 'vacated'");
    expect(reviewSql).toContain("r.State IN ('scheduled', 'due', 'in_progress', 'awaiting_index', 'referred', 'awaiting_approval')");
    expect(reviewSql).toContain("r.ScheduledFor <= @Until");
  });

  it("leaves archived tenancies out of all three kinds (D4): the tenancy query feeds expiries and option deadlines, the review query feeds reviews", async () => {
    await ask();
    expect(sqlOf(/FROM dbo\.Tenants t/).sql).toContain("t.Status <> 'vacated' AND t.ArchivedAt IS NULL");
    expect(sqlOf(/FROM dbo\.RentReviews r/).sql).toContain("t.Status <> 'vacated' AND t.ArchivedAt IS NULL");
  });

  it("keeps that exclusion when it narrows to a building", async () => {
    await ask("buildingId=5");
    for (const pattern of [/FROM dbo\.RentReviews r/, /FROM dbo\.Tenants t/]) {
      const { sql } = sqlOf(pattern);
      expect(sql).toContain("t.ArchivedAt IS NULL");
      expect(sql).toContain("AND t.BuildingId = @BuildingId");
    }
  });

  it("returns rows that hold nothing beyond names, ids and dates, even if the database were to give more", async () => {
    tenancies = [
      tenancyRow(1, {
        Abn: "12 345 678 901",
        AccountsEmail: "accounts@acme.example",
        Expiry: asDate(DAY(20)),
        PrimaryContactName: "Pat Contact",
        RentPerAnnum: 123456,
      }),
    ];
    reviews = [reviewRow(1, DAY(10), { Calc: '{"newAnnual":130000}', RentPerAnnum: 123456, OwnerName: "Ann Accounts", OwnerUserId: 7 })];

    const res = await ask();

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.jsonBody)).not.toMatch(/12 345 678 901|accounts@acme|Pat Contact|123456|130000/);
    const allowed = new Set(["buildingId", "date", "kind", "method", "overdue", "ownerName", "ownerUserId", "reviewId", "scheduleSignedOff", "state", "tenantId", "tenantName"]);
    for (const event of (res.jsonBody as Body).events) {
      for (const key of Object.keys(event)) expect(allowed.has(key)).toBe(true);
    }
  });
});

describe("whether a schedule is signed off (PLAN D7)", () => {
  it("reads only the sign-off time, never who signed it or their note", async () => {
    await ask();
    for (const pattern of [/FROM dbo\.RentReviews r/, /FROM dbo\.Tenants t/]) {
      const { sql } = sqlOf(pattern);
      expect(sql).toContain("t.ScheduleSignedOffAt");
      expect(sql).not.toContain("ScheduleSignedOffByName");
      expect(sql).not.toContain("ScheduleSignedOffById");
      expect(sql).not.toContain("ScheduleSignOffNote");
    }
  });

  it("marks each row signed off or not, from the tenancy behind it", async () => {
    tenancies = [
      tenancyRow(1, { Expiry: asDate(DAY(20)) }),
      tenancyRow(2, { Expiry: asDate(DAY(21)), ScheduleSignedOffAt: null }),
    ];
    reviews = [reviewRow(3, DAY(10), { ScheduleSignedOffAt: null }), reviewRow(4, DAY(11))];

    const { events } = (await ask()).jsonBody as Body;
    const byKey = Object.fromEntries(events.map((event) => [`${event.kind}:${event.tenantId}`, event.scheduleSignedOff]));

    expect(byKey).toEqual({ "expiry:1": true, "expiry:2": false, "review:3": false, "review:4": true });
  });
});

describe("the events", () => {
  it("returns reviews, expiries and option deadlines in one list, overdue first", async () => {
    const expiry = addMonthsClamped(TODAY, 8);
    tenancies = [
      tenancyRow(1, { Expiry: asDate(DAY(40)), TradingName: "Acme Trading" }),
      tenancyRow(2, { Expiry: asDate(expiry), OptionNoticeMonths: 6, OptionPeriods: "2 x 5 years" }),
      tenancyRow(3, { Expiry: asDate(DAY(-12)) }),
    ];
    reviews = [reviewRow(1, DAY(20), { OwnerName: "Ann Accounts", OwnerUserId: 7, State: "in_progress" }), reviewRow(4, DAY(-3), { Method: null })];

    const { events } = (await ask()).jsonBody as Body;

    expect(events.map((e) => `${e.kind}:${e.tenantId}:${e.overdue}`)).toEqual([
      "expiry:3:true",
      "review:4:true",
      "review:1:false",
      "expiry:1:false",
      "option_deadline:2:false",
    ]);
    expect(events.find((e) => e.kind === "review" && e.tenantId === 1)).toEqual({
      buildingId: 5,
      date: DAY(20),
      kind: "review",
      method: "cpi",
      overdue: false,
      ownerName: "Ann Accounts",
      ownerUserId: 7,
      reviewId: "rev-1",
      scheduleSignedOff: true,
      state: "in_progress",
      tenantId: 1,
      tenantName: "Tenant 1 Pty Ltd",
    });
    expect(events.find((e) => e.kind === "expiry" && e.tenantId === 1)).toMatchObject({ tenantName: "Acme Trading" });
    expect(events.find((e) => e.kind === "review" && e.tenantId === 4)).toMatchObject({ method: null });
  });

  it("is an empty list, not an error, when nothing is coming up", async () => {
    const res = await ask();
    expect(res.status).toBe(200);
    expect((res.jsonBody as Body).events).toEqual([]);
  });

  it("answers a failed query with a 500 and closes the connection", async () => {
    routeSql(db.executeQuery, [[/FROM dbo\.ScheduleChangeRequests c/, () => []], [/FROM dbo\.Tenants/, () => Promise.reject(new Error("boom"))]]);
    expect((await ask()).status).toBe(500);
    expect(db.closeConnection).toHaveBeenCalled();
  });
});
