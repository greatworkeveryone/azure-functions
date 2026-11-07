// exceljs is the single slowest module to load (about 330 ms locally, more on a
// cold Function instance) and only the spreadsheet import/template handlers need
// it, so it loads on first use. Node caches it after that.
import type ExcelJS from "exceljs";

export async function loadExcelJS(): Promise<typeof ExcelJS> {
  return (await import("exceljs")).default;
}
