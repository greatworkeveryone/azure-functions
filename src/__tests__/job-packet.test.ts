import assert from "node:assert";
import { buildJobPacket, packetDate } from "../pdf/job-packet";

describe("buildJobPacket", () => {
  test("renders a non-empty PDF buffer for a minimal job (no quote/PO/invoice)", async () => {
    const buf = await buildJobPacket({
      job: {
        id: 1,
        title: "Test job",
        buildingName: "1 Smith St",
        requestedBy: "Tester",
        status: "Pending",
        createdDate: new Date("2026-05-01T00:00:00Z"),
        oncharge: false,
      },
      selectedQuote: null,
      purchaseOrder: null,
      invoice: null,
      jobAttachments: [],
      sourcePointAttachments: [],
    });
    assert.ok(Buffer.isBuffer(buf));
    assert.ok(buf.length > 100, "PDF should have non-trivial body");
    // First 4 bytes of a PDF are the magic %PDF
    assert.strictEqual(buf.subarray(0, 4).toString("ascii"), "%PDF");
  });

  test("includes selected quote section when provided, omits when null", async () => {
    const withQuote = await buildJobPacket({
      job: { id: 2, title: "T", buildingName: "B", requestedBy: "X", status: "P", createdDate: new Date(), oncharge: false },
      selectedQuote: { id: 1, contractorName: "Acme", amount: 1234.56, currency: "AUD", quoteNumber: "Q-001", pdfBytes: null, linkedAttachmentFileNames: [] },
      purchaseOrder: null,
      invoice: null,
      jobAttachments: [],
      sourcePointAttachments: [],
    });
    const withoutQuote = await buildJobPacket({
      job: { id: 2, title: "T", buildingName: "B", requestedBy: "X", status: "P", createdDate: new Date(), oncharge: false },
      selectedQuote: null,
      purchaseOrder: null,
      invoice: null,
      jobAttachments: [],
      sourcePointAttachments: [],
    });
    assert.ok(withQuote.length > withoutQuote.length, "Adding a quote should grow the PDF");
  });

  test("still builds when the building and requester are blank (an empty value used to swallow the line break)", async () => {
    const buf = await buildJobPacket({
      job: { id: 3, title: "T", buildingName: "", requestedBy: "", status: "New", createdDate: new Date(), oncharge: false },
      selectedQuote: null,
      purchaseOrder: null,
      invoice: null,
      jobAttachments: [],
      sourcePointAttachments: [],
    });
    assert.strictEqual(buf.subarray(0, 4).toString("ascii"), "%PDF");
  });
});

describe("packetDate", () => {
  test("writes dd/mm/yyyy on the Darwin calendar", () => {
    assert.strictEqual(packetDate(new Date("2026-11-20T00:00:00Z")), "20/11/2026");
    // 20:00 UTC on the 19th is already the 20th in Darwin (UTC+9:30).
    assert.strictEqual(packetDate(new Date("2026-11-19T20:00:00Z")), "20/11/2026");
  });
});
