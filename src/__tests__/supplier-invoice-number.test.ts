import { SUPPLIER_INVOICE_NUMBER_MAX, parseSupplierInvoiceNumber } from "../supplier-invoice-number";

describe("parseSupplierInvoiceNumber", () => {
  it("keeps the number exactly as given, apart from surrounding whitespace", () => {
    expect(parseSupplierInvoiceNumber("  INV-0041/a b  ")).toEqual({ ok: true, value: "INV-0041/a b" });
    expect(parseSupplierInvoiceNumber("tax inv 00012")).toEqual({ ok: true, value: "tax inv 00012" });
  });

  it("does not fold case, strip characters or truncate to 16", () => {
    const longer = "Ab-12345678901234567890";
    expect(parseSupplierInvoiceNumber(longer)).toEqual({ ok: true, value: longer });
  });

  it("treats undefined as not supplied and null or blank as clear", () => {
    expect(parseSupplierInvoiceNumber(undefined)).toEqual({ ok: true, value: undefined });
    expect(parseSupplierInvoiceNumber(null)).toEqual({ ok: true, value: null });
    expect(parseSupplierInvoiceNumber("")).toEqual({ ok: true, value: null });
    expect(parseSupplierInvoiceNumber("   ")).toEqual({ ok: true, value: null });
  });

  it("accepts exactly 255 characters and rejects 256", () => {
    expect(parseSupplierInvoiceNumber("x".repeat(SUPPLIER_INVOICE_NUMBER_MAX))).toEqual({
      ok: true,
      value: "x".repeat(255),
    });
    expect(parseSupplierInvoiceNumber("x".repeat(256))).toEqual({
      ok: false,
      error: "SupplierInvoiceNumber must be at most 255 characters",
    });
  });

  it("measures the length after trimming", () => {
    expect(parseSupplierInvoiceNumber(` ${"x".repeat(255)} `).ok).toBe(true);
  });

  it.each([[42], [true], [{}], [["a"]]])("rejects a non-string (%j)", (raw) => {
    expect(parseSupplierInvoiceNumber(raw)).toEqual({ ok: false, error: "SupplierInvoiceNumber must be a string" });
  });
});
