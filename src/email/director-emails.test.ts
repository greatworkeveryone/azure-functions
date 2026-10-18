/// <reference types="jest" />
// What sendDirectorApprovalEmail reports back for the ledger: who it went to and
// a summary of the packet, with no addresses and no file names in the summary.
import type { Connection } from "tedious";
import type { PacketAttachment, PacketInput } from "../pdf/job-packet";

jest.mock("../graph", () => ({ graphSendMail: jest.fn() }));
// No director in AppUsers here, so the env list is who it goes to.
jest.mock("./role-recipients", () => ({
  resolveRoleRecipients: jest.fn(async (_connection: unknown, _role: string, fallback: string[]) => ({
    addresses: fallback,
    source: "env_fallback",
  })),
}));
jest.mock("../pdf/job-packet-loader", () => ({ loadJobPacketInputs: jest.fn() }));
jest.mock("../pdf/job-packet", () => ({
  ...jest.requireActual("../pdf/job-packet"),
  buildJobPacket: jest.fn(),
}));

jest.mock("../test-data", () => ({ ...jest.requireActual("../test-data"), readIsTest: jest.fn() }));

const graph = require("../graph") as { graphSendMail: jest.Mock };
const testData = require("../test-data") as { readIsTest: jest.Mock };
const loader = require("../pdf/job-packet-loader") as { loadJobPacketInputs: jest.Mock };
const packet = require("../pdf/job-packet") as { buildJobPacket: jest.Mock };
const { sendDirectorApprovalEmail } = require("./director-emails") as typeof import("./director-emails");

const connection = {} as Connection;
const file = (fileName: string, contentType: string): PacketAttachment => ({ bytes: Buffer.from("x"), contentType, fileName });
const input = (over: Partial<PacketInput> = {}): PacketInput => ({
  invoice: null,
  job: { buildingName: "1 Smith St", createdDate: new Date("2026-05-01T00:00:00Z"), id: 9, oncharge: false, requestedBy: "Tester", status: "Work", title: "Roof" },
  jobAttachments: [],
  purchaseOrder: null,
  selectedQuote: null,
  sourcePointAttachments: [],
  ...over,
});
const send = () => sendDirectorApprovalEmail({ amount: 5000, connection, currency: "AUD", jobId: 9, stage: "quote", triggeredBy: "Casey Controller" });

const ORIGINAL_RECIPIENTS = process.env.DIRECTOR_APPROVAL_EMAILS;

beforeEach(() => {
  jest.clearAllMocks();
  process.env.DIRECTOR_APPROVAL_EMAILS = "dana@example.com, boss@example.com";
  packet.buildJobPacket.mockResolvedValue(Buffer.from("%PDF"));
  graph.graphSendMail.mockResolvedValue(undefined);
  loader.loadJobPacketInputs.mockResolvedValue(input());
  testData.readIsTest.mockResolvedValue(false);
});

afterAll(() => {
  if (ORIGINAL_RECIPIENTS === undefined) delete process.env.DIRECTOR_APPROVAL_EMAILS;
  else process.env.DIRECTOR_APPROVAL_EMAILS = ORIGINAL_RECIPIENTS;
});

describe("sendDirectorApprovalEmail: what it reports back", () => {
  it("lists the packet's sections in order, counts its files, and counts the ones that went separately", async () => {
    loader.loadJobPacketInputs.mockResolvedValue(
      input({
        invoice: { amount: 5000, contractorName: "Acme", currency: "AUD", id: 5, invoiceNumber: "IV-9-1", pdfBytes: null },
        jobAttachments: [file("scope.pdf", "application/pdf"), file("costings.xlsx", "application/vnd.ms-excel")],
        purchaseOrder: { amount: 5000, contractorName: "Acme", currency: "AUD", id: 4, poNumber: null, pdfBytes: null },
        selectedQuote: { amount: 5000, contractorName: "Acme", currency: "AUD", id: 7, linkedAttachmentFileNames: [], pdfBytes: null, quoteNumber: "QT-9-1" },
        sourcePointAttachments: [file("photo.png", "image/png"), file("notes.docx", "application/msword")],
      }),
    );

    const result = await send();

    expect(result.packet).toEqual({
      attachments: 4,
      sections: ["job summary", "quote QT-9-1", "purchase order #4", "invoice IV-9-1"],
      separateFiles: 2,
    });
  });

  it("a job with nothing yet attached is just its summary", async () => {
    const result = await send();

    expect(result.packet).toEqual({ attachments: 0, sections: ["job summary"], separateFiles: 0 });
  });

  it("names no file and no address in the summary", async () => {
    loader.loadJobPacketInputs.mockResolvedValue(input({ jobAttachments: [file("confidential-costings.xlsx", "application/vnd.ms-excel")] }));

    const result = await send();

    expect(JSON.stringify(result.packet)).not.toMatch(/confidential|xlsx|@example\.com/);
  });

  it("reports who it went to and when, as it always did", async () => {
    const result = await send();

    expect(result.sentTo).toEqual(["dana@example.com", "boss@example.com"]);
    expect(result.sentAt).toBeInstanceOf(Date);
  });

  it("sends the mail itself exactly as before: to each recipient, with the packet and the files that can't be merged", async () => {
    loader.loadJobPacketInputs.mockResolvedValue(input({ jobAttachments: [file("costings.xlsx", "application/vnd.ms-excel")] }));

    await send();

    expect(graph.graphSendMail).toHaveBeenCalledTimes(1);
    const [, to, subject, body, attachments] = graph.graphSendMail.mock.calls[0];
    expect(to).toEqual(["dana@example.com", "boss@example.com"]);
    expect(subject).toBe("Director approval requested — Job #9 (quote) — AUD 5000.00");
    expect(body).toContain("Approved by: Casey Controller");
    expect(attachments.map((a: { fileName: string }) => a.fileName)).toEqual(["job-9-packet.pdf", "costings.xlsx"]);
  });

  it("sends nothing and reports nothing when no director is configured", async () => {
    process.env.DIRECTOR_APPROVAL_EMAILS = " , ";

    await expect(send()).rejects.toThrow(/no active director in AppUsers and DIRECTOR_APPROVAL_EMAILS is empty/);

    expect(graph.graphSendMail).not.toHaveBeenCalled();
    expect(loader.loadJobPacketInputs).not.toHaveBeenCalled();
  });

  it("passes a failed send on to the caller, which decides what to do about it", async () => {
    graph.graphSendMail.mockRejectedValue(new Error("Graph sendMail 503"));

    await expect(send()).rejects.toThrow("Graph sendMail 503");
  });
});

describe("sendDirectorApprovalEmail and test records (D9)", () => {
  it("refuses a test job before building the packet or sending", async () => {
    testData.readIsTest.mockResolvedValueOnce(true);
    const { TestDataEgressError } = jest.requireActual("../test-data") as typeof import("../test-data");
    await expect(send()).rejects.toBeInstanceOf(TestDataEgressError);
    expect(testData.readIsTest).toHaveBeenCalledWith(connection, "job", 9);
    expect(packet.buildJobPacket).not.toHaveBeenCalled();
    expect(graph.graphSendMail).not.toHaveBeenCalled();
  });

  it("tells the Graph helper a real job's packet isn't a test record", async () => {
    await send();
    expect(graph.graphSendMail.mock.calls[0][0]).toEqual({ isTest: false });
  });
});

describe("the link opens the step the director acts on (J6)", () => {
  const ORIGINAL_BASE = process.env.APP_BASE_URL;
  afterEach(() => {
    if (ORIGINAL_BASE === undefined) delete process.env.APP_BASE_URL;
    else process.env.APP_BASE_URL = ORIGINAL_BASE;
  });
  const body = () => graph.graphSendMail.mock.calls[0][3] as string;

  it("a quote packet links to the quotes step and names the quote", async () => {
    process.env.APP_BASE_URL = "https://floorplan.example/";
    await sendDirectorApprovalEmail({ amount: 25000, connection, currency: "AUD", jobId: 9, stage: "quote", subjectId: 7 });
    expect(body()).toContain("Approve or decline in Floorplan: https://floorplan.example/jobs?jobId=9&step=quotes&quoteId=7\n");
  });

  it("an invoice packet links to the invoices step and names the invoice", async () => {
    process.env.APP_BASE_URL = "https://floorplan.example";
    await sendDirectorApprovalEmail({ amount: 25000, connection, currency: "AUD", jobId: 9, stage: "invoice", subjectId: 5 });
    expect(body()).toContain("https://floorplan.example/jobs?jobId=9&step=invoices&invoiceId=5\n");
  });

  it("without APP_BASE_URL it still goes, pointing to Floorplan in words", async () => {
    delete process.env.APP_BASE_URL;
    await send();
    expect(body()).toContain("Open the job in Floorplan to approve or decline.");
    expect(body()).not.toContain("jobId=");
  });
});
