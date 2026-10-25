/// <reference types="jest" />
import { HttpRequest, InvocationContext } from "@azure/functions";

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn() } };
});

jest.mock("../auth", () => {
  const actual = jest.requireActual("../auth");
  return {
    ...actual,
    errorResponse: jest.fn().mockReturnValue({ jsonBody: { error: "Error" }, status: 500 }),
    extractToken: jest.fn().mockReturnValue("mock-token"),
    requireRole: jest.fn().mockResolvedValue(null),
    unauthorizedResponse: jest.fn().mockReturnValue({ jsonBody: { error: "Unauthorized" }, status: 401 }),
    userInfoFromToken: jest.fn().mockReturnValue({ email: "c@rp.com", name: "Connor", oid: "oid-1" }),
  };
});

jest.mock("../db", () => {
  const actual = jest.requireActual("../db");
  return {
    ...actual,
    closeConnection: jest.fn(),
    createRequestConnection: jest.fn().mockResolvedValue({}),
    executeQuery: jest.fn().mockResolvedValue([]),
  };
});

import { upsertFeatureFlag } from "./feature-flags";

const db = require("../db") as { createRequestConnection: jest.Mock; executeQuery: jest.Mock };
const context = new InvocationContext();
const post = (value: unknown): HttpRequest => ({ json: async () => value }) as unknown as HttpRequest;

// The keys of command-centre src/constants/features.ts. A key missing here makes
// Admin -> Features answer 400 and the module can never be switched on.
const FRONTEND_FEATURE_KEYS = [
  "absenceCover",
  "activity",
  "aiAssist",
  "aiDocumentExtraction",
  "assets",
  "comms", "complianceReport", "contractorSuggestions",
  "decisionJobs",
  "emailBroadcast",
  "emailSending",
  "escalations",
  "finance",
  "guidedHelp",
  "inboundTriage",
  "incoming",
  "inspectionJobSuggestions",
  "inspections",
  "jobs",
  "keys",
  "leaseEvents", "libraryAsk",
  "maintenance",
  "maintenanceSpendReport",
  "payroll",
  "procedures",
  "quotes",
  "recurringFaults",
  "rentReviews",
  "teamsAlerts",
  "tenancySchedule",
  "tenancyScheduleReport",
  "tenancyVacancies",
  "timesheets",
  "usageAnalytics",
];

beforeEach(() => {
  jest.clearAllMocks();
  db.executeQuery.mockResolvedValue([]);
  db.createRequestConnection.mockResolvedValue({});
});

describe("upsertFeatureFlag: feature keys", () => {
  it.each(FRONTEND_FEATURE_KEYS)("accepts %s", async (featureKey) => {
    const response = await upsertFeatureFlag(post({ featureKey, roleName: "facilities", visibility: "enabled" }), context);

    expect(response.status).toBe(200);
    expect(response.jsonBody).toEqual({ ok: true });
    const [, , params] = db.executeQuery.mock.calls[0] as [unknown, string, Array<{ name: string; value: unknown }>];
    expect(params).toEqual(
      expect.arrayContaining([
        { name: "FeatureKey", type: expect.anything(), value: featureKey },
        { name: "Visibility", type: expect.anything(), value: "enabled" },
      ]),
    );
  });

  it("lets the assets module be switched on per role", async () => {
    for (const roleName of ["admin", "director", "facilities", "facilities_manager", "accounts", "accounts_manager"]) {
      const response = await upsertFeatureFlag(post({ featureKey: "assets", roleName, visibility: "preview" }), context);
      expect(response.status).toBe(200);
    }
  });

  it("lets Admin / Accounts decision jobs be staged per role: preview for directors first, hidden for the rest", async () => {
    for (const [roleName, visibility] of [["director", "preview"], ["admin", "preview"], ["facilities", "hidden"], ["accounts", "hidden"]]) {
      const response = await upsertFeatureFlag(post({ featureKey: "decisionJobs", roleName, visibility }), context);
      expect(response.status).toBe(200);
    }
    expect(db.executeQuery).toHaveBeenCalledTimes(4);
  });

  it("still rejects a key the frontend does not know", async () => {
    const response = await upsertFeatureFlag(post({ featureKey: "asset", roleName: "facilities", visibility: "enabled" }), context);

    expect(response.status).toBe(400);
    expect(response.jsonBody).toEqual({ error: "Unknown featureKey: asset" });
    expect(db.createRequestConnection).not.toHaveBeenCalled();
  });
});
