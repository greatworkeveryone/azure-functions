// Incoming emails assigned to an absent person. The assignment column
// (Emails.AssignedToUserId) arrives with the inbound triage package; where it is not
// on this database yet, this adapter finds nothing and says so. Due: one business day
// after the email arrived.

import type { Connection } from "tedious";
import { executeQuery } from "../../db";
import { addBusinessHours } from "../../escalation/businessTime";
import type { CoverItem } from "../types";
import type { InventoryContext } from "./context";
import { intList } from "./sqlList";

const EMAIL_WAIT_HOURS = 8;
const SUBJECT_MAX = 80;

export interface EmailColumns {
  assignedAt: boolean;
  assignedBy: boolean;
  assignedToUserId: boolean;
  assignmentReason: boolean;
}

/** Which assignment columns this database has. */
export async function probeEmailColumns(connection: Connection): Promise<EmailColumns> {
  const rows = await executeQuery(
    connection,
    `SELECT COL_LENGTH(N'dbo.Emails', N'AssignedToUserId') AS ToUser, COL_LENGTH(N'dbo.Emails', N'AssignedAt') AS At,
            COL_LENGTH(N'dbo.Emails', N'AssignedBy') AS By, COL_LENGTH(N'dbo.Emails', N'AssignmentReason') AS Reason`,
  );
  const row = rows[0] ?? {};
  return {
    assignedAt: row.At != null,
    assignedBy: row.By != null,
    assignedToUserId: row.ToUser != null,
    assignmentReason: row.Reason != null,
  };
}

export async function loadEmailItems(
  connection: Connection,
  userIds: readonly number[],
  columns: EmailColumns,
  context: InventoryContext,
): Promise<CoverItem[]> {
  if (userIds.length === 0 || !columns.assignedToUserId) return [];
  const { params, placeholders } = intList("U", userIds);
  const rows = await executeQuery(
    connection,
    `SELECT e.EmailID, e.Subject, e.FromAddress, e.ReceivedAt, e.AssignedToUserId
       FROM dbo.Emails e
      WHERE e.IsTest = 0 AND e.Status NOT IN (N'promoted', N'archived') AND e.AssignedToUserId IN (${placeholders})`,
    params,
  );
  return rows.map((row): CoverItem => {
    const subject = String(row.Subject ?? "(no subject)").trim() || "(no subject)";
    const received = row.ReceivedAt instanceof Date ? row.ReceivedAt : context.now;
    return {
      capability: "promoteEmail",
      deepLink: "/incoming",
      detail: {},
      dueAt: addBusinessHours(received, EMAIL_WAIT_HOURS, context.holidays),
      id: String(row.EmailID),
      importance: "medium",
      importanceCode: "default",
      isTest: false,
      label: `Email from ${row.FromAddress ?? "an unknown sender"}: ${subject.length > SUBJECT_MAX ? `${subject.slice(0, SUBJECT_MAX)}...` : subject}`,
      minRole: null,
      money: null,
      move: "email_assignee",
      ownerUserId: Number(row.AssignedToUserId),
      personal: false,
      raisedByUserId: null,
      type: "email",
    };
  });
}
