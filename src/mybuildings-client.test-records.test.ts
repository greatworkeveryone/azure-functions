/// <reference types="jest" />
// D9 review: the myBuildings client itself refuses a test job's file.
import { uploadAttachment } from "./mybuildings-client";
import { NOT_A_RECORD, TestDataEgressError } from "./test-data";

const fetchMock = jest.fn();
beforeEach(() => {
  fetchMock.mockReset().mockResolvedValue({ json: async () => ({}), ok: true, status: 200, text: async () => "" });
  global.fetch = fetchMock as unknown as typeof fetch;
});

const PAYLOAD = { Attachment_Extension: "pdf", Attachment_Name: "quote.pdf", Attachment_URL: "https://sas/x.pdf", WorkRequestID: 88 };

describe("uploadAttachment (myBuildings)", () => {
  it("refuses a test job's file before calling myBuildings", async () => {
    await expect(uploadAttachment({ isTest: true }, PAYLOAD)).rejects.toBeInstanceOf(TestDataEgressError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends a real job's file and a work request's file", async () => {
    await uploadAttachment({ isTest: false }, PAYLOAD);
    await uploadAttachment(NOT_A_RECORD, PAYLOAD);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
