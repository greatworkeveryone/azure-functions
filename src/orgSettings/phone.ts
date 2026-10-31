// Australian phone numbers for the after-hours line. Spaces, brackets and dashes are allowed as typed;
// the stored form is the digits with single spaces as the person wrote them. The frontend mirrors the
// rule in src/constants/afterHours.ts: keep the two in sync.

const SHAPES: RegExp[] = [
  /^0[2378]\d{8}$/, //   landline
  /^04\d{8}$/, //       mobile
  /^1300\d{6}$/, //     1300 numbers
  /^1800\d{6}$/, //     1800 numbers
  /^13\d{4}$/, //       13 numbers
  /^\+61[2378]\d{8}$/, // international landline
  /^\+614\d{8}$/, //    international mobile
];

/** The number as it will be stored (trimmed, single spaces), or null when it is not an Australian phone number. */
export function parseAustralianPhone(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim().replace(/\s+/g, " ");
  if (text.length === 0 || text.length > 30 || !/^[0-9+()\-\s]+$/.test(text)) return null;
  const compact = text.replace(/[\s()-]/g, "");
  if (compact.includes("+") && !compact.startsWith("+")) return null;
  return SHAPES.some((shape) => shape.test(compact)) ? text : null;
}
