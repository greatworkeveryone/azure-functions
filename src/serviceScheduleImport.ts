// Importing service schedules from a spreadsheet (WP50; sprint F2). Adam's
// current servicing lives in spreadsheets; the template (getServiceScheduleTemplate)
// has these columns, and importServiceSchedules reads them back. Buildings,
// asset tags and contractors are matched by name; every row is checked before
// anything is written, and one bad row means nothing is imported.

import ExcelJS from "exceljs";
import { TYPES, type Connection } from "tedious";
import { executeQuery } from "./db";
import { parseScheduleInput, type ScheduleInput } from "./serviceSchedules";
import { assertSafeXlsx } from "./xlsx-safe";

export const IMPORT_HEADERS = [
  "Building",
  "Asset tag",
  "Service name",
  "Category",
  "What is serviced (no asset)",
  "Contractor",
  "Standing contract (Y or N)",
  "Every",
  "Unit (weeks or months)",
  "Service date (DD/MM/YYYY)",
  "Create the job (days before due)",
  "Last serviced (DD/MM/YYYY)",
  "Notes",
] as const;
type Header = (typeof IMPORT_HEADERS)[number];

export const MAX_IMPORT_BYTES = 10 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 2000;
export const IMPORT_SHEET = "Schedules";

export type ImportCell = Date | number | string | null;
export interface ImportRow {
  cells: Record<Header, ImportCell>;
  row: number;
}

function cellValue(value: ExcelJS.CellValue): ImportCell {
  if (value === null || value === undefined) return null;
  if (value instanceof Date || typeof value === "number") return value;
  if (typeof value === "object" && "text" in value) return String(value.text);
  if (typeof value === "object" && "result" in value) return cellValue(value.result as ExcelJS.CellValue);
  return String(value).trim();
}

/** The data rows of the first non-hidden sheet (row numbers as Excel shows them). */
export async function readImportRows(buffer: Buffer): Promise<ImportRow[]> {
  // Throws XlsxRejectedError for a zip bomb or a file that isn't an .xlsx.
  assertSafeXlsx(buffer);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  const ws = wb.getWorksheet(IMPORT_SHEET) ?? wb.worksheets.find((sheet) => !sheet.name.startsWith("_"));
  if (!ws) return [];
  const columns = new Map<string, number>();
  ws.getRow(1).eachCell((cell, column) => columns.set(String(cell.value ?? "").trim(), column));
  const rows: ImportRow[] = [];
  ws.eachRow((row, number) => {
    if (number === 1) return;
    const cells = Object.fromEntries(
      IMPORT_HEADERS.map((header) => [header, columns.has(header) ? cellValue(row.getCell(columns.get(header) as number).value) : null]),
    ) as Record<Header, ImportCell>;
    if (Object.values(cells).some((cell) => cell !== null && cell !== "")) rows.push({ cells, row: number });
  });
  return rows;
}

export const CONTRACTOR_LIST = `SELECT ContractorID, ContractorName FROM dbo.Contractors WHERE Active = @Active ORDER BY ContractorName`;

export interface ImportLookups {
  assets: Array<{ assetId: number; buildingId: number; tag: string }>;
  buildings: Array<{ code: string | null; id: number; name: string }>;
  contractors: Array<{ id: number; name: string }>;
}

export async function loadImportLookups(connection: Connection): Promise<ImportLookups> {
  const buildings = await executeQuery(connection, `SELECT BuildingID, BuildingName, BuildingCode FROM dbo.Buildings WHERE Active = 1`, []);
  const assets = await executeQuery(
    connection,
    `SELECT AssetId, BuildingId, AssetTag FROM dbo.Assets WHERE ArchivedAt IS NULL AND AssetTag IS NOT NULL`,
    [],
  );
  const contractors = await executeQuery(connection, CONTRACTOR_LIST, [
    { name: "Active", type: TYPES.Bit, value: true },
  ]);
  return {
    assets: assets.map((row) => ({ assetId: Number(row.AssetId), buildingId: Number(row.BuildingId), tag: String(row.AssetTag) })),
    buildings: buildings.map((row) => ({ code: row.BuildingCode == null ? null : String(row.BuildingCode), id: Number(row.BuildingID), name: String(row.BuildingName ?? "") })),
    contractors: contractors.map((row) => ({ id: Number(row.ContractorID), name: String(row.ContractorName ?? "") })),
  };
}

const norm = (value: unknown): string => String(value ?? "").trim().toLowerCase();
const text = (cell: ImportCell): string => (cell instanceof Date ? cell.toISOString().slice(0, 10) : String(cell ?? "").trim());

/** A date cell, "DD/MM/YYYY" or "YYYY-MM-DD", as an ISO date; null when it isn't a real date. */
export function importDate(cell: ImportCell): string | null {
  if (cell instanceof Date) return Number.isNaN(cell.getTime()) ? null : cell.toISOString().slice(0, 10);
  const raw = text(cell);
  const dmy = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  const iso = dmy ? `${dmy[3]}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}` : raw;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const date = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === iso ? iso : null;
}

type RowResult = { buildingName: string; lastServiced: string | null; ok: true; value: ScheduleInput } | { error: string; ok: false };

export function rowToInput(row: ImportRow, lookups: ImportLookups, today: string): RowResult {
  const c = row.cells;
  const fail = (error: string): RowResult => ({ error, ok: false });
  const buildingText = text(c.Building);
  const building = lookups.buildings.find((b) => norm(b.name) === norm(buildingText) || (b.code !== null && norm(b.code) === norm(buildingText)));
  if (!building) return fail(`Building "${buildingText}" not found`);
  const tag = text(c["Asset tag"]);
  const asset = tag ? lookups.assets.find((a) => a.buildingId === building.id && norm(a.tag) === norm(tag)) : null;
  if (tag && !asset) return fail(`Asset tag "${tag}" isn't in ${building.name}`);
  const contractorText = text(c.Contractor);
  const contractor = contractorText ? lookups.contractors.find((k) => norm(k.name) === norm(contractorText)) : null;
  if (contractorText && !contractor) return fail(`Contractor "${contractorText}" not found. Use a name from the template's list.`);
  const yn = norm(c["Standing contract (Y or N)"]);
  if (!["", "y", "yes", "n", "no"].includes(yn)) return fail("Standing contract must be Y or N");
  const anchor = importDate(c["Service date (DD/MM/YYYY)"]);
  if (!anchor) return fail("Service date must be a date, DD/MM/YYYY");
  const lastText = text(c["Last serviced (DD/MM/YYYY)"]);
  const lastServiced = lastText ? importDate(c["Last serviced (DD/MM/YYYY)"]) : null;
  if (lastText && !lastServiced) return fail("Last serviced must be a date, DD/MM/YYYY, or left blank");
  if (lastServiced && lastServiced > today) return fail("Last serviced can't be after today");
  const unit = norm(c["Unit (weeks or months)"]).replace(/^(week|month)$/, "$1s");
  const leadText = text(c["Create the job (days before due)"]);
  const parsed = parseScheduleInput({
    anchorDate: anchor,
    assetId: asset?.assetId ?? null,
    buildingId: building.id,
    category: text(c.Category),
    contractorId: contractor?.id ?? null,
    intervalCount: Number(text(c.Every)),
    intervalUnit: unit,
    isContract: yn === "y" || yn === "yes",
    leadDays: leadText === "" ? undefined : Number(leadText),
    name: text(c["Service name"]),
    notes: text(c.Notes) || null,
    scope: text(c["What is serviced (no asset)"]) || null,
  });
  return parsed.ok ? { buildingName: building.name, lastServiced, ok: true, value: parsed.value } : fail(parsed.error);
}
