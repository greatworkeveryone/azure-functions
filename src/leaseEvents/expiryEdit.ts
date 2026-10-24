// An expiry edited by hand (data review S2-3). The open lease events dated for
// the old expiry describe a term the lease no longer has: left open they would
// keep counting as live (no warning, lapse or referral for the new expiry), and a
// referral of the old term could be neither decided nor replaced. They are closed
// as cancelled in the edit's own transaction, each ledgered with why; the
// caller ends their escalations once the edit has committed. Closed, not deleted:
// the row stays as the record. On a database without migration 106 there is
// nothing to close.

import type { Connection } from "tedious";
import { TYPES } from "tedious";
import { executeQuery } from "../db";
import * as ledger from "../ledger";
import type { LedgerActor } from "../ledger";
import { OPEN_LEASE_EVENT_STATES, type LeaseEventState } from "../leaseEventMachine";
import { moveEvent } from "./store";

const OPEN_LIST = OPEN_LEASE_EVENT_STATES.map((state) => `'${state}'`).join(", ");

const display = (iso: string | null): string => {
  const match = (iso ?? "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : "none";
};

export interface ExpiryEdit {
  actor: LedgerActor;
  buildingId: number | null;
  correlationId: string;
  editorName: string;
  newExpiry: string | null;
  oldExpiry: string;
  tenantId: number;
}

/** Closes the tenancy's open events dated for `oldExpiry`; the ids it closed. */
export async function closeEventsForEditedExpiry(connection: Connection, edit: ExpiryEdit): Promise<string[]> {
  const table = await executeQuery(connection, "SELECT OBJECT_ID('dbo.LeaseEvents', 'U') AS Id");
  if (table[0]?.Id == null) return [];
  const open = await executeQuery(
    connection,
    `SELECT LeaseEventId, Type, State, LeaseExpiry FROM dbo.LeaseEvents WITH (UPDLOCK, ROWLOCK)
     WHERE TenantId = @TenantId AND State IN (${OPEN_LIST}) AND LeaseExpiry = @OldExpiry`,
    [
      { name: "TenantId", type: TYPES.Int, value: edit.tenantId },
      { name: "OldExpiry", type: TYPES.Date, value: edit.oldExpiry },
    ],
  );
  const reason = `The lease's expiry was changed from ${display(edit.oldExpiry)} to ${display(edit.newExpiry)} by ${edit.editorName}, so this event no longer applies.`;
  const closed: string[] = [];
  for (const row of open) {
    const leaseEventId = String(row.LeaseEventId);
    const state = String(row.State) as LeaseEventState;
    const moved = await moveEvent(
      connection,
      leaseEventId,
      [state],
      "cancelled",
      "Outcome = 'cancelled', OutcomeReason = @Reason, DecidedByName = @By, DecidedAt = SYSUTCDATETIME()",
      [
        { name: "Reason", type: TYPES.NVarChar, value: reason },
        { name: "By", type: TYPES.NVarChar, value: edit.editorName },
      ],
    );
    if (!moved) continue;
    await ledger.record(connection, {
      action: "lease_event.cancel",
      actor: edit.actor,
      after: { leaseExpiry: edit.newExpiry, state: "cancelled" },
      before: { leaseExpiry: edit.oldExpiry, state, type: row.Type },
      buildingId: edit.buildingId,
      correlationId: edit.correlationId,
      reason,
      ruleApplied: "expiry_edited",
      subject: { id: leaseEventId, type: "lease_event" },
      tenantId: edit.tenantId,
    });
    closed.push(leaseEventId);
  }
  return closed;
}
