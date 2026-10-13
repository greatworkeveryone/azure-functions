// Johanne's rule: the invoice number is "exactly as per the Supplier Invoice".
// It is stored as typed or extracted, only trimmed: never generated, case
// folded or truncated. MYOB's SupplierInvoiceNumber is String(255).

export const SUPPLIER_INVOICE_NUMBER_MAX = 255;

export type SupplierInvoiceNumberResult =
  | {
      ok: true;
      /** undefined: not supplied, leave a stored value alone. null: blank, store NULL. */
      value: string | null | undefined;
    }
  | { ok: false; error: string };

export function parseSupplierInvoiceNumber(raw: unknown): SupplierInvoiceNumberResult {
  if (raw === undefined) return { ok: true, value: undefined };
  if (raw === null) return { ok: true, value: null };
  if (typeof raw !== "string") return { ok: false, error: "SupplierInvoiceNumber must be a string" };
  const value = raw.trim();
  if (value.length > SUPPLIER_INVOICE_NUMBER_MAX) {
    return {
      ok: false,
      error: `SupplierInvoiceNumber must be at most ${SUPPLIER_INVOICE_NUMBER_MAX} characters`,
    };
  }
  return { ok: true, value: value === "" ? null : value };
}
