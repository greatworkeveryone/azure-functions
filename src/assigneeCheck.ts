import { TYPES, type Connection } from "tedious";
import { executeQuery } from "./db";

export interface AssigneeRefusal {
  code: "assignee_not_active";
  error: string;
}

const ASSIGNEE_SQL = `SELECT 1 AS Hit FROM dbo.AppUsers WHERE UserID = @UserID AND IsActive = 1 AND EntraOid IS NOT NULL`;

/** A job is handed only to someone active who has signed in at least once (EntraOid set): an invitee
 *  could never see it. The frontend's useAppUsers hides the same people; this is the check that holds. */
export async function assigneeRefusal(connection: Connection, userId: number): Promise<AssigneeRefusal | null> {
  const rows = await executeQuery(connection, ASSIGNEE_SQL, [{ name: "UserID", type: TYPES.Int, value: userId }]);
  if (rows.length > 0) return null;
  return {
    code: "assignee_not_active",
    error: "That person can't be assigned a job: they haven't signed in to Floorplan yet, or their account is off.",
  };
}
