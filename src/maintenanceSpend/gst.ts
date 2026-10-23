// GST for the Maintenance spend report. Floorplan records each invoice as one total
// that includes GST (the form says "Amount (inc GST)" and MYOB documents are built
// tax inclusive, src/myob/payloads.ts); there is no separate GST column. The report
// shows spend ex GST, so GST is taken back out: one eleventh of a 10% GST-inclusive
// total. Whole cents throughout, so a group's total is exactly the sum of its invoices.

/** A dollar amount as whole cents, or null when it isn't a number. */
export function toCents(amount: unknown): number | null {
  if (amount === null || amount === undefined || amount === "") return null;
  const value = typeof amount === "number" ? amount : Number(amount);
  return Number.isFinite(value) ? Math.round(value * 100) : null;
}

/** A GST-inclusive total less its GST (an eleventh, to the nearest cent), in cents. */
export const exGstCents = (totalCents: number): number => totalCents - Math.round(totalCents / 11);

export const fromCents = (cents: number): number => cents / 100;
