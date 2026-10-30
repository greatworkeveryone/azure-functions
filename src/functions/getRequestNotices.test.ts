import { HttpRequest, type InvocationContext } from "@azure/functions";
import { executeQuery } from "../db";
import { _resetRateLimitForTests } from "../rateLimit";
import { getRequestNotices } from "./getRequestNotices";

jest.mock("@azure/functions", () => ({ ...jest.requireActual("@azure/functions"), app: { http: jest.fn() } }));
jest.mock("../assetRegisterSupport", () => ({
  authorizeWrite: jest.fn(async () => ({ caller: { oid: "o" }, ok: true, token: "t" })),
  badRequest: (error: string) => ({ jsonBody: { error }, status: 400 }),
}));
jest.mock("../db", () => ({ closeConnection: jest.fn(), createRequestConnection: jest.fn(async () => ({})), executeQuery: jest.fn() }));

const context = { error: jest.fn() } as unknown as InvocationContext;
const get = (qs: string) => new HttpRequest({ method: "GET", url: `http://localhost/api/getRequestNotices?${qs}` });
const query = jest.mocked(executeQuery);

beforeEach(() => {
  jest.clearAllMocks();
  _resetRateLimitForTests();
});

describe("getRequestNotices", () => {
  it("lists the notices for a request: event, state, when, to whom", async () => {
    query.mockResolvedValueOnce([{ CreatedAt: new Date("2026-10-30T01:00:00Z"), Detail: null, Event: "attendance", JobId: 5, NoticeId: 1, ProcessedAt: new Date("2026-10-30T01:02:00Z"), RecipientsText: "Pat <pat@t.example>", Status: "sent", WorkRequestId: 31 }]);
    const response = await getRequestNotices(get("workRequestId=31"), context);
    expect(response.status).toBe(200);
    expect(response.jsonBody).toEqual({ items: [{ createdAt: "2026-10-30T01:00:00.000Z", detail: null, event: "attendance", jobId: 5, noticeId: 1, processedAt: "2026-10-30T01:02:00.000Z", recipients: "Pat <pat@t.example>", status: "sent", workRequestId: 31 }] });
    expect(String(query.mock.calls[0][1])).toContain("WorkRequestId = @Id");
  });

  it("takes a job id instead, and exactly one of the two", async () => {
    query.mockResolvedValueOnce([]);
    expect((await getRequestNotices(get("jobId=5"), context)).status).toBe(200);
    expect(query.mock.calls[0][2]).toEqual(expect.arrayContaining([expect.objectContaining({ name: "ByRequest", value: 0 })]));
    expect((await getRequestNotices(get(""), context)).status).toBe(400);
    expect((await getRequestNotices(get("jobId=5&workRequestId=3"), context)).status).toBe(400);
    expect((await getRequestNotices(get("jobId=abc"), context)).status).toBe(400);
  });

  it("answers an empty list before migration 186 is applied", async () => {
    query.mockRejectedValueOnce(new Error("Invalid object name 'dbo.TenantNotices'."));
    const response = await getRequestNotices(get("workRequestId=31"), context);
    expect(response.jsonBody).toEqual({ items: [] });
  });
});
