// Reassigns an incoming email through its assignment column (Emails.AssignedToUserId,
// added by the inbound triage package), stamping who and why where those columns
// exist. Predicated on the email still being the owner's and not yet filed.

import { TYPES } from "tedious";
import { executeQuery } from "../../db";
import { probeEmailColumns } from "../inventory/emails";
import type { Mover } from "./types";

export const moveEmail: Mover = async (connection, { actorName, from, itemId, reason, to }) => {
  const columns = await probeEmailColumns(connection);
  if (!columns.assignedToUserId) return false;
  const EXTRA_SETS = [
    columns.assignedAt ? ", AssignedAt = SYSUTCDATETIME()" : "",
    columns.assignedBy ? ", AssignedBy = @By" : "",
    columns.assignmentReason ? ", AssignmentReason = @Reason" : "",
  ].join("");
  const moved = await executeQuery(
    connection,
    `UPDATE dbo.Emails SET AssignedToUserId = @To${EXTRA_SETS}
     OUTPUT INSERTED.EmailID
     WHERE EmailID = @Id AND AssignedToUserId = @From AND Status NOT IN (N'promoted', N'archived')`,
    [
      { name: "Id", type: TYPES.Int, value: Number(itemId) },
      { name: "To", type: TYPES.Int, value: to.userId },
      { name: "From", type: TYPES.Int, value: from.userId },
      { name: "By", type: TYPES.NVarChar, value: actorName.slice(0, 160) },
      { name: "Reason", type: TYPES.NVarChar, value: reason.slice(0, 500) },
    ],
  );
  return moved.length > 0;
};
