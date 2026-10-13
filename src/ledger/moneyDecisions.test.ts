/// <reference types="jest" />
import type { Connection } from "tedious";
import { assertLedgerEntry, LEDGER_ACTIONS } from "./index";
import {
  approvalRule,
  approvalSnapshot,
  invoiceFacts,
  invoiceSnapshot,
  jobScope,
  ledgerReason,
  paymentEdit,
  paymentFacts,
  purchaseOrderFacts,
  purchaseOrderMarkers,
  purchaseOrderSnapshot,
  quoteFacts,
  quoteSnapshot,
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

describe("snapshots of a record as it stood", () => {
  it("quote: the facts, its status and the approvals a reversal clears or a deletion takes with it", () => {
    expect(
      quoteSnapshot({
        Amount: 500,
        ApprovedAt: new Date("2026-10-01T02:03:04Z"),
        ApprovedBy: "Pat Approver",
        ContractorID: 3,
        ContractorName: "Acme",
        Currency: "AUD",
        DirectorApprovedAt: null,
        DirectorApprovedBy: null,
        QuoteNumber: "QT-9-1",
        QuotePDFBlobName: "quotes/7.pdf",
        Status: "awaiting_director",
      }),
    ).toEqual({
      amount: 500,
      approvedAt: "2026-10-01T02:03:04.000Z",
      approvedBy: "Pat Approver",
      contractorId: 3,
      contractorName: "Acme",
      currency: "AUD",
      directorApprovedAt: null,
      directorApprovedBy: null,
      pdfBlobName: "quotes/7.pdf",
      quoteNumber: "QT-9-1",
      status: "awaiting_director",
    });
  });

  it("invoice: also the supplier's invoice number, the MYOB marking and the file reference", () => {
    expect(
      invoiceSnapshot({
        Amount: 750,
        ApprovedAt: new Date("2026-10-01T00:00:00Z"),
        ApprovedBy: "Pat Approver",
        ContractorName: "Acme",
        Currency: "AUD",
        Direction: "incoming",
        DirectorApprovedAt: new Date("2026-10-02T00:00:00Z"),
        DirectorApprovedBy: "Dana Director",
        InvoiceNumber: "IV-9-1",
        InvoicePDFBlobName: "invoices/5.pdf",
        MyobCreatedAt: new Date("2026-10-03T00:00:00Z"),
        MyobCreatedBy: "Casey Controller",
        Status: "director_approved",
        SupplierInvoiceNumber: "INV-0042",
      }),
    ).toEqual({
      amount: 750,
      approvedAt: "2026-10-01T00:00:00.000Z",
      approvedBy: "Pat Approver",
      contractorName: "Acme",
      currency: "AUD",
      direction: "incoming",
      directorApprovedAt: "2026-10-02T00:00:00.000Z",
      directorApprovedBy: "Dana Director",
      invoiceNumber: "IV-9-1",
      myobCreatedAt: "2026-10-03T00:00:00.000Z",
      myobCreatedBy: "Casey Controller",
      pdfBlobName: "invoices/5.pdf",
      status: "director_approved",
      supplierInvoiceNumber: "INV-0042",
    });
  });

  it("purchase order: also when it was sent, marked in MYOB and completed, and by whom", () => {
    expect(
      purchaseOrderSnapshot({
        CompletedAt: new Date("2026-10-05T00:00:00Z"),
        CompletedBy: "Fred Facilities",
        ContractorID: 3,
        ContractorName: "Acme",
        CostNotToExceed: 900,
        EstimatedCost: 800,
        MyobCreatedAt: new Date("2026-10-03T00:00:00Z"),
        MyobCreatedBy: "Fred Facilities",
        PDFBlobName: "po/99.pdf",
        PONumber: "66Se261013",
        SentAt: new Date("2026-10-04T00:00:00Z"),
        SentBy: "Fred Facilities",
      }),
    ).toEqual({
      completedAt: "2026-10-05T00:00:00.000Z",
      completedBy: "Fred Facilities",
      contractorId: 3,
      contractorName: "Acme",
      costNotToExceed: 900,
      estimatedCost: 800,
      myobCreatedAt: "2026-10-03T00:00:00.000Z",
      myobCreatedBy: "Fred Facilities",
      pdfBlobName: "po/99.pdf",
      poNumber: "66Se261013",
      sentAt: "2026-10-04T00:00:00.000Z",
      sentBy: "Fred Facilities",
    });
  });

  it("keeps a stable shape for a bare row: nulls, never undefined or an invalid date", () => {
    const snapshot = JSON.parse(JSON.stringify(purchaseOrderSnapshot({ SentAt: "not a date" })));

    expect(snapshot.sentAt).toBeNull();
    expect(snapshot.completedAt).toBeNull();
    expect(Object.keys(snapshot)).toHaveLength(12);
  });
});

describe("the money decision codes", () => {
  const plain = [
    "invoice.approve",
    "invoice.director_approve",
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
    "quote.director_request_sent",
    "quote.reject",
  ] as const;
  // Undoing or removing a money record is what an audit looks for first.
  const reversalsAndDeletions = [
    "invoice.delete",
    "invoice.undo_director_approve",
    "invoice.unmark_myob_created",
    "po.delete",
    "po.uncomplete",
    "po.unmark_myob_created",
    "quote.delete",
    "quote.unapprove",
    "quote.uncomplete",
  ] as const;

  // A money record changed under a decision someone else made, or a request
  // that was meant to go out and did not.
  const changesAndFailures = [
    "invoice.approval_reset",
    "invoice.director_request_failed",
    "payment.amount_change",
    "po.markers_reset",
    "quote.approval_reset",
    "quote.director_request_failed",
  ] as const;

  it.each(plain)("%s is a plain decision: not an exception, no reason demanded", (code) => {
    expect(LEDGER_ACTIONS[code]).toMatchObject({ exception: false, reasonRequired: false });
  });

  it.each(reversalsAndDeletions)("%s undoes or removes a money record: an exception, but no reason demanded yet", (code) => {
    expect(LEDGER_ACTIONS[code]).toMatchObject({ exception: true, reasonRequired: false });
  });

  it.each(changesAndFailures)("%s is a change under someone else's decision, or a request that failed: an exception, no reason demanded yet", (code) => {
    expect(LEDGER_ACTIONS[code]).toMatchObject({ exception: true, reasonRequired: false });
  });

  it("the new codes apply to their own kind of record only", () => {
    expect(LEDGER_ACTIONS["quote.approval_reset"].subjects).toEqual(["quote"]);
    expect(LEDGER_ACTIONS["quote.director_request_sent"].subjects).toEqual(["quote"]);
    expect(LEDGER_ACTIONS["quote.director_request_failed"].subjects).toEqual(["quote"]);
    expect(LEDGER_ACTIONS["invoice.approval_reset"].subjects).toEqual(["invoice"]);
    expect(LEDGER_ACTIONS["invoice.director_request_sent"].subjects).toEqual(["invoice"]);
    expect(LEDGER_ACTIONS["invoice.director_request_failed"].subjects).toEqual(["invoice"]);
    expect(LEDGER_ACTIONS["po.markers_reset"].subjects).toEqual(["purchase_order"]);
    expect(LEDGER_ACTIONS["payment.amount_change"].subjects).toEqual(["payment"]);
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

describe("what an edit tears down", () => {
  describe("approvalSnapshot", () => {
    it("the amount the approvals covered, the status they held, and who gave them and when", () => {
      expect(
        approvalSnapshot({
          Amount: "1234.50",
          ApprovedAt: new Date("2026-10-01T02:03:04Z"),
          ApprovedBy: "Pat Approver",
          ContractorName: "Acme",
          DirectorApprovedAt: "2026-10-02T05:06:07Z",
          DirectorApprovedBy: "Dana Director",
          Status: "approved",
        }),
      ).toEqual({
        amount: 1234.5,
        approvedAt: "2026-10-01T02:03:04.000Z",
        approvedBy: "Pat Approver",
        directorApprovedAt: "2026-10-02T05:06:07.000Z",
        directorApprovedBy: "Dana Director",
        status: "approved",
      });
    });

    it("keeps a stable shape for a bare row: nulls, never undefined or an invalid date", () => {
      const snapshot = JSON.parse(JSON.stringify(approvalSnapshot({ ApprovedAt: "not a date" })));

      expect(snapshot).toEqual({
        amount: null,
        approvedAt: null,
        approvedBy: null,
        directorApprovedAt: null,
        directorApprovedBy: null,
        status: null,
      });
    });
  });

  describe("purchaseOrderMarkers", () => {
    const row = {
      CostNotToExceed: 900,
      EstimatedCost: "800.00",
      MyobCreatedAt: new Date("2026-10-02T05:06:07Z"),
      MyobCreatedBy: "Ann Accounts",
      SentAt: new Date("2026-10-01T02:03:04Z"),
      SentBy: "Fred Facilities",
    };

    it("the old cost and cap, with the stamps of both markers when both are cleared", () => {
      expect(purchaseOrderMarkers(row, { myob: true, sent: true })).toEqual({
        costNotToExceed: 900,
        estimatedCost: 800,
        myobCreatedAt: "2026-10-02T05:06:07.000Z",
        myobCreatedBy: "Ann Accounts",
        sentAt: "2026-10-01T02:03:04.000Z",
        sentBy: "Fred Facilities",
      });
    });

    it("leaves out the stamp of a marker that stays", () => {
      expect(purchaseOrderMarkers(row, { myob: false, sent: true })).toEqual({
        costNotToExceed: 900,
        estimatedCost: 800,
        sentAt: "2026-10-01T02:03:04.000Z",
        sentBy: "Fred Facilities",
      });
      expect(purchaseOrderMarkers(row, { myob: true, sent: false })).toEqual({
        costNotToExceed: 900,
        estimatedCost: 800,
        myobCreatedAt: "2026-10-02T05:06:07.000Z",
        myobCreatedBy: "Ann Accounts",
      });
    });

    it("keeps a stable shape for a bare row", () => {
      expect(JSON.parse(JSON.stringify(purchaseOrderMarkers({}, { myob: true, sent: true })))).toEqual({
        costNotToExceed: null,
        estimatedCost: null,
        myobCreatedAt: null,
        myobCreatedBy: null,
        sentAt: null,
        sentBy: null,
      });
    });
  });

  describe("paymentEdit", () => {
    const existing = { Amount: "100.00", JobInvoiceID: 5, MyobID: null, Status: "pending" };
    const invoice = { ContractorName: "Acme", InvoiceNumber: "IV-9-1", SupplierInvoiceNumber: "INV-0042" };

    it("the amount before and after, with the invoice it pays and who the money is for", () => {
      expect(paymentEdit(existing, 150, invoice)).toEqual({
        after: {
          amount: 150,
          contractorName: "Acme",
          invoiceNumber: "IV-9-1",
          jobInvoiceId: 5,
          status: "pending",
          supplierInvoiceNumber: "INV-0042",
        },
        before: { amount: 100, jobInvoiceId: 5, myobBillUid: null, status: "pending" },
      });
    });

    it("puts the MYOB bill a payment already has in `before`", () => {
      expect(paymentEdit({ ...existing, MyobID: "bill-uid" }, 150).before).toMatchObject({ myobBillUid: "bill-uid" });
    });

    it("needs no invoice: who the money is for is then unknown, not wrong", () => {
      expect(paymentEdit(existing, 150).after).toMatchObject({ contractorName: null, invoiceNumber: null, supplierInvoiceNumber: null });
    });

    it("keeps a stable shape for a bare row", () => {
      const edit = JSON.parse(JSON.stringify(paymentEdit({}, 150)));

      expect(edit.before).toEqual({ amount: null, jobInvoiceId: null, myobBillUid: null, status: null });
      expect(edit.after).toMatchObject({ amount: 150, jobInvoiceId: null, status: null });
    });
  });
});
