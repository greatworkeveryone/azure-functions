import type { Connection } from "tedious";
import { executeQuery } from "../db";
import { record } from "../ledger";
import { loadNoticeContext, type NoticeContext } from "./context";
import { resolveStatusContacts } from "./recipients";
import { queueNotice } from "./send";
import { runTenantNoticeSweep } from "./sweep";

jest.mock("../db", () => ({
  beginTransaction: jest.fn().mockResolvedValue(undefined),
  commitTransaction: jest.fn().mockResolvedValue(undefined),
  executeQuery: jest.fn(),
  rollbackTransaction: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../ledger", () => ({ record: jest.fn() }));
jest.mock("./context", () => ({ loadNoticeContext: jest.fn() }));
jest.mock("./recipients", () => ({ resolveStatusContacts: jest.fn() }));
jest.mock("./send", () => ({ queueNotice: jest.fn() }));

const query = jest.mocked(executeQuery);
const conn = {} as Connection;
const contact = { authorisedForCosts: false, contactId: 1, email: "pat@tenant.example", name: "Pat", reportsIssues: true };
const ctx = (over: Partial<NoticeContext> = {}): NoticeContext => ({
  buildingName: "Tower A", emailOnly: false, isTestJob: false, isTestTenancy: false, jobArchived: false, reference: "WR-31", requestEmail: "pat@tenant.example",
  summary: "Leak", tenancyArchived: false, tenantId: 9, tenantName: "Acme", workRequestId: 31, ...over,
});
let flagOn = true;
let claimed: Array<Record<string, unknown>> = [];
const finishes = () => query.mock.calls.filter(([, sql]) => /UPDATE dbo\.TenantNotices\s+SET Status = @Status/.test(String(sql)));

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.TENANT_NOTICES_ENABLED;
  delete process.env.TENANT_NOTICES_DRY_RUN;
  delete process.env.COMMS_SEND_ENABLED;
  flagOn = true;
  claimed = [{ Event: "attendance", JobId: 5, NoticeId: 1 }];
  query.mockImplementation(async (_c: unknown, sql: string) => {
    if (/FROM dbo\.FeatureFlags/.test(sql)) return flagOn ? [{ On_: 1 }] : [];
    if (/OUTPUT inserted\.NoticeId/.test(sql)) return claimed;
    if (/@@ROWCOUNT/.test(sql)) return [{ N: 1 }];
    return [];
  });
  jest.mocked(loadNoticeContext).mockResolvedValue(ctx());
  jest.mocked(resolveStatusContacts).mockResolvedValue([contact]);
  jest.mocked(queueNotice).mockResolvedValue({ correspondenceId: 70, ok: true, recipients: "Pat <pat@tenant.example>" });
});

describe("runTenantNoticeSweep", () => {
  it("does nothing, and does not touch the database, while the switch is off", async () => {
    expect(await runTenantNoticeSweep(conn)).toEqual({ dryRun: 0, mode: "off", sent: 0, skipped: 0 });
    expect(query).not.toHaveBeenCalled();
    expect(queueNotice).not.toHaveBeenCalled();
  });

  it("leaves the rows waiting while the tenantRequests flag is not enabled for any role", async () => {
    process.env.TENANT_NOTICES_ENABLED = "true";
    flagOn = false;
    expect((await runTenantNoticeSweep(conn)).sent).toBe(0);
    expect(queueNotice).not.toHaveBeenCalled();
    expect(query.mock.calls.some(([, sql]) => /OUTPUT inserted\.NoticeId/.test(String(sql)))).toBe(false);
  });

  it("queues the notice through the comms core, marks the row sent and ledgers it", async () => {
    process.env.TENANT_NOTICES_ENABLED = "true";
    expect(await runTenantNoticeSweep(conn)).toMatchObject({ mode: "live", sent: 1, skipped: 0 });
    expect(queueNotice).toHaveBeenCalledTimes(1);
    expect(jest.mocked(queueNotice).mock.calls[0][1]).toMatchObject({ event: "attendance", jobId: 5, tenantId: 9, commsLive: false });
    expect(finishes()).toHaveLength(1);
    expect(finishes()[0][2]).toEqual(expect.arrayContaining([expect.objectContaining({ name: "Status", value: "sent" }), expect.objectContaining({ name: "CorrespondenceId", value: 70 })]));
    expect(jest.mocked(record).mock.calls[0][1]).toMatchObject({ action: "work_request.notice_sent", jobId: 5, subject: { id: 31, type: "work_request" }, tenantId: 9 });
  });

  it("dry run says who would be told, queues nothing and writes no ledger row", async () => {
    process.env.TENANT_NOTICES_DRY_RUN = "true";
    const log = jest.fn();
    expect(await runTenantNoticeSweep(conn, log)).toMatchObject({ dryRun: 1, mode: "dry-run", sent: 0 });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("pat@tenant.example"));
    expect(queueNotice).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    expect(finishes()[0][2]).toEqual(expect.arrayContaining([expect.objectContaining({ name: "Status", value: "dry_run" })]));
  });

  it("skips with the reason, sending nothing, when there is nobody to tell or the tenancy is a test record", async () => {
    process.env.TENANT_NOTICES_ENABLED = "true";
    jest.mocked(resolveStatusContacts).mockResolvedValueOnce([]);
    expect((await runTenantNoticeSweep(conn)).skipped).toBe(1);
    jest.mocked(loadNoticeContext).mockResolvedValueOnce(ctx({ isTestTenancy: true }));
    expect((await runTenantNoticeSweep(conn)).skipped).toBe(1);
    jest.mocked(loadNoticeContext).mockResolvedValueOnce(ctx({ tenantId: null }));
    expect((await runTenantNoticeSweep(conn)).skipped).toBe(1);
    expect(queueNotice).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it("skips (and says why) when the comms core refuses it, e.g. a draft template while sends are live", async () => {
    process.env.TENANT_NOTICES_ENABLED = "true";
    process.env.COMMS_SEND_ENABLED = "true";
    jest.mocked(queueNotice).mockResolvedValueOnce({ detail: "The request_attendance template hasn't been approved yet", ok: false });
    expect(await runTenantNoticeSweep(conn)).toMatchObject({ sent: 0, skipped: 1 });
    expect(jest.mocked(queueNotice).mock.calls[0][1]).toMatchObject({ commsLive: true });
    expect(record).not.toHaveBeenCalled();
  });

  it("leaves a row that threw claimed (handed back after the stale window) and carries on", async () => {
    process.env.TENANT_NOTICES_ENABLED = "true";
    claimed = [{ Event: "attendance", JobId: 5, NoticeId: 1 }, { Event: "completed", JobId: 6, NoticeId: 2 }];
    jest.mocked(queueNotice).mockRejectedValueOnce(new Error("connection reset"));
    expect(await runTenantNoticeSweep(conn, jest.fn())).toMatchObject({ sent: 1 });
    expect(queueNotice).toHaveBeenCalledTimes(2);
  });

  it("only claims 'pending' rows, one UPDATE at a time, and hands stale claims back", async () => {
    process.env.TENANT_NOTICES_ENABLED = "true";
    claimed = [];
    await runTenantNoticeSweep(conn);
    const sqls = query.mock.calls.map(([, sql]) => String(sql));
    expect(sqls.some((sql) => /WHERE Status = N'pending' ORDER BY NoticeId\)\s+UPDATE next SET Status = N'working'/.test(sql))).toBe(true);
    expect(sqls.some((sql) => /Status = N'working' AND ClaimedAt < DATEADD/.test(sql))).toBe(true);
  });
});
