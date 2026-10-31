// The tenant notices sweep (TR4, PLAN §15): turns the pending outbox rows into emails. Run by tenantNoticesTimer.
//
//   claim      a row goes pending -> working under one UPDATE, so two sweeps never take the same row; a claim older
//              than STALE_SENDING_MINUTES is handed back (three tries, then it is skipped with the reason)
//   decide     no tenancy, an archived or test record, nobody to tell, an unapproved template while sends are live:
//              the row is marked skipped and says why; nothing is sent
//   dry run    the row is marked dry_run and the would-be recipients logged; nothing is queued
//   live       queued through the comms core under the key tenant-notice-<job>-<event>, so a retry after a crash
//              between queueing and marking finds the email already made; then the row is marked sent and
//              work_request.notice_sent is written to the ledger in one transaction
// Behind the tenantRequests flag: while no role has it enabled, rows wait.

import { TYPES, type Connection } from "tedious";
import { inTransaction, txOk } from "../assetRegisterSupport";
import { commsMode, MAX_ATTEMPTS, STALE_SENDING_MINUTES } from "../comms/config";
import { executeQuery } from "../db";
import { record } from "../ledger";
import { noticesMode, type NoticeEvent, type NoticeMode } from "./config";
import { loadNoticeContext } from "./context";
import { resolveStatusContacts } from "./recipients";
import { queueNotice } from "./send";

const BATCH = 20;

export interface SweepReport {
  dryRun: number;
  mode: NoticeMode;
  sent: number;
  skipped: number;
}

interface Notice {
  event: NoticeEvent;
  jobId: number;
  noticeId: number;
}

const FLAG_SQL = `SELECT TOP (1) 1 AS On_ FROM dbo.FeatureFlags WHERE FeatureKey = N'tenantRequests' AND Visibility = N'enabled'`;

const RELEASE_SQL = `UPDATE dbo.TenantNotices
     SET Status = CASE WHEN Attempts >= @Max THEN N'skipped' ELSE N'pending' END,
         Detail = CASE WHEN Attempts >= @Max THEN N'Gave up after repeated failures' ELSE Detail END,
         ProcessedAt = CASE WHEN Attempts >= @Max THEN SYSUTCDATETIME() ELSE ProcessedAt END
   WHERE Status = N'working' AND ClaimedAt < DATEADD(minute, -@Stale, SYSUTCDATETIME())`;

const CLAIM_SQL = `WITH next AS (SELECT TOP (${BATCH}) * FROM dbo.TenantNotices WHERE Status = N'pending' ORDER BY NoticeId)
  UPDATE next SET Status = N'working', ClaimedAt = SYSUTCDATETIME(), Attempts = Attempts + 1
  OUTPUT inserted.NoticeId, inserted.JobId, inserted.Event`;

const FINISH_SQL = `UPDATE dbo.TenantNotices
     SET Status = @Status, Detail = @Detail, RecipientsText = @Recipients, CorrespondenceId = @CorrespondenceId, ProcessedAt = SYSUTCDATETIME()
   WHERE NoticeId = @NoticeId AND Status = N'working'`;

type Finish = { correspondenceId?: number; detail?: string; recipients?: string; status: "dry_run" | "sent" | "skipped" };

async function finish(connection: Connection, notice: Notice, outcome: Finish, ledgerAfter?: { tenantId: number; workRequestId: number | null }): Promise<void> {
  await inTransaction<boolean>(connection, async () => {
    const done = await executeQuery(connection, `${FINISH_SQL}; SELECT @@ROWCOUNT AS N`, [
      { name: "Status", type: TYPES.NVarChar, value: outcome.status },
      { name: "Detail", type: TYPES.NVarChar, value: outcome.detail ?? null },
      { name: "Recipients", type: TYPES.NVarChar, value: outcome.recipients ?? null },
      { name: "CorrespondenceId", type: TYPES.Int, value: outcome.correspondenceId ?? null },
      { name: "NoticeId", type: TYPES.Int, value: notice.noticeId },
    ]);
    if (outcome.status === "sent" && ledgerAfter && Number(done[0]?.N ?? 0) > 0) {
      await record(connection, {
        action: "work_request.notice_sent",
        actor: { kind: "system", name: "tenantNoticesSweep" },
        after: { correspondenceId: outcome.correspondenceId ?? null, event: notice.event, recipients: outcome.recipients ?? null },
        jobId: notice.jobId,
        subject: { id: ledgerAfter.workRequestId ?? notice.jobId, type: "work_request" },
        tenantId: ledgerAfter.tenantId,
      });
    }
    return txOk(true);
  });
}

async function handle(connection: Connection, notice: Notice, mode: NoticeMode, log: (message: string) => void): Promise<Finish["status"]> {
  const skip = async (detail: string): Promise<"skipped"> => {
    await finish(connection, notice, { detail, status: "skipped" });
    return "skipped";
  };
  const context = await loadNoticeContext(connection, notice.jobId);
  if (!context) return skip("The job no longer exists");
  if (context.jobArchived || context.isTestJob) return skip("The job is archived or a test record");
  if (context.tenantId === null || context.workRequestId === null) return skip("The job isn't linked to a tenancy and a request");
  if (context.tenancyArchived || context.isTestTenancy) return skip("The tenancy is archived or a test record");
  const contacts = await resolveStatusContacts(connection, context.tenantId, context.requestEmail);
  if (contacts.length === 0) return skip("No contact on the tenancy to tell: add a contact marked reports issues");
  const to = contacts.map((contact) => contact.email).join(", ");
  if (mode === "dry-run") {
    log(`tenantNoticesSweep: would send ${notice.event} for job ${notice.jobId} to ${to}`);
    await finish(connection, notice, { detail: "Dry run: nothing was sent", recipients: to.slice(0, 600), status: "dry_run" });
    return "dry_run";
  }
  const sent = await queueNotice(connection, { commsLive: commsMode() === "live", context, contacts, event: notice.event, jobId: notice.jobId, tenantId: context.tenantId });
  if (!sent.ok) return skip(sent.detail);
  await finish(connection, notice, { correspondenceId: sent.correspondenceId, recipients: sent.recipients, status: "sent" }, { tenantId: context.tenantId, workRequestId: context.workRequestId });
  return "sent";
}

export async function runTenantNoticeSweep(connection: Connection, log: (message: string) => void = () => undefined): Promise<SweepReport> {
  const mode = noticesMode();
  const report: SweepReport = { dryRun: 0, mode, sent: 0, skipped: 0 };
  if (mode === "off") return report;
  if ((await executeQuery(connection, FLAG_SQL)).length === 0) return report;
  await executeQuery(connection, RELEASE_SQL, [{ name: "Max", type: TYPES.Int, value: MAX_ATTEMPTS }, { name: "Stale", type: TYPES.Int, value: STALE_SENDING_MINUTES }]);
  const claimed = (await executeQuery(connection, CLAIM_SQL)).map((row): Notice => ({ event: String(row.Event) as NoticeEvent, jobId: Number(row.JobId), noticeId: Number(row.NoticeId) }));
  for (const notice of claimed) {
    try {
      const status = await handle(connection, notice, mode, log);
      if (status === "sent") report.sent += 1;
      else if (status === "dry_run") report.dryRun += 1;
      else report.skipped += 1;
    } catch (error) {
      // Left 'working': handed back after STALE_SENDING_MINUTES, and the queue key stops a second email.
      log(`tenantNoticesSweep: notice ${notice.noticeId} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return report;
}
