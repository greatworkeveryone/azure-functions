/// <reference types="jest" />
import { InvocationContext } from "@azure/functions";

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn(), timer: jest.fn() } };
});

jest.mock("../auth", () => {
  const actual = jest.requireActual("../auth");
  return {
    ...actual,
    errorResponse: jest.fn().mockReturnValue({ jsonBody: { error: "Error" }, status: 500 }),
    extractToken: jest.fn().mockReturnValue("mock-token"),
    requireRole: jest.fn().mockResolvedValue(null),
    rolesForRequest: jest.fn().mockResolvedValue(["facilities_manager"]),
    verifiedIdentityFromRequest: jest.fn().mockResolvedValue({ email: "s@rp.com", name: "Simone", oid: "oid-s" }),
  };
});

jest.mock("../db", () => {
  const actual = jest.requireActual("../db");
  return {
    ...actual,
    beginTransaction: jest.fn().mockResolvedValue(undefined),
    closeConnection: jest.fn(),
    commitTransaction: jest.fn().mockResolvedValue(undefined),
    createRequestConnection: jest.fn().mockResolvedValue({}),
    executeQuery: jest.fn().mockResolvedValue([]),
    rollbackTransaction: jest.fn().mockResolvedValue(undefined),
  };
});


import ExcelJS from "exceljs";
import type { HttpRequest } from "@azure/functions";
import { getServiceScheduleTemplate } from "./getServiceScheduleTemplate";
import { importServiceSchedules } from "./importServiceSchedules";
import { IMPORT_HEADERS, MAX_IMPORT_BYTES } from "../serviceScheduleImport";
import { ledgerInserts } from "../__tests__/fixtures/ledgerCalls";
import { callsMatching, get, paramsOf, routeQueries, scheduleRow } from "../__tests__/fixtures/facilitiesHarness";

const auth = require("../auth") as { extractToken: jest.Mock; requireRole: jest.Mock };
const db = require("../db") as { commitTransaction: jest.Mock; executeQuery: jest.Mock };
const context = new InvocationContext();
const INSERT = /INSERT INTO dbo\.ServiceSchedules/;

async function workbook(rows: Array<Array<string | number | Date | null>>): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Schedules");
  ws.addRow([...IMPORT_HEADERS]);
  rows.forEach((row) => ws.addRow(row));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function upload(buffer: Buffer | null, query: Record<string, string> = {}, size?: number): HttpRequest {
  const file = buffer && { arrayBuffer: async () => buffer, name: "schedules.xlsx", size: size ?? buffer.length, type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" };
  return { formData: async () => ({ get: () => file }), headers: new Headers(), query: new URLSearchParams(query) } as unknown as HttpRequest;
}

const ROW_CHILLER = ["Tower A", "CH-01", "Six-monthly chiller service", "HVAC / mechanical", "", "Cool Air", "Y", 6, "months", "28/04/2026", 14, ""];
const ROW_LIGHTS = ["tower a", "", "Monthly exit light test", "Fire & life safety", "All emergency exit lights", "", "N", 1, "months", new Date("2026-01-31T00:00:00Z"), "", "Level 1 to 3"];

beforeEach(() => {
  jest.clearAllMocks();
  auth.requireRole.mockResolvedValue(null);
  jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"], now: new Date("2026-10-14T01:00:00Z") });
  let id = 40;
  routeQueries(db.executeQuery, [
    { match: /SELECT BuildingID, BuildingName, BuildingCode FROM dbo\.Buildings/, rows: [{ BuildingCode: "TWA", BuildingID: 1, BuildingName: "Tower A" }] },
    { match: /FROM dbo\.Assets WHERE ArchivedAt IS NULL AND AssetTag IS NOT NULL/, rows: [{ AssetId: 12, AssetTag: "CH-01", BuildingId: 1 }] },
    { match: /SELECT ContractorID, ContractorName FROM dbo\.Contractors/, rows: [{ ContractorID: 5, ContractorName: "Cool Air" }] },
    { match: INSERT, rows: () => [{ ServiceScheduleId: (id += 1) }] },
    { match: /WHERE s\.ServiceScheduleId = @Id/, rows: (params) => [scheduleRow({ ServiceScheduleId: params.Id })] },
    { match: /FROM dbo\.AppUsers WHERE EntraOid/, rows: [{ UserID: 9 }] },
  ]);
});

afterEach(() => jest.useRealTimers());

describe("importServiceSchedules", () => {
  it("creates every row in one transaction, each ledgered, matching building, asset tag and contractor by name", async () => {
    const response = await importServiceSchedules(upload(await workbook([ROW_CHILLER, ROW_LIGHTS])), context);
    expect(response.status).toBe(200);
    expect(response.jsonBody).toMatchObject({ created: 2 });
    const [chiller, lights] = callsMatching(db.executeQuery, INSERT).map(paramsOf);
    expect(chiller).toMatchObject({ AnchorDate: "2026-04-28", AssetId: 12, BuildingId: 1, ContractorId: 5, IntervalCount: 6, IsContract: true, LeadDays: 14, NextDue: "2026-10-28" });
    expect(lights).toMatchObject({ AnchorDate: "2026-01-31", AssetId: null, IsContract: false, NextDue: "2026-10-31", Notes: "Level 1 to 3", Scope: "All emergency exit lights" });
    expect(ledgerInserts(db.executeQuery).map((row) => row.action)).toEqual(["service_schedule.create", "service_schedule.create"]);
    expect(db.commitTransaction).toHaveBeenCalledTimes(1);
  });

  it("writes nothing when any row is wrong, and says which row and why", async () => {
    const bad = ["Tower B", "CH-09", "", "Plumbing", "", "Nobody", "maybe", 0, "days", "31/02/2026", -1, ""];
    const response = await importServiceSchedules(upload(await workbook([ROW_CHILLER, bad])), context);
    expect(response.status).toBe(400);
    const { errors } = response.jsonBody as { errors: Array<{ error: string; row: number }> };
    expect(errors[0]).toEqual({ error: 'Building "Tower B" not found', row: 3 });
    expect(callsMatching(db.executeQuery, INSERT)).toHaveLength(0);
  });

  it.each([
    [["Tower A", "XX-99", "Service", "Lifts", "", "", "N", 1, "months", "01/01/2026", "", ""], /Asset tag "XX-99" isn't in Tower A/],
    [["Tower A", "", "Service", "Lifts", "", "Nobody", "N", 1, "months", "01/01/2026", "", ""], /Contractor "Nobody" not found/],
    [["Tower A", "", "Service", "Lifts", "", "", "N", 1, "months", "2026-13-01", "", ""], /Anchor date/],
    [["Tower A", "", "Service", "Lifts", "", "", "perhaps", 1, "months", "01/01/2026", "", ""], /Standing contract/],
    [["Tower A", "", "Service", "Lifts", "", "", "N", 1, "months", "01/01/2026", "", ""], /Choose the asset/],
  ])("explains a bad row: %j", async (row, message) => {
    const response = await importServiceSchedules(upload(await workbook([row])), context);
    expect(response.status).toBe(400);
    expect((response.jsonBody as { errors: Array<{ error: string }> }).errors[0].error).toMatch(message);
  });

  it("previews without writing when dryRun=true", async () => {
    const response = await importServiceSchedules(upload(await workbook([ROW_CHILLER]), { dryRun: "true" }), context);
    expect(response.status).toBe(200);
    expect(response.jsonBody).toMatchObject({ created: 0, preview: [{ building: "Tower A", name: "Six-monthly chiller service", nextDue: "2026-10-28", row: 2 }] });
    expect(callsMatching(db.executeQuery, INSERT)).toHaveLength(0);
  });

  it("refuses a file over 10 MB, a missing file and an empty sheet", async () => {
    const small = await workbook([ROW_CHILLER]);
    expect((await importServiceSchedules(upload(small, {}, MAX_IMPORT_BYTES + 1), context)).status).toBe(413);
    expect((await importServiceSchedules(upload(null), context)).status).toBe(400);
    expect((await importServiceSchedules(upload(await workbook([])), context)).status).toBe(400);
  });

  it("is for managers only", async () => {
    auth.requireRole.mockResolvedValueOnce({ jsonBody: { error: "Forbidden" }, status: 403 });
    expect((await importServiceSchedules(upload(await workbook([ROW_CHILLER])), context)).status).toBe(403);
  });
});

describe("getServiceScheduleTemplate", () => {
  it("returns an xlsx with the import headers and the building list", async () => {
    const response = await getServiceScheduleTemplate(get({}), context);
    expect(response.status).toBe(200);
    expect((response.headers as Record<string, string>)["Content-Type"]).toMatch(/spreadsheetml/);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(response.body as unknown as ExcelJS.Buffer);
    const header = (wb.getWorksheet("Schedules")?.getRow(1).values as unknown[]).slice(1);
    expect(header).toEqual([...IMPORT_HEADERS]);
    expect(wb.getWorksheet("_Buildings")?.getRow(1).getCell(1).value).toBe("Tower A");
  });
});
