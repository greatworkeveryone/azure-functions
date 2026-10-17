/// <reference types="jest" />
// getRentReviews: which reviews it asks for, what comes back, who may ask.
import { clearRoleCache } from "../auth";
import { getRentReviews } from "../functions/getRentReviews";
import { asDate, callsMatching, DAY, getRequest, reviewRow, routeSql, TODAY } from "./fixtures/rentReviewFakes";
import type { InvocationContext } from "@azure/functions";

jest.mock("../db", () => ({
  closeConnection: jest.fn(),
  createRequestConnection: jest.fn(),
  executeQuery: jest.fn(),
}));

const db = require("../db") as { closeConnection: jest.Mock; createRequestConnection: jest.Mock; executeQuery: jest.Mock };
const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;

type Body = { asOf: string; reviews: Array<Record<string, any>>; truncated?: boolean };

const ask = (query: string, roles: string | null = "accounts") => getRentReviews(getRequest(query, roles), ctx);
const lastSelect = () => callsMatching(db.executeQuery, /FROM dbo\.RentReviews/).at(-1)!;

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "warn").mockImplementation(() => undefined); // the dev role override warns on every call
  clearRoleCache();
  process.env.DEV_ROLE_OVERRIDE_ENABLED = "true";
  process.env.AZURE_FUNCTIONS_ENVIRONMENT = "Development"; // the override only applies there (jwt.ts isDevOverrideEnabled)
  db.createRequestConnection.mockResolvedValue({});
  routeSql(db.executeQuery, [[/FROM dbo\.RentReviews/, () => []]]);
});

describe("who may ask", () => {
  it("needs a token", async () => {
    expect((await ask("tenantId=7", null)).status).toBe(401);
    expect(db.createRequestConnection).not.toHaveBeenCalled();
  });

  it.each(["accounts", "accounts_manager", "cfo", "director", "admin"])("lets %s read", async (role) => {
    expect((await ask("tenantId=7", role)).status).toBe(200);
  });

  it.each(["facilities", "facilities_manager", "user"])("refuses %s before touching the database", async (role) => {
    expect((await ask("tenantId=7", role)).status).toBe(403);
    expect(db.createRequestConnection).not.toHaveBeenCalled();
  });
});

describe("what it asks for", () => {
  it("wants at least one of tenantId, buildingId and state", async () => {
    const res = await ask("");
    expect(res.status).toBe(400);
    expect(db.executeQuery).not.toHaveBeenCalled();
  });

  it.each(["tenantId=abc", "tenantId=0", "tenantId=-4", "tenantId=1.5", "tenantId=99999999999", "buildingId=x", "tenantId=7%20OR%201=1"])(
    "refuses %s",
    async (query) => {
      expect((await ask(query)).status).toBe(400);
      expect(db.executeQuery).not.toHaveBeenCalled();
    },
  );

  it("refuses a state that isn't one of the ten", async () => {
    const res = await ask("state=due,finished");
    expect(res.status).toBe(400);
    expect((res.jsonBody as { error: string }).error).toContain("finished");
  });

  it("filters by tenancy, with the value as a parameter", async () => {
    await ask("tenantId=7");
    const { params, sql } = lastSelect();
    expect(sql).toContain("r.TenantId = @TenantId");
    expect(params.TenantId).toBe(7);
    expect(sql).not.toContain("t.BuildingId = @BuildingId");
    expect(sql).not.toMatch(/TenantId = 7/);
  });

  it("filters by building through the tenancy, so a tenancy that moved reads right", async () => {
    await ask("buildingId=5");
    const { params, sql } = lastSelect();
    expect(sql).toContain("t.BuildingId = @BuildingId");
    expect(params.BuildingId).toBe(5);
  });

  it("filters by one state or several, comma-separated or repeated", async () => {
    await ask("state=due");
    expect(lastSelect().sql).toContain("r.State IN (@State0)");
    expect(lastSelect().params).toMatchObject({ State0: "due" });

    await ask("state=due,in_progress");
    expect(lastSelect().sql).toContain("r.State IN (@State0, @State1)");
    expect(lastSelect().params).toMatchObject({ State0: "due", State1: "in_progress" });

    await ask("state=due&state=awaiting_index&state=due");
    expect(lastSelect().params).toMatchObject({ State0: "due", State1: "awaiting_index" });
    expect(lastSelect().params).not.toHaveProperty("State2");
  });

  it("combines filters with AND", async () => {
    await ask("buildingId=5&state=due,in_progress");
    const { sql } = lastSelect();
    expect(sql).toMatch(
      /WHERE r\.State IS NOT NULL AND t\.BuildingId = @BuildingId AND r\.State IN \(@State0, @State1\) AND t\.ArchivedAt IS NULL\s+ORDER BY/,
    );
  });

  it("leaves out rows written before the workflow, which have no State", async () => {
    await ask("tenantId=7");
    expect(lastSelect().sql).toContain("r.State IS NOT NULL");
  });

  it("caps the list and never builds SQL from the request", async () => {
    await ask("tenantId=7&state=due");
    const { params, sql } = lastSelect();
    expect(sql).toContain("SELECT TOP (@Limit)");
    expect(params.Limit).toBe(5000);
  });
});

describe("archived tenancies (D4)", () => {
  it.each(["buildingId=5", "state=due", "buildingId=5&state=due,in_progress"])(
    "leaves their reviews out of a list by %s",
    async (query) => {
      await ask(query);
      expect(lastSelect().sql).toContain("t.ArchivedAt IS NULL");
    },
  );

  it.each(["tenantId=7", "tenantId=7&state=due", "tenantId=7&buildingId=5&state=completed,waived"])(
    "still returns an archived tenancy's reviews when the tenancy is named, so its page can show the history: %s",
    async (query) => {
      await ask(query);
      expect(lastSelect().sql).not.toContain("ArchivedAt IS NULL");
    },
  );

  it("passes through what the database returns for a named, archived tenancy, with the review as it was left", async () => {
    routeSql(db.executeQuery, [
      [
        /FROM dbo\.RentReviews/,
        () => [reviewRow({ ReviewId: "old", ScheduledFor: asDate(DAY(-200)), State: "completed", Status: "completed", TenantArchivedAt: asDate(DAY(-20)), TenantStatus: "vacated" })],
      ],
    ]);

    const res = await ask("tenantId=7");

    expect(res.status).toBe(200);
    expect((res.jsonBody as Body).reviews).toEqual([expect.objectContaining({ overdue: false, reviewId: "old", state: "completed", tenantId: 7 })]);
  });
});

describe("what comes back", () => {
  it("lists reviews as the wire shape, with overdue worked out for today in Darwin", async () => {
    routeSql(db.executeQuery, [
      [
        /FROM dbo\.RentReviews/,
        () => [
          reviewRow({ ReviewId: "past-open", ScheduledFor: asDate(DAY(-3)), State: "in_progress", OwnerUserId: 7, OwnerName: "Ann Accounts" }),
          reviewRow({ ReviewId: "future-open", ScheduledFor: asDate(DAY(30)), State: "scheduled", Status: "upcoming" }),
          reviewRow({ ReviewId: "past-closed", ScheduledFor: asDate(DAY(-90)), State: "completed", Status: "completed" }),
          reviewRow({ ReviewId: "today", ScheduledFor: asDate(TODAY), State: "due", TradingName: "Acme Trading" }),
        ],
      ],
    ]);

    const res = await ask("tenantId=7");

    expect(res.status).toBe(200);
    const body = res.jsonBody as Body;
    expect(body.asOf).toBe(TODAY);
    expect(body.truncated).toBeUndefined();
    const byId = Object.fromEntries(body.reviews.map((review) => [review.reviewId, review]));
    expect(byId["past-open"]).toMatchObject({
      buildingId: 5,
      method: "cpi",
      overdue: true,
      ownerName: "Ann Accounts",
      ownerUserId: 7,
      scheduledFor: DAY(-3),
      state: "in_progress",
      tenantId: 7,
      tenantName: "Acme Pty Ltd",
    });
    expect(byId["future-open"].overdue).toBe(false);
    expect(byId["past-closed"].overdue).toBe(false);
    expect(byId.today.overdue).toBe(false);
    expect(byId.today.tenantName).toBe("Acme Trading");
    expect(byId["future-open"].rowVersion).toBe("0000000000000a01");
  });

  it("returns an empty list as 200", async () => {
    const res = await ask("tenantId=7");
    expect(res.status).toBe(200);
    expect((res.jsonBody as Body).reviews).toEqual([]);
  });

  it("answers a failed query with a 500 and closes the connection", async () => {
    routeSql(db.executeQuery, [[/FROM dbo\.RentReviews/, () => Promise.reject(new Error("boom"))]]);
    const res = await ask("tenantId=7");
    expect(res.status).toBe(500);
    expect(db.closeConnection).toHaveBeenCalled();
  });
});
