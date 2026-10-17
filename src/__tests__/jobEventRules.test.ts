/// <reference types="jest" />
// J3 review: a quote, invoice or PO an event names must be on the event's job.
// The check is one statement; its shape is pinned so each EXISTS stays tied to
// the event's job, and each missing record is named.
jest.mock("../db", () => ({ executeQuery: jest.fn() }));

const db = require("../db") as { executeQuery: jest.Mock };
const { linkedRecordRefusal, eventTypeRefusal, linkedIdsInvalid } = require("../jobEventRules") as typeof import("../jobEventRules");

const connection = {} as never;
const sql = (): string => String(db.executeQuery.mock.calls[0][1]).replace(/\s+/g, " ");

beforeEach(() => {
  jest.clearAllMocks();
  db.executeQuery.mockResolvedValue([{ InvoiceOnJob: 1, PurchaseOrderOnJob: 1, QuoteOnJob: 1 }]);
});

describe("linkedRecordRefusal", () => {
  it.each([
    ["Quotes", "QuoteID = @QuoteID", "QuoteOnJob"],
    ["JobInvoices", "JobInvoiceID = @InvoiceID", "InvoiceOnJob"],
    ["PurchaseOrders", "PurchaseOrderID = @PurchaseOrderID", "PurchaseOrderOnJob"],
  ])("ties the %s check to the event's job", async (table, idMatch, column) => {
    await linkedRecordRefusal(connection, 9, { InvoiceID: 41, PurchaseOrderID: 42, QuoteID: 43 });
    const expected = "EXISTS (SELECT 1 FROM " + table + " WHERE " + idMatch + " AND JobID = @JobID) THEN 1 ELSE 0 END AS " + column;
    expect(sql()).toContain(expected);
    expect(db.executeQuery.mock.calls[0][2]).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "JobID", value: 9 })]),
    );
  });

  it.each([
    [{ QuoteOnJob: 0 }, "That quote isn't on this job."],
    [{ InvoiceOnJob: 0 }, "That invoice isn't on this job."],
    [{ PurchaseOrderOnJob: 0 }, "That purchase order isn't on this job."],
  ])("names the record that is on another job (%p)", async (row, error) => {
    db.executeQuery.mockResolvedValue([{ InvoiceOnJob: 1, PurchaseOrderOnJob: 1, QuoteOnJob: 1, ...row }]);
    expect(await linkedRecordRefusal(connection, 9, { InvoiceID: 41, PurchaseOrderID: 42, QuoteID: 43 })).toEqual({ code: "record_not_on_job", error });
  });

  it("passes each id it was given, and null for the rest", async () => {
    await linkedRecordRefusal(connection, 9, { QuoteID: 43 });
    expect(db.executeQuery.mock.calls[0][2]).toEqual([
      expect.objectContaining({ name: "JobID", value: 9 }),
      expect.objectContaining({ name: "QuoteID", value: 43 }),
      expect.objectContaining({ name: "InvoiceID", value: null }),
      expect.objectContaining({ name: "PurchaseOrderID", value: null }),
    ]);
  });

  it("runs nothing when the event names no record", async () => {
    expect(await linkedRecordRefusal(connection, 9, {})).toBeNull();
    expect(db.executeQuery).not.toHaveBeenCalled();
  });
});

describe("eventTypeRefusal and linkedIdsInvalid", () => {
  it("lets the screens' own types and an untyped note through, and nothing else", () => {
    expect(eventTypeRefusal(undefined)).toBeNull();
    expect(eventTypeRefusal("comment")).toBeNull();
    expect(eventTypeRefusal("quote_added")?.code).toBe("event_type_not_allowed");
    expect(eventTypeRefusal(7)?.code).toBe("event_type_not_allowed");
  });

  it("accepts positive whole ids and absent ones only", () => {
    expect(linkedIdsInvalid({ QuoteID: 1, InvoiceID: null })).toBe(false);
    expect(linkedIdsInvalid({ QuoteID: 0 })).toBe(true);
    expect(linkedIdsInvalid({ PurchaseOrderID: "4" })).toBe(true);
    expect(linkedIdsInvalid({ InvoiceID: 1.5 })).toBe(true);
  });
});
