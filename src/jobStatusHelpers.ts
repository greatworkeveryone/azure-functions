// advanceJobStatus — single source of truth for writes to Jobs.Status and
// Jobs.AwaitingRole. Forward-only: callers fire an event; the helper consults
// the state machine, writes only if it's a legal forward transition, and logs
// a status_change JobEvent. Never throws on a no-op transition — callers
// don't need to know the current state.

import { TYPES } from "tedious";
import type { Connection } from "tedious";
import { executeQuery } from "./db";
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
    case JobEvent.TENANT_BLOCKED:
      return "Waiting on tenant.";
    case JobEvent.TENANT_UNBLOCKED:
      return "Tenant block cleared — back to work.";
    default:
      return `Status changed to ${target.status}.`;
  }
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

  await executeQuery(
    connection,
    `UPDATE Jobs
       SET Status = @Status,
           AwaitingRole = @AwaitingRole,
           LastModifiedDate = SYSUTCDATETIME()
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

  return { advanced: true, from: current, to: target };
}
