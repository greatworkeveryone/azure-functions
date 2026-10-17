/// <reference types="jest" />
// One shape for every money row (LAUNCH-READINESS R14): directors and the CFO
// read tolerance use, amounts just under a threshold, splitting, edits after
// approval and one person's share of a contractor's work straight from the
// ledger, so a quote, invoice, purchase order or payment row carries the same
// facts under the same keys whatever the decision. See the fixture for the
// contract; the handler suites check every row they write against it. This file
// keeps the contract itself honest.
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import type { LedgerInsert } from "../__tests__/fixtures/ledgerCalls";
import {
  ADJUSTMENT_CODES,
  expectMoneyRowShape,
  MONEY_CODES,
  PLAIN_MONEY_CODES,
  UNWRITTEN_MONEY_CODES,
} from "../__tests__/fixtures/moneyRowShape";
import { LEDGER_ACTIONS } from "./actions";
import {
  amountChange,
  approvalSnapshot,
  deletionAfter,
  invoiceFacts,
  invoiceSnapshot,
  paymentEdit,
  paymentFacts,
  purchaseOrderFacts,
  purchaseOrderMarkers,
  purchaseOrderSnapshot,
  quoteFacts,
  quoteSnapshot,
} from "./moneyDecisions";

const SRC = join(__dirname, "..");

describe("every money code in the registry is classified", () => {
  it("is a plain decision, an adjustment, or one no handler writes yet: nothing else, nothing twice", () => {
    const classified = [...PLAIN_MONEY_CODES, ...ADJUSTMENT_CODES, ...UNWRITTEN_MONEY_CODES].sort();

    expect(classified).toEqual([...MONEY_CODES]);
    expect(new Set(classified).size).toBe(classified.length);
  });

  it("names only codes the registry has", () => {
    for (const code of [...PLAIN_MONEY_CODES, ...ADJUSTMENT_CODES, ...UNWRITTEN_MONEY_CODES]) {
      expect(Object.keys(LEDGER_ACTIONS)).toContain(code);
    }
  });

  it("an adjustment is a change, a reversal or a deletion: every one is an exception", () => {
    for (const code of ADJUSTMENT_CODES) {
      expect({ code, exception: (LEDGER_ACTIONS as Record<string, { exception: boolean }>)[code].exception }).toEqual({
        code,
        exception: true,
      });
    }
  });

  it("a code listed as unwritten really has no writer yet, so it can't dodge the checks once it does", () => {
    const sources = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) return entry.name === "__tests__" ? [] : sources(path);
        return /\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name) && entry.name !== "actions.ts" ? [path] : [];
      });
    const text = sources(SRC)
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");

    for (const code of UNWRITTEN_MONEY_CODES) {
      expect({ code, written: text.includes(`"${code}"`) }).toEqual({ code, written: false });
    }
  });
});

describe("each handler suite checks every money row it writes, and that each code was written", () => {
  const suites: [file: string, prefix: string][] = [
    ["functions/invoices.ledger.test.ts", "invoice."],
    ["functions/payments.ledger.test.ts", "payment."],
    ["functions/purchaseOrders.ledger.test.ts", "po."],
    ["functions/quotes.ledger.test.ts", "quote."],
  ];

  it.each(suites)("%s", (file, prefix) => {
    const text = readFileSync(join(SRC, file), "utf8");

    expect(text).toContain("moneyShape.check(ledgerInserts(db.executeQuery))");
    expect(text).toContain(`moneyShape.expectEveryCodeWritten("${prefix}")`);
  });

  it.each(["functions/emails.ledger.test.ts", "email/director-requests.test.ts"])("%s checks its rows too", (file) => {
    expect(readFileSync(join(SRC, file), "utf8")).toContain("moneyShape.check(ledgerInserts(db.executeQuery))");
  });
});

describe("the builders every row is made from agree on the keys", () => {
  // A bare row: whatever a builder does not find, it still names, as null.
  const bare = {};

  it.each([
    ["quoteFacts", quoteFacts(bare)],
    ["invoiceFacts", invoiceFacts(bare)],
    ["purchaseOrderFacts", purchaseOrderFacts(bare)],
    ["paymentFacts", paymentFacts(bare)],
    ["quoteSnapshot", quoteSnapshot(bare)],
    ["invoiceSnapshot", invoiceSnapshot(bare)],
    ["purchaseOrderSnapshot", purchaseOrderSnapshot(bare)],
    ["approvalSnapshot", approvalSnapshot(bare)],
    ["purchaseOrderMarkers", purchaseOrderMarkers(bare, { myob: false, sent: false })],
    ["paymentEdit.before", paymentEdit(bare, 1).before],
    ["paymentEdit.after", paymentEdit(bare, 1).after],
    ["deletionAfter", deletionAfter({})],
  ])("%s names the amount's contractor, by id and by name", (_name, built) => {
    expect(built).toHaveProperty("contractorId", null);
    expect(built).toHaveProperty("contractorName", null);
  });

  it.each([
    ["quoteFacts", quoteFacts(bare)],
    ["invoiceFacts", invoiceFacts(bare)],
    ["purchaseOrderFacts", purchaseOrderFacts(bare)],
    ["paymentFacts", paymentFacts(bare)],
    ["quoteSnapshot", quoteSnapshot(bare)],
    ["invoiceSnapshot", invoiceSnapshot(bare)],
    ["purchaseOrderSnapshot", purchaseOrderSnapshot(bare)],
    ["approvalSnapshot", approvalSnapshot(bare)],
    ["purchaseOrderMarkers", purchaseOrderMarkers(bare, { myob: false, sent: false })],
    ["paymentEdit.after", paymentEdit(bare, 1).after],
    ["deletionAfter", deletionAfter({})],
  ])("%s says what the record is worth in `amount`", (_name, built) => {
    expect(built).toHaveProperty("amount");
  });

  it("an adjustment's size is the same five keys, whichever builder made it", () => {
    const keys = Object.keys(amountChange({ next: 1, previous: 1 })).sort();
    expect(keys).toEqual(["delta", "deltaPercent", "newAmount", "originalApprovedAmount", "previousAmount"]);
    for (const built of [paymentEdit(bare, 1).after, deletionAfter({})]) {
      for (const key of keys) expect(built).toHaveProperty(key);
    }
  });
});

describe("expectMoneyRowShape itself: a row that drifts is caught", () => {
  const plain = (over: Partial<LedgerInsert> = {}): LedgerInsert =>
    ({
      action: "quote.approve",
      after: { amount: 500, contractorId: 3, contractorName: "Acme", status: "approved" },
      before: { contractorId: 3, contractorName: "Acme", status: "pending" },
      buildingId: 5,
      jobId: 9,
      order: 1,
      subjectId: "7",
      subjectType: "quote",
      ...over,
    }) as LedgerInsert;
  const adjustment = (after: Record<string, unknown> = {}, over: Partial<LedgerInsert> = {}): LedgerInsert =>
    plain({
      action: "quote.approval_reset",
      after: {
        amount: 600,
        contractorId: 3,
        contractorName: "Acme",
        delta: 100,
        deltaPercent: 20,
        newAmount: 600,
        originalApprovedAmount: 500,
        previousAmount: 500,
        ...after,
      },
      ...over,
    });

  it("passes a plain row and an adjustment that have everything", () => {
    expect(() => expectMoneyRowShape(plain())).not.toThrow();
    expect(() => expectMoneyRowShape(adjustment())).not.toThrow();
  });

  it("passes a deletion that goes to nothing, and a record with no contractor or amount when told so", () => {
    expect(() =>
      expectMoneyRowShape(
        adjustment({ amount: 0, delta: -500, deltaPercent: -100, newAmount: 0, previousAmount: 500 }, { action: "quote.delete" }),
      ),
    ).not.toThrow();
    expect(() =>
      expectMoneyRowShape(plain({ after: { amount: null, contractorId: null, contractorName: null }, before: null }), {
        amount: false,
        contractor: false,
      }),
    ).not.toThrow();
  });

  it.each([
    ["no job", plain({ jobId: null })],
    ["no building", plain({ buildingId: undefined })],
    ["no after", plain({ after: null })],
    ["an amount that is not a number", plain({ after: { amount: "500", contractorId: 3, contractorName: "Acme" } })],
    ["no contractor id", plain({ after: { amount: 500, contractorName: "Acme" } })],
    ["a contractor id that is null for a record with a contractor", plain({ after: { amount: 500, contractorId: null, contractorName: "Acme" } })],
    ["no contractor name", plain({ after: { amount: 500, contractorId: 3 } })],
    ["a before without the contractor", plain({ before: { status: "pending" } })],
  ])("fails a row with %s", (_name, row) => {
    expect(() => expectMoneyRowShape(row)).toThrow();
  });

  it.each([
    ["no previousAmount", { previousAmount: undefined }],
    ["no newAmount", { newAmount: undefined }],
    ["no delta", { delta: undefined }],
    ["no deltaPercent", { deltaPercent: undefined }],
    ["no originalApprovedAmount", { originalApprovedAmount: undefined }],
    ["a newAmount that is not the amount", { newAmount: 700 }],
    ["a delta that is not new - previous", { delta: 90 }],
    ["a deltaPercent that is not delta over previous", { deltaPercent: 25 }],
    ["a percentage where the previous amount was nothing", { delta: 600, deltaPercent: 100, previousAmount: 0 }],
  ])("fails an adjustment with %s", (_name, after) => {
    const complete = adjustment().after as Record<string, unknown>;
    const drifted: Record<string, unknown> = { ...complete, ...after };
    for (const [key, value] of Object.entries(after)) if (value === undefined) delete drifted[key];

    expect(() => expectMoneyRowShape(plain({ action: "quote.approval_reset", after: drifted }))).toThrow();
  });

  it("holds an adjustment to the change keys, but not a plain decision", () => {
    const withoutChange = { amount: 500, contractorId: 3, contractorName: "Acme" };

    expect(() => expectMoneyRowShape(plain({ after: withoutChange }))).not.toThrow();
    expect(() => expectMoneyRowShape(plain({ action: "quote.unapprove", after: withoutChange }))).toThrow();
  });
});
