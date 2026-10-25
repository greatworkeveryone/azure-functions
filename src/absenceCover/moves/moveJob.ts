// Reassigns a job the way upsertJob does: a history entry (assignment_change) and the
// Jobs row's AssignedTo / AssignedToUserID, in one transaction. Status, awaiting side
// and the stall clock are not touched, so the job status machine is not bypassed: a
// reassignment is not a transition. The UPDATE is predicated on the job still being
// the owner's, so a job someone else reassigned meanwhile is left alone.

import { TYPES } from "tedious";
import { executeQuery } from "../../db";
import type { Mover } from "./types";

export const moveJob: Mover = async (connection, { actorName, from, itemId, reason, to }) => {
  const jobId = Number(itemId);
  const current = await executeQuery(
    connection,
    `SELECT AssignedToUserID, Status, IsArchived FROM dbo.Jobs WITH (UPDLOCK, HOLDLOCK) WHERE JobID = @JobID`,
    [{ name: "JobID", type: TYPES.Int, value: jobId }],
  );
  const job = current[0];
  if (!job || Number(job.AssignedToUserID) !== from.userId || job.Status === "Done" || job.IsArchived) return false;
  await executeQuery(
    connection,
    `INSERT INTO dbo.JobEvents (JobID, CreatedBy, [Text], EventType, NewAssignee)
     VALUES (@JobID, @CreatedBy, @Text, N'assignment_change', @NewAssignee)`,
    [
      { name: "JobID", type: TYPES.Int, value: jobId },
      { name: "CreatedBy", type: TYPES.NVarChar, value: actorName },
      { name: "Text", type: TYPES.NVarChar, value: `Reassigned to ${to.name} (was ${from.name}): ${reason}`.slice(0, 2000) },
      { name: "NewAssignee", type: TYPES.NVarChar, value: to.name },
    ],
  );
  const moved = await executeQuery(
    connection,
    `UPDATE dbo.Jobs SET AssignedTo = @Name, AssignedToUserID = @To, LastModifiedDate = SYSUTCDATETIME()
     OUTPUT INSERTED.JobID
     WHERE JobID = @JobID AND AssignedToUserID = @From`,
    [
      { name: "JobID", type: TYPES.Int, value: jobId },
      { name: "Name", type: TYPES.NVarChar, value: to.name },
      { name: "To", type: TYPES.Int, value: to.userId },
      { name: "From", type: TYPES.Int, value: from.userId },
    ],
  );
  return moved.length > 0;
};
