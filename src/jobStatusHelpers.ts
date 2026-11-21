// advanceJobStatus — single source of truth for writes to Jobs.Status and
// Jobs.AwaitingRole. Forward-only: callers fire an event; the helper consults
// the state machine, writes only if it's a legal forward transition, and logs
// a status_change JobEvent. Never throws on a no-op transition — callers
// don't need to know the current state.

import { TYPES } from "tedious";
import type { Connection } from "tedious";
import { executeQuery } from "./db";
import { isWorkCompletion, markServiceJobCompleted } from "./serviceScheduleRuns";
import {
  AwaitingRole,
  JobEvent,
  JobStatus,
  type JobState,
  nextState,
} from "./jobStatusMachine";

export interface AdvanceJobStatusOptions {
  actor: string | null;
  /** Optional override of the system-generated event text. */
  note?: string;
  /** Optional ID payload for the JobEvent row. */
  purchaseOrderId?: number;
  quoteId?: number;
  invoiceId?: number;
}

export interface AdvanceJobStatusResult {
  advanced: boolean;
  from: JobState | null;
  to: JobState | null;
  /** The job was on hold: the event moved the saved pre-hold state, so resuming lands where the records say the job now is (REV-02). */
  heldUpdated?: boolean;
}

function defaultEventText(target: JobState, event: JobEvent): string {
  switch (event) {
    case JobEvent.QUOTE_REQUESTED:
      return "Contractors requested — awaiting quotes.";
    case JobEvent.QUOTE_RECEIVED:
      return "Quote received — awaiting approval.";
    case JobEvent.QUOTE_APPROVED:
      return "Quote approved — work in progress.";
    case JobEvent.PO_CREATED:
      return "Purchase order created — work in progress.";
    case JobEvent.WORK_COMPLETED:
      return "Work complete — awaiting accounts approval.";
    case JobEvent.INVOICE_APPROVED:
      return "Invoice approved — job complete.";
    case JobEvent.QUOTES_DECLINED:
      return "Every quote was declined — back to the quote round.";
    case JobEvent.TENANT_BLOCKED:
      return "Waiting on tenant.";
    case JobEvent.TENANT_UNBLOCKED:
      return "Tenant block cleared — back to work.";
    default:
      return `Status changed to ${target.status}.`;
  }
}

const LEGACY_HELD_STATE: JobState = { status: JobStatus.WORK, awaitingRole: AwaitingRole.FACILITIES };

async function advanceHeldJob(
  connection: Connection,
  jobId: number,
  event: JobEvent,
  opts: AdvanceJobStatusOptions,
  current: JobState,
): Promise<AdvanceJobStatusResult> {
  const [row = {}] = await executeQuery(
    connection,
    "SELECT PreBlockStatus, PreBlockAwaitingRole FROM Jobs WHERE JobID = @JobID",
    [{ name: "JobID", type: TYPES.Int, value: jobId }],
  );
  const savedStatus = (row.PreBlockStatus as JobStatus | null) ?? null;
  const savedRole = (row.PreBlockAwaitingRole as AwaitingRole | null) ?? null;
  const hasSaved = savedStatus != null && savedStatus !== JobStatus.TENANT && savedStatus !== JobStatus.DONE;
  const preHold: JobState = hasSaved
    ? { status: savedStatus, awaitingRole: savedRole ?? AwaitingRole.FACILITIES }
    : LEGACY_HELD_STATE;
  const target = nextState(preHold, event);
  const touch = async () => {
    await executeQuery(connection, "UPDATE Jobs SET LastModifiedDate = SYSUTCDATETIME() WHERE JobID = @JobID", [
      { name: "JobID", type: TYPES.Int, value: jobId },
    ]);
  };
  // A held job is never closed by an event: closing stays a hand move, checked by the guard.
  if (
    target == null ||
    target.status === JobStatus.DONE ||
    (target.status === preHold.status && target.awaitingRole === preHold.awaitingRole)
  ) {
    await touch();
    return { advanced: false, from: current, to: null };
  }
  const moved = await executeQuery(
    connection,
    `UPDATE Jobs
        SET PreBlockStatus = @NewStatus, PreBlockAwaitingRole = @NewRole, LastModifiedDate = SYSUTCDATETIME()
     OUTPUT INSERTED.JobID
      WHERE JobID = @JobID
        AND Status = @HeldStatus
        AND ISNULL(PreBlockStatus, '') = @OldStatus
        AND ISNULL(PreBlockAwaitingRole, '') = @OldRole`,
    [
      { name: "JobID", type: TYPES.Int, value: jobId },
      { name: "HeldStatus", type: TYPES.NVarChar, value: JobStatus.TENANT },
      { name: "NewStatus", type: TYPES.NVarChar, value: target.status },
      { name: "NewRole", type: TYPES.NVarChar, value: target.awaitingRole },
      { name: "OldStatus", type: TYPES.NVarChar, value: savedStatus ?? "" },
      { name: "OldRole", type: TYPES.NVarChar, value: savedRole ?? "" },
    ],
  );
  if (moved.length === 0) return { advanced: false, from: current, to: null };

  const text = `${opts.note ?? defaultEventText(target, event)} (recorded while on hold; the job returns here when resumed)`;
  await executeQuery(
    connection,
    `INSERT INTO JobEvents
       (JobID, CreatedBy, [Text], EventType, NewStatus, NewAwaitingRole,
        PurchaseOrderID, QuoteID, InvoiceID)
     VALUES
       (@JobID, @CreatedBy, @Text, 'status_while_held', NULL, NULL,
        @PurchaseOrderID, @QuoteID, @InvoiceID);`,
    [
      { name: "JobID", type: TYPES.Int, value: jobId },
      { name: "CreatedBy", type: TYPES.NVarChar, value: opts.actor },
      { name: "Text", type: TYPES.NVarChar, value: text },
      { name: "PurchaseOrderID", type: TYPES.Int, value: opts.purchaseOrderId ?? null },
      { name: "QuoteID", type: TYPES.Int, value: opts.quoteId ?? null },
      { name: "InvoiceID", type: TYPES.Int, value: opts.invoiceId ?? null },
    ],
  );
  if (isWorkCompletion(target.status, target.awaitingRole)) {
    await markServiceJobCompleted(connection, jobId, opts.actor ?? "system");
  }
  return { advanced: false, from: current, to: null, heldUpdated: true };
}

export async function advanceJobStatus(
  connection: Connection,
  jobId: number,
  event: JobEvent,
  opts: AdvanceJobStatusOptions,
): Promise<AdvanceJobStatusResult> {
  const rows = await executeQuery(
    connection,
    "SELECT Status, AwaitingRole FROM Jobs WHERE JobID = @JobID",
    [{ name: "JobID", type: TYPES.Int, value: jobId }],
  );
  if (rows.length === 0) return { advanced: false, from: null, to: null };

  const current: JobState = {
    status: rows[0].Status as JobStatus,
    awaitingRole: (rows[0].AwaitingRole as AwaitingRole) ?? AwaitingRole.FACILITIES,
  };

  // REV-02: a held job (Tenant) answers no event itself, so a quote, purchase
  // order or invoice saved during the hold used to be dropped and the resume
  // landed on a stale state. The event is applied to the saved pre-hold state
  // instead; resuming then lands where the records say the job now is.
  if (current.status === JobStatus.TENANT && event !== JobEvent.TENANT_UNBLOCKED && event !== JobEvent.TENANT_BLOCKED) {
    return advanceHeldJob(connection, jobId, event, opts, current);
  }

  const target = nextState(current, event);
  if (
    target == null ||
    (target.status === current.status && target.awaitingRole === current.awaitingRole)
  ) {
    await executeQuery(
      connection,
      "UPDATE Jobs SET LastModifiedDate = SYSUTCDATETIME() WHERE JobID = @JobID",
      [{ name: "JobID", type: TYPES.Int, value: jobId }],
    );
    return { advanced: false, from: current, to: null };
  }

  const text = opts.note ?? defaultEventText(target, event);

  const moved = await executeQuery(
    connection,
    // A real transition resets the accountability clock (WP18a): StatusSince=now
    // and any prior acknowledgement / escalation is cleared, because a fresh
    // state needs fresh acknowledgement. Mirrors the addJobEvent manual path so
    // system-event transitions (quote received/approved, PO, work complete)
    // behave identically.
    `UPDATE Jobs
       SET Status = @Status,
           AwaitingRole = @AwaitingRole,
           LastModifiedDate = SYSUTCDATETIME(),
           StatusSince = SYSUTCDATETIME(),
           AcknowledgedAt = NULL,
           AcknowledgedBy = NULL,
           EscalatedAt = NULL
     OUTPUT INSERTED.JobID
     WHERE JobID = @JobID
       AND Status = @ExpectedFromStatus
       AND AwaitingRole = @ExpectedFromRole`,
    [
      { name: "JobID", type: TYPES.Int, value: jobId },
      { name: "Status", type: TYPES.NVarChar, value: target.status },
      { name: "AwaitingRole", type: TYPES.NVarChar, value: target.awaitingRole },
      { name: "ExpectedFromStatus", type: TYPES.NVarChar, value: current.status },
      { name: "ExpectedFromRole", type: TYPES.NVarChar, value: current.awaitingRole },
    ],
  );

  // The UPDATE is predicated on the state read above. If the job moved in the
  // meantime no row changed, and a status_change event would describe a move
  // that never happened.
  if (moved.length === 0) return { advanced: false, from: current, to: null };

  await executeQuery(
    connection,
    `INSERT INTO JobEvents
       (JobID, CreatedBy, [Text], EventType, NewStatus, NewAwaitingRole,
        PurchaseOrderID, QuoteID, InvoiceID)
     VALUES
       (@JobID, @CreatedBy, @Text, 'status_change', @NewStatus, @NewAwaitingRole,
        @PurchaseOrderID, @QuoteID, @InvoiceID);`,
    [
      { name: "JobID", type: TYPES.Int, value: jobId },
      { name: "CreatedBy", type: TYPES.NVarChar, value: opts.actor },
      { name: "Text", type: TYPES.NVarChar, value: text },
      { name: "NewStatus", type: TYPES.NVarChar, value: target.status },
      { name: "NewAwaitingRole", type: TYPES.NVarChar, value: target.awaitingRole },
      { name: "PurchaseOrderID", type: TYPES.Int, value: opts.purchaseOrderId ?? null },
      { name: "QuoteID", type: TYPES.Int, value: opts.quoteId ?? null },
      { name: "InvoiceID", type: TYPES.Int, value: opts.invoiceId ?? null },
    ],
  );

  // Service schedules (sprint F2): the work being done moves a scheduled
  // job's schedule on. It happens here, wherever the money record that
  // completes the work is saved, because the browser no longer posts statuses.
  if (isWorkCompletion(target.status, target.awaitingRole)) {
    await markServiceJobCompleted(connection, jobId, opts.actor ?? "system");
  }

  return { advanced: true, from: current, to: target };
}
