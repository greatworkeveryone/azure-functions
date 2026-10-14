// One parser for every money amount a handler receives (DL-14). tedious
// validates Decimal with parseFloat, so "1,500" used to be stored as 1.
// Mirrors FE src/helpers/money.ts — change both.

// Optional "$", digits with optional comma thousands groups, at most 2 dp.
const MONEY_PATTERN = /^\$?\s*(?:\d{1,3}(?:,\d{3})+|\d+|(?=\.\d))(?:\.\d{1,2})?$/;

/** Cents-level tolerance so 0.1 + 0.2 still counts as two decimal places. */
const hasAtMostTwoDecimals = (num: number) =>
  Math.abs(num * 100 - Math.round(num * 100)) < 1e-6;

/**
 * "1,500" → 1500, "$1,500.50" → 1500.5, 1500 → 1500. Null for anything that is
 * not a non-negative amount with at most 2 decimal places.
 */
export function parseMoney(raw: unknown): number | null {
  if (typeof raw === "number") {
    return Number.isFinite(raw) && raw >= 0 && hasAtMostTwoDecimals(raw) ? raw : null;
  }
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!MONEY_PATTERN.test(trimmed)) return null;
  return Number(trimmed.replace(/[$,\s]/g, ""));
}

export type MoneyField =
  | { ok: true; value: number | null | undefined }
  | { ok: false; error: string };

/**
 * A money field from a request body: absent stays absent (undefined, so a
 * patch leaves the column alone), null or blank clears it, anything else must
 * parse or the handler answers 400 with this error.
 */
export function parseMoneyField(raw: unknown, field: string): MoneyField {
  if (raw === undefined) return { ok: true, value: undefined };
  if (raw === null || (typeof raw === "string" && raw.trim() === "")) return { ok: true, value: null };
  const value = parseMoney(raw);
  if (value === null) {
    return { ok: false, error: `${field} must be an amount like 1500 or "1,500.00" (not negative, at most 2 decimal places)` };
  }
  return { ok: true, value };
}
