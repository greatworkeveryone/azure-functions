import type { Connection } from "tedious";
import * as queueJob from "../comms/queueJob";
import * as records from "../comms/recipientRecords";
import { loadTemplateBySlug } from "../intake/template";
import { queueNotice, noticeKey } from "./send";

jest.mock("../comms/idempotency", () => ({ ...jest.requireActual("../comms/idempotency"), findJobByKey: jest.fn().mockResolvedValue(null), takeKeyLock: jest.fn().mockResolvedValue(true) }));
jest.mock("../comms/events", () => ({ appendEvent: jest.fn() }));
jest.mock("../comms/recipientRecords", () => ({ resolveRecipientRecord: jest.fn() }));
jest.mock("../comms/store", () => ({ insertJob: jest.fn().mockResolvedValue(88), insertRecipient: jest.fn(), readJob: jest.fn(), recentRecipientCount: jest.fn().mockResolvedValue(0) }));
jest.mock("../db", () => ({ beginTransaction: jest.fn(), commitTransaction: jest.fn(), executeQuery: jest.fn(), rollbackTransaction: jest.fn() }));
jest.mock("../ledger", () => ({ record: jest.fn() }));
jest.mock("../intake/template", () => ({ ...jest.requireActual("../intake/template"), loadTemplateBySlug: jest.fn() }));

import * as store from "../comms/store";

const conn = {} as Connection;
const context = { buildingName: "Tower A", emailOnly: false, isTestJob: false, isTestTenancy: false, jobArchived: false, reference: "WR-31", requestEmail: null, summary: "Leak", tenancyArchived: false, tenantId: 9, tenantName: "Acme", workRequestId: 31 };
const contacts = [{ authorisedForCosts: false, contactId: 1, email: "Pat@Tenant.example", name: "Pat", reportsIssues: true }];
const template = { approved: true, bodyMarkdown: "Dear {{tenant.addressee}}, {{request.summary}} at {{building.name}} ({{request.reference}}).", subject: "Booked {{request.reference}}", version: 2 };
const input = (over: Record<string, unknown> = {}) => ({ commsLive: false, context, contacts, event: "attendance" as const, jobId: 5, tenantId: 9, ...over });

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(loadTemplateBySlug).mockResolvedValue(template);
  jest.mocked(records.resolveRecipientRecord).mockResolvedValue({ ok: true });
  jest.mocked(store.insertJob).mockResolvedValue(88);
});

describe("queueNotice", () => {
  it("queues a system letter to the tenancy's listed contacts, from notices@, keyed by job and event", async () => {
    const spy = jest.spyOn(queueJob, "writeJob");
    const result = await queueNotice(conn, input());
    expect(result).toMatchObject({ correspondenceId: 88, ok: true, recipients: "Pat <pat@tenant.example>" });
    expect(loadTemplateBySlug).toHaveBeenCalledWith(conn, "request-attendance", {});
    const job = jest.mocked(store.insertJob).mock.calls[0][1];
    expect(job).toMatchObject({ fromAddress: "notices@randazzo.properties", kind: "system", signatureMode: "role", templateId: "request_attendance", templateVersion: 2 });
    expect(job.recipients[0]).toMatchObject({ address: "pat@tenant.example", recipientRefId: "9", recipientType: "tenancy" });
    expect(spy.mock.calls[0][6]).toBe(noticeKey(5, "attendance"));
    expect(noticeKey(5, "completed")).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
  });

  it("drops the personal-link paragraph for an email-only tenancy, still a plain-text notice", async () => {
    await queueNotice(conn, input({ context: { ...context, emailOnly: true }, event: "completed" }));
    expect(loadTemplateBySlug).toHaveBeenCalledWith(conn, "request-completed", { omitBlockIdSuffix: "-link" });
  });

  it("refuses a draft template while sends are live, but allows it while they are off", async () => {
    jest.mocked(loadTemplateBySlug).mockResolvedValue({ ...template, approved: false });
    expect(await queueNotice(conn, input({ commsLive: true }))).toMatchObject({ ok: false });
    expect(store.insertJob).not.toHaveBeenCalled();
    expect(await queueNotice(conn, input())).toMatchObject({ ok: true });
  });

  it("queues nothing when the egress guard refuses every recipient (a test tenancy)", async () => {
    jest.mocked(records.resolveRecipientRecord).mockResolvedValue({ code: "test_record", detail: "That tenancy is a test record", ok: false });
    const result = await queueNotice(conn, input());
    expect(result).toMatchObject({ detail: expect.stringContaining("test record"), ok: false });
    expect(store.insertJob).not.toHaveBeenCalled();
  });

  it("says so when the template isn't in the library", async () => {
    jest.mocked(loadTemplateBySlug).mockResolvedValue(null);
    expect(await queueNotice(conn, input())).toMatchObject({ detail: expect.stringContaining("isn't in the library"), ok: false });
  });
});
