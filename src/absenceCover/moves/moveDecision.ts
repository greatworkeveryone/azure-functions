// Passes a pending decision request to the cover: the cover is added to the people
// asked (DecisionMakers.userIds, so responderStanding lets them answer; the person
// who is away stays named, so the record of who was asked is whole) and the live
// escalation for the request is pointed at them. Taking it back removes the cover
// again. Nothing is answered: this changes only who is asked. The request is read
// locked, and the UPDATE is predicated on its version and on it still pending.

import { TYPES } from "tedious";
import { executeQuery } from "../../db";
import { DECISION_PENDING_POLICY } from "../../escalation/decisionRows";
import { findLiveEscalation, updateEscalation } from "../../escalation/store";
import { getRequestRow } from "../../jobDecisions/store";
import type { Mover } from "./types";

export const moveDecision: Mover = async (connection, { actorName, detail, from, itemId, reason, takeBack, to }) => {
  const request = await getRequestRow(connection, Number(itemId), { forUpdate: true });
  if (!request || request.state !== "pending" || !request.decisionMakers.userIds.includes(from.userId)) return false;
  const asked = request.decisionMakers.userIds.filter((id) => !(takeBack && id === from.userId));
  const userIds = asked.includes(to.userId) ? asked : [...asked, to.userId];
  const updated = await executeQuery(
    connection,
    `UPDATE dbo.JobDecisionRequests SET DecisionMakers = @Makers
     OUTPUT INSERTED.RequestId
     WHERE RequestId = @Id AND State = N'pending' AND RowVersion = @RowVersion`,
    [
      { name: "Id", type: TYPES.Int, value: request.requestId },
      { name: "Makers", type: TYPES.NVarChar, value: JSON.stringify({ role: request.decisionMakers.role, userIds }) },
      { name: "RowVersion", type: TYPES.Binary, value: Buffer.from(request.rowVersion, "base64") },
    ],
  );
  if (updated.length === 0) return false;
  const escalation = await findLiveEscalation(connection, "job", String(request.jobId), DECISION_PENDING_POLICY);
  // Only the first level is the people asked; once it has moved up to their manager that row is theirs.
  if (escalation && escalation.level <= 1 && !(await updateEscalation(connection, escalation.escalationId, escalation.rowVersion, { TargetUserId: to.userId }))) {
    return false;
  }
  await executeQuery(
    connection,
    `INSERT INTO dbo.JobEvents (JobID, CreatedBy, [Text], EventType) VALUES (@JobID, @CreatedBy, @Text, N'comment')`,
    [
      { name: "JobID", type: TYPES.Int, value: Number(detail.jobId ?? request.jobId) },
      { name: "CreatedBy", type: TYPES.NVarChar, value: actorName },
      { name: "Text", type: TYPES.NVarChar, value: `The decision request now goes to ${to.name} (${from.name} is away): ${reason}`.slice(0, 2000) },
    ],
  );
  return true;
};
