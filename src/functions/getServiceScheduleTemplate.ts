// GET /api/getServiceScheduleTemplate
//
// The spreadsheet importServiceSchedules reads: one row per recurring service,
// dropdowns for building, category, unit and Y/N, and an Info sheet saying
// what each column takes. Managers only (they are the ones who import).

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import ExcelJS from "exceljs";
import type { Connection } from "tedious";
import { errorResponse } from "../auth";
import { authorize, errorMessage } from "../assetRegisterSupport";
import { closeConnection, createRequestConnection, executeQuery } from "../db";
import { MANAGE_SERVICE_SCHEDULES_ROLES } from "../facilitiesRoles";
import { DEFAULT_LEAD_DAYS, MAINTENANCE_SERVICES } from "../facilitiesRules";
import { IMPORT_HEADERS, IMPORT_SHEET } from "../serviceScheduleImport";

/** A name starting =, +, -, @ would run as a formula when the file is opened. */
function safeCell(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

const INFO: Array<[string, string]> = [
  ["Building", "The building's name or code, as in Floorplan."],
  ["Asset tag", "The asset's tag in that building (e.g. CH-01). Leave blank when the service isn't for one asset."],
  ["Service name", "What the job will be called, e.g. Six-monthly chiller service."],
  ["Category", MAINTENANCE_SERVICES.join(", ")],
  ["What is serviced (no asset)", "Required when there is no asset tag, e.g. All emergency exit lights."],
  ["Contractor", "Optional; the contractor's name as in Floorplan."],
  ["Standing contract (Y/N)", "Y: the job needs no quote (billed under the contract)."],
  ["Every / Unit", "How often: e.g. 6 and months, or 2 and weeks."],
  ["Anchor date (DD/MM/YYYY)", "A date the service falls on; every due date counts from it."],
  ["Lead days", `How many days before the due date the job is created (blank = ${DEFAULT_LEAD_DAYS}).`],
];

export async function getServiceScheduleTemplate(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const auth = await authorize(request, MANAGE_SERVICE_SCHEDULES_ROLES);
  if (!auth.ok) return auth.response;

  let connection: Connection | undefined;
  try {
    connection = await createRequestConnection(auth.token);
    const rows = await executeQuery(connection, `SELECT BuildingID, BuildingName, BuildingCode FROM dbo.Buildings WHERE Active = 1 ORDER BY BuildingName`, []);
    const names = rows.map((row) => String(row.BuildingName ?? ""));

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(IMPORT_SHEET);
    ws.columns = IMPORT_HEADERS.map((header) => ({ header, key: header, width: Math.max(14, header.length + 2) }));
    // dataValidations exists at runtime but is missing from exceljs 4.x's type declarations.
    const validations = (ws as unknown as { dataValidations: { add: (range: string, rule: unknown) => void } }).dataValidations;
    validations.add("A2:A2000", { allowBlank: false, formulae: [`_Buildings!$A$1:$A$${Math.max(names.length, 1)}`], type: "list" });
    validations.add("D2:D2000", { allowBlank: false, formulae: [`"${MAINTENANCE_SERVICES.join(",")}"`], type: "list" });
    validations.add("G2:G2000", { allowBlank: true, formulae: ['"Y,N"'], type: "list" });
    validations.add("I2:I2000", { allowBlank: false, formulae: ['"weeks,months"'], type: "list" });

    const info = wb.addWorksheet("Info");
    info.addRow(["Column", "What to enter"]);
    INFO.forEach((row) => info.addRow(row));
    info.addRow(["", "One bad row stops the whole import; the error says which row and why."]);
    info.getColumn(1).width = 28;
    info.getColumn(2).width = 90;

    const buildings = wb.addWorksheet("_Buildings", { state: "veryHidden" });
    names.forEach((name) => buildings.addRow([safeCell(name)]));

    return {
      body: Buffer.from(await wb.xlsx.writeBuffer()),
      headers: {
        "Content-Disposition": 'attachment; filename="service-schedules-template.xlsx"',
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
      status: 200,
    };
  } catch (error) {
    context.error("getServiceScheduleTemplate failed:", errorMessage(error));
    return errorResponse("Failed to build the template", error);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("getServiceScheduleTemplate", { authLevel: "anonymous", handler: getServiceScheduleTemplate, methods: ["GET"] });
