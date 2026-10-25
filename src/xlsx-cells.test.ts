import type ExcelJS from "exceljs";
import { cellValueText } from "./xlsx-cells";

describe("cellValueText", () => {
  it("flattens rich text, hyperlinks and formulas instead of [object Object]", () => {
    expect(cellValueText({ richText: [{ text: "Level " }, { text: "2" }] })).toBe("Level 2");
    expect(cellValueText({ text: "Front door", hyperlink: "https://x.test" })).toBe("Front door");
    expect(cellValueText({ formula: "A1&B1", result: "K-12" } as ExcelJS.CellValue)).toBe("K-12");
    expect(cellValueText({ error: "#N/A" } as ExcelJS.CellValue)).toBe("");
  });

  it("keeps plain strings and null", () => {
    expect(cellValueText("  007 ")).toBe("007");
    expect(cellValueText(null)).toBe("");
    expect(cellValueText(undefined)).toBe("");
  });

  it("restores zero padding from a 000-style number format", () => {
    expect(cellValueText(7, "000")).toBe("007");
    expect(cellValueText(7, "General")).toBe("7");
    expect(cellValueText(1234, "000")).toBe("1234");
  });
});
