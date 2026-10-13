/// <reference types="jest" />
// The shape every money row in the decision ledger shares (LAUNCH-READINESS
// R14). Directors and the CFO read tolerance use, amounts just under a
// threshold, splitting, edits after approval and one person's share of a
// contractor's work straight from the ledger, so a quote, invoice, purchase
// order or payment row has to carry the same facts under the same keys whatever
// the decision:
//
//   every row         jobId, buildingId; `after.amount` (a number) and
//                     `after.contractorId`/`contractorName`; the same two keys in
//                     `before` whenever there is one
//   every adjustment  (an edit, a reversal or a deletion) also, in `after`:
//                     previousAmount, newAmount, delta, deltaPercent and
//                     originalApprovedAmount
//
// The handler suites check every money row their tests write against this
// (moneyShape.check in an afterEach) and finish by asking that each code in the
// registry was written at least once (moneyShape.expectEveryCodeWritten), so a
// new code that drifts, or is never exercised, fails here.

import { LEDGER_ACTIONS } from "../../ledger/actions";
import type { LedgerInsert } from "./ledgerCalls";

const MONEY_PREFIX = /^(invoice|payment|po|quote)\./;

/** Every ledger code about a quote, invoice, purchase order or payment. */
export const MONEY_CODES: readonly string[] = Object.keys(LEDGER_ACTIONS)
  .filter((code) => MONEY_PREFIX.test(code))
  .sort();

/** The codes that change, undo or remove a money record, and so also say how far
 *  the amount moved. */
export const ADJUSTMENT_CODES: readonly string[] = [
  "invoice.approval_reset",
  "invoice.delete",
  "invoice.undo_director_approve",
  "invoice.unmark_myob_created",
  "payment.amount_change",
  "po.delete",
  "po.markers_reset",
  "po.uncomplete",
  "po.unmark_myob_created",
  "quote.approval_reset",
  "quote.delete",
  "quote.unapprove",
  "quote.uncomplete",
];

/** The money codes that are not adjustments: they decide, send, mark or pay. */
export const PLAIN_MONEY_CODES: readonly string[] = [
  "invoice.approve",
  "invoice.director_approve",
  "invoice.director_request_failed",
  "invoice.director_request_sent",
  "invoice.myob_created",
  "invoice.reject",
  "payment.create",
  "payment.myob_applied",
  "po.complete",
  "po.create",
  "po.myob_created",
  "po.send",
  "quote.approve",
  "quote.complete",
  "quote.director_approve",
  "quote.director_reject",
  "quote.director_request_failed",
  "quote.director_request_sent",
  "quote.reject",
];

/** Money codes the registry has, that no handler writes yet (WP20 raises them).
 *  Whoever adds a writer moves the code to the list it belongs in, and every
 *  handler suite then has to write it; moneyRowShape.test.ts fails until they do. */
export const UNWRITTEN_MONEY_CODES: readonly string[] = ["quote.approve_attributed", "quote.attribution_disputed"];

/** The keys an adjustment adds to `after`. */
export const CHANGE_KEYS = ["delta", "deltaPercent", "newAmount", "originalApprovedAmount", "previousAmount"] as const;

export const isMoneyRow = (row: Pick<LedgerInsert, "action">): boolean => MONEY_PREFIX.test(row.action);

type Obj = Record<string, unknown>;
const object = (value: unknown): Obj | null => (typeof value === "object" && value !== null ? (value as Obj) : null);

/**
 * Asserts one row has the shared shape. `contractor: false` and `amount: false`
 * are for a record that really has no contractor or no amount (an internal
 * purchase order, with no cost): the keys are still there, null.
 */
export function expectMoneyRowShape(row: LedgerInsert, options: { amount?: boolean; contractor?: boolean } = {}): void {
  const contractor = options.contractor ?? true;
  const amount = options.amount ?? true;
  const at = `${row.action} on ${String(row.subjectType)} ${String(row.subjectId)}`;
  const after = object(row.after);
  const before = object(row.before);

  // Scope: which job and building the decision was in.
  expect({ at, jobId: typeof row.jobId }).toEqual({ at, jobId: "number" });
  expect({ at, buildingId: typeof row.buildingId }).toEqual({ at, buildingId: "number" });

  // What it was worth and who it was for, in `after`...
  expect({ at, after: after === null ? "none" : "an object" }).toEqual({ at, after: "an object" });
  if (amount) expect({ at, amount: typeof after?.amount }).toEqual({ at, amount: "number" });
  else expect({ at, amount: after !== null && "amount" in after }).toEqual({ at, amount: true });
  expect({ at, contractorId: after !== null && "contractorId" in after }).toEqual({ at, contractorId: true });
  expect({ at, contractorName: after !== null && "contractorName" in after }).toEqual({ at, contractorName: true });
  if (contractor) expect({ at, contractorId: typeof after?.contractorId }).toEqual({ at, contractorId: "number" });

  // ...and in `before`, wherever there is one.
  if (before !== null) {
    expect({ at, contractorId: "contractorId" in before }).toEqual({ at, contractorId: true });
    expect({ at, contractorName: "contractorName" in before }).toEqual({ at, contractorName: true });
    if (contractor) expect({ at, contractorId: typeof before.contractorId }).toEqual({ at, contractorId: "number" });
  }

  if (!ADJUSTMENT_CODES.includes(row.action)) return;

  // An adjustment says how far it moved the amount, to the cent.
  for (const key of CHANGE_KEYS) expect({ at, [key]: after !== null && key in after }).toEqual({ at, [key]: true });
  const previous = after?.previousAmount as number | null;
  const next = after?.newAmount as number | null;
  expect({ at, amount: after?.amount }).toEqual({ at, amount: next });
  const delta = Math.round(((next ?? 0) - (previous ?? 0)) * 100) / 100;
  expect({ at, delta: typeof after?.delta }).toEqual({ at, delta: "number" });
  expect(after?.delta).toBeCloseTo(delta, 2);
  if (previous === null || previous === 0) {
    expect({ at, deltaPercent: after?.deltaPercent }).toEqual({ at, deltaPercent: null });
  } else {
    expect({ at, deltaPercent: typeof after?.deltaPercent }).toEqual({ at, deltaPercent: "number" });
    expect(after?.deltaPercent).toBeCloseTo((delta / previous) * 100, 2);
  }
  const approved = after?.originalApprovedAmount;
  expect({ at, originalApprovedAmount: approved === null || typeof approved === "number" }).toEqual({
    at,
    originalApprovedAmount: true,
  });
}

const relaxed = new Set<"amount" | "contractor">();
const written = new Set<string>();

/** What a handler suite uses to check its rows. One instance per test file. */
export const moneyShape = {
  /** For the current test only: its record has no contractor, or no amount. */
  recordHasNo(...missing: ("amount" | "contractor")[]): void {
    for (const what of missing) relaxed.add(what);
  },

  /** Checks every money row a test wrote; call it from an afterEach. */
  check(rows: readonly LedgerInsert[]): void {
    const options = { amount: !relaxed.has("amount"), contractor: !relaxed.has("contractor") };
    relaxed.clear();
    for (const row of rows) {
      if (!isMoneyRow(row)) continue;
      written.add(row.action);
      expectMoneyRowShape(row, options);
    }
  },

  /** Every code in the registry that starts with one of the prefixes was
   *  written, and so checked, by some test in the file. */
  expectEveryCodeWritten(...prefixes: string[]): void {
    const expected = MONEY_CODES.filter(
      (code) => !UNWRITTEN_MONEY_CODES.includes(code) && prefixes.some((prefix) => code.startsWith(prefix)),
    );
    expect(expected.filter((code) => !written.has(code))).toEqual([]);
  },
};
