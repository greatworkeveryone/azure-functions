// "Covered by Y while X is away until DD/MM", for the jobs a screen is showing. A note
// is the job's latest cover row when it is a hand-over to a cover (not a take-back,
// not a dry run), the job is still with that cover, and the absence has not ended.

import { TYPES, type Connection } from "tedious";
import { executeQuery } from "../db";

export const MAX_NOTE_IDS = 100;

export interface CoverNoteDto {
  awayName: string;
  coverName: string;
  itemId: string;
  /** The first business day back; null when the person has not signed in and no return is known. */
  returnDate: string | null;
}

export async function loadJobCoverNotes(connection: Connection, jobIds: readonly number[], today: string): Promise<CoverNoteDto[]> {
  if (jobIds.length === 0) return [];
  const placeholders = jobIds.map((_, index) => `@J${index}`).join(", ");
  const rows = await executeQuery(
    connection,
    `SELECT c.ItemId, CONVERT(VARCHAR(10), c.ReturnDate, 23) AS ReturnDate, tu.DisplayName AS CoverName, fu.DisplayName AS AwayName
       FROM dbo.CoverActions c
       INNER JOIN dbo.AppUsers tu ON tu.UserID = c.ToUserId
       INNER JOIN dbo.AppUsers fu ON fu.UserID = c.FromUserId
       INNER JOIN dbo.Jobs j ON j.JobID = TRY_CONVERT(INT, c.ItemId) AND j.AssignedToUserID = c.ToUserId AND j.IsArchived = 0 AND j.Status <> N'Done'
      WHERE c.ItemType = N'job' AND c.Action = N'reassigned' AND c.DryRun = 0 AND c.ItemId IN (${placeholders})
        AND c.CoverActionId = (SELECT MAX(x.CoverActionId) FROM dbo.CoverActions x WHERE x.ItemType = N'job' AND x.ItemId = c.ItemId)
        AND (c.ReturnDate IS NULL OR c.ReturnDate > @Today)`,
    [
      ...jobIds.map((id, index) => ({ name: `J${index}`, type: TYPES.NVarChar, value: String(id) })),
      { name: "Today", type: TYPES.Date, value: new Date(`${today}T00:00:00Z`) },
    ],
  );
  return rows.map((row) => ({
    awayName: String(row.AwayName),
    coverName: String(row.CoverName),
    itemId: String(row.ItemId),
    returnDate: typeof row.ReturnDate === "string" ? row.ReturnDate : null,
  }));
}
