import type ExcelJS from "exceljs";

/** Plain text of any ExcelJS cell value: rich text, hyperlinks and formulas included. */
export function cellValueText(value: ExcelJS.CellValue, numFmt?: string): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") {
    // A zero-padding format ("000") shows 007 for the stored 7; mirror that.
    return numFmt && /^0+$/.test(numFmt) ? String(value).padStart(numFmt.length, "0") : String(value);
  }
  if (typeof value === "boolean") return String(value);
  if (value instanceof Date) return value.toISOString();
  if ("richText" in value) return value.richText.map((part) => part.text).join("").trim();
  if ("result" in value) return cellValueText(value.result as ExcelJS.CellValue, numFmt);
  if ("error" in value) return "";
  if ("text" in value) return cellValueText(value.text as ExcelJS.CellValue);
  if ("hyperlink" in value) return String(value.hyperlink).trim();
  return "";
}
