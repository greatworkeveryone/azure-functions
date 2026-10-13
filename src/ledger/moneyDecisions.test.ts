/// <reference types="jest" />
import type { Connection } from "tedious";
import { assertLedgerEntry, LEDGER_ACTIONS } from "./index";
import {
  approvalRule,
  invoiceFacts,
  jobScope,
  ledgerReason,
  paymentFacts,
  purchaseOrderFacts,
  quoteFacts,
} from "./moneyDecisions";

jest.mock("../db", () => ({ executeQuery: jest.fn() }));

const db = require("../db") as { executeQuery: jest.Mock };
const connection = {} as Connection;

beforeEach(() => {
  jest.clearAllMocks();
});

describe("jobScope", () => {
  it("reads the building from the job the decision belongs to", async () => {
    db.executeQuery.mockResolvedValue([{ BuildingID: 5 }]);

    await expect(jobScope(connection, 99)).resolves.toEqual({ buildingId: 5, jobId: 99 });

    const [conn, sql, params] = db.executeQuery.mock.calls[0];
    expect(conn).toBe(connection);
    expect(sql).toBe("SELECT BuildingID FROM Jobs WHERE JobID = @JobID");
    expect(params).toEqual([expect.objectContaining({ name: "JobID", value: 99 })]);
  });

  it("keeps the job when the building can't be found", async () => {
    db.executeQuery.mockResolvedValue([]);
    await expect(jobScope(connection, 99)).resolves.toEqual({ buildingId: null, jobId: 99 });
  });

  it.each([null, undefined])("asks nothing about %p", async (jobId) => {
    await expect(jobScope(connection, jobId)).resolves.toEqual({ buildingId: null, jobId: null });
    expect(db.executeQuery).not.toHaveBeenCalled();
  });
});

describe("ledgerReason", () => {
  it("trims a note, and returns nothing for blank or non-text", () => {
    expect(ledgerReason("  Subject to council sign-off ")).toBe("Subject to council sign-off");
    expect(ledgerReason("   ")).toBeUndefined();
    expect(ledgerReason(undefined)).toBeUndefined();
    expect(ledgerReason(null)).toBeUndefined();
    expect(ledgerReason(42)).toBeUndefined();
  });

  it("clips a note the endpoint accepted but the ledger column can't hold, rather than failing the decision", () => {
    const note = "a".repeat(4000);
    const reason = ledgerReason(note);

    expect(reason).toHaveLength(2000);
    expect(() =>
      assertLedgerEntry({
        action: "quote.director_reject",
        actor: { kind: "user", name: "Ops User", role: "accounts_manager", userId: 1 },
        reason,
        subject: { id: 7, type: "quote" },
      }),
    ).not.toThrow();
  });
});

describe("approvalRule", () => {
  it("names the director threshold whenever the director gate engages", () => {
    expect(approvalRule({ directorNeeded: true, userCanApprove: true })).toBe("director_threshold");
    expect(approvalRule({ directorNeeded: true, userCanApprove: false })).toBe("director_threshold");
  });

  it("otherwise says whether the caller's own authority covered it", () => {
    expect(approvalRule({ directorNeeded: false, userCanApprove: true })).toBe("own_authority");
    expect(approvalRule({ directorNeeded: false, userCanApprove: false })).toBe("over_limit");
  });
});

describe("snapshots of what a decision was about", () => {
  it("quote: amount, who the money goes to, and the document's number", () => {
    expect(
      quoteFacts({ Amount: "1200.5", ContractorID: 3, ContractorName: "Acme", Currency: "AUD", QuoteNumber: "QT-9-1", Status: "x" }),
    ).toEqual({ amount: 1200.5, contractorId: 3, contractorName: "Acme", currency: "AUD", quoteNumber: "QT-9-1" });
  });

  it("keeps a stable shape when columns are missing: nulls, never NaN or undefined", () => {
    expect(quoteFacts({})).toEqual({ amount: null, contractorId: null, contractorName: null, currency: null, quoteNumber: null });
    expect(quoteFacts({ Amount: "n/a" }).amount).toBeNull();
    expect(JSON.parse(JSON.stringify(invoiceFacts({})))).toEqual({
      amount: null,
      contractorName: null,
      direction: null,
      invoiceNumber: null,
      supplierInvoiceNumber: null,
    });
  });

  it("invoice: includes the supplier's own invoice number", () => {
    expect(
      invoiceFacts({ Amount: 500, ContractorName: "Acme", Direction: "incoming", InvoiceNumber: "IV-9-1", SupplierInvoiceNumber: "INV-0042" }),
    ).toEqual({
      amount: 500,
      contractorName: "Acme",
      direction: "incoming",
      invoiceNumber: "IV-9-1",
      supplierInvoiceNumber: "INV-0042",
    });
  });

  it("purchase order: the cost limits and the contractor", () => {
    expect(
      purchaseOrderFacts({ ContractorID: 4, ContractorName: "Acme", CostNotToExceed: 900, EstimatedCost: 800, PONumber: "66Se261013" }),
    ).toEqual({ contractorId: 4, contractorName: "Acme", costNotToExceed: 900, estimatedCost: 800, poNumber: "66Se261013" });
  });

  it("payment: the amount, the documents it pays, and who the invoice says the money goes to", () => {
    const payment = { Amount: 100, JobInvoiceID: 5, MyobID: "bill-uid", PurchaseOrderID: null, QuoteID: 7 };

    expect(
      paymentFacts(payment, { ContractorName: "Acme", InvoiceNumber: "IV-9-1", SupplierInvoiceNumber: "INV-0042" }),
    ).toEqual({
      amount: 100,
      contractorName: "Acme",
      invoiceNumber: "IV-9-1",
      jobInvoiceId: 5,
      myobBillUid: "bill-uid",
      purchaseOrderId: null,
      quoteId: 7,
      supplierInvoiceNumber: "INV-0042",
    });
    expect(paymentFacts(payment)).toMatchObject({ contractorName: null, invoiceNumber: null, supplierInvoiceNumber: null });
  });
});

describe("the money decision codes", () => {
  const codes = [
    "invoice.approve",
    "invoice.director_approve",
    "invoice.myob_created",
    "invoice.reject",
    "payment.myob_applied",
    "po.create",
    "po.send",
    "quote.approve",
    "quote.director_approve",
    "quote.director_reject",
    "quote.reject",
  ] as const;

  it.each(codes)("%s is a plain decision: not an exception, no reason demanded", (code) => {
    expect(LEDGER_ACTIONS[code]).toMatchObject({ exception: false, reasonRequired: false });
  });

  it("each applies to its own kind of record only", () => {
    expect(LEDGER_ACTIONS["quote.approve"].subjects).toEqual(["quote"]);
    expect(LEDGER_ACTIONS["invoice.myob_created"].subjects).toEqual(["invoice"]);
    expect(LEDGER_ACTIONS["payment.myob_applied"].subjects).toEqual(["payment"]);
    expect(LEDGER_ACTIONS["po.send"].subjects).toEqual(["purchase_order"]);
    expect(() =>
      assertLedgerEntry({
        action: "invoice.approve",
        actor: { kind: "user", name: "Ops User", role: "accounts_manager", userId: 1 },
        subject: { id: 7, type: "quote" },
      }),
    ).toThrow(/does not apply to a quote/);
  });
});
