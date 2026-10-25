// Points a live escalation at the cover instead of the absent person: the row's
// TargetUserId, through the escalation store's own versioned update. Only an
// escalation still live and still aimed at the person it is taken from moves.

import { getEscalationRow, updateEscalation } from "../../escalation/store";
import { LIVE_STATUSES } from "../../escalation/types";
import type { Mover } from "./types";

export const moveEscalation: Mover = async (connection, { detail, from, itemId, to }) => {
  const row = await getEscalationRow(connection, Number(itemId), { forUpdate: true });
  if (!row || !LIVE_STATUSES.includes(row.status) || row.targetUserId !== from.userId) return false;
  if (typeof detail.rowVersion === "string" && detail.rowVersion !== "" && detail.rowVersion !== row.rowVersion) return false;
  return updateEscalation(connection, row.escalationId, row.rowVersion, { TargetUserId: to.userId });
};
