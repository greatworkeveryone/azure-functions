/// <reference types="jest" />
// TR5: the tenancy's requests and charges. The handler runs against a mocked
// executeQuery that routes on the SQL text; the shaping is also tested pure.
import type { InvocationContext } from "@azure/functions";
import { clearRoleCache } from "../auth";
import { getTenancyActivity } from "../functions/getTenancyActivity";
import { buildTenancyActivity } from "../tenancyActivity/build";
import { getRequest } from "./fixtures/rentReviewFakes";

jest.mock("../db", () => ({ closeConnection: jest.fn(), createRequestConnection: jest.fn().mockResolvedValue({}), executeQuery: jest.fn() }));
const { executeQuery } = jest.requireMock("../db") as { executeQuery: jest.Mock };
const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;

const JOBS = [
  { CreatedAt: new Date("2026-10-20T01:00:00Z"), IsOnchargeable: true, JobCode: "J-101", JobID: 101, OnchargeAmount: 1234.5, Status: "Work", Title: "Burst pipe", WorkRequestID: 55 },
  { CreatedAt: new Date("2026-09-01T01:00:00Z"), IsOnchargeable: false, JobCode: "J-90", JobID: 90, OnchargeAmount: null, Status: "Done", Title: "Light", WorkRequestID: null },
];
const WRS = [
  { CreatedAt: new Date("2026-10-25T01:00:00Z"), Details: "Leak in suite", SourceHost: null, Status: "Open", WorkRequestID: 55 },
  { CreatedAt: new Date("2026-10-28T01:00:00Z"), Details: "Aircon", SourceHost: "floorplan", Status: "New", WorkRequestID: -3 },
];

beforeEach(() => {
  jest.clearAllMocks();
  clearRoleCache();
  process.env.DEV_ROLE_OVERRIDE_ENABLED = "true";
  process.env.AZURE_FUNCTIONS_ENVIRONMENT = "Development";
  executeQuery.mockImplementation(async (_c: unknown, sql: string) => {
    if (sql.includes("FROM dbo.Tenants")) return [{ BuildingId: 1, LegalName: "Acme Pty Ltd", TradingName: "Acme" }];
    if (sql.includes("COL_LENGTH")) return [{ Len: null }];
    if (sql.includes("FROM WorkRequests")) return WRS;
    if (sql.includes("FROM Jobs")) return JOBS;
    return [];
  });
});

const body = (res: { jsonBody?: unknown }) => res.jsonBody as Record<string, any>;

describe("getTenancyActivity", () => {
  it("lists requests, jobs and on-charges newest first; the on-charge amount is the job's", async () => {
    const res = await getTenancyActivity(getRequest({ tenantId: "7" }, "accounts"), ctx);
    expect(res.status).toBe(200);
    expect(body(res).items.map((i: any) => i.id)).toEqual(["wr--3", "wr-55", "job-101", "oncharge-101", "job-90"]);
    expect(body(res).items.find((i: any) => i.type === "on_charge")).toMatchObject({ amount: 1234.5, jobId: 101, reference: "J-101" });
    expect(body(res).items[0]).toMatchObject({ reference: "FP-3", source: "floorplan" });
    expect(body(res).invoices).toEqual([]);
  });

  it("refuses facilities, bad ids and unknown tenancies", async () => {
    expect((await getTenancyActivity(getRequest({ tenantId: "7" }, "facilities"), ctx)).status).toBe(403);
    expect((await getTenancyActivity(getRequest({ tenantId: "x" }, "accounts"), ctx)).status).toBe(400);
    executeQuery.mockResolvedValueOnce([]);
    expect((await getTenancyActivity(getRequest({ tenantId: "7" }, "accounts"), ctx)).status).toBe(404);
  });

  it("shows the intake state when the column exists", async () => {
    executeQuery.mockImplementation(async (_c: unknown, sql: string) => {
      if (sql.includes("FROM dbo.Tenants")) return [{ BuildingId: 1, LegalName: "A", TradingName: null }];
      if (sql.includes("COL_LENGTH")) return [{ Len: 40 }];
      if (sql.includes("IntakeState FROM")) return [{ IntakeState: "Assessing", WorkRequestID: 55 }];
      if (sql.includes("FROM WorkRequests")) return [{ ...WRS[0] }];
      return [];
    });
    const res = await getTenancyActivity(getRequest({ tenantId: "7" }, "accounts"), ctx);
    expect(body(res).items[0]).toMatchObject({ intakeState: "Assessing", isOpen: true });
  });
});

describe("buildTenancyActivity", () => {
  it("withholds amounts when the caller may not see them", () => {
    const out = buildTenancyActivity([], JOBS, false);
    expect(out.items.find((i) => i.type === "on_charge")?.amount).toBeNull();
  });

  it("caps the list and says so", () => {
    const out = buildTenancyActivity(WRS, JOBS, true, 2);
    expect(out.items).toHaveLength(2);
    expect(out.truncated).toBe(true);
  });

  it("treats Done jobs and completed requests as closed", () => {
    const out = buildTenancyActivity([{ ...WRS[0], Status: "Completed" }], JOBS, true);
    expect(out.items.filter((i) => !i.isOpen).map((i) => i.id).sort()).toEqual(["job-90", "wr-55"]);
  });
});
