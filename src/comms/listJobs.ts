// The history list (EB2): sends newest first, without their wording (the detail view reads that). A person
// sees their own; the managers who approve sends, and admin, see everyone's.

import { TYPES, type Connection } from "tedious";
import { executeQuery } from "../db";
import { JOB_COLUMNS, toJob } from "./rows";
import type { JobRow } from "./types";

export type JobSummary = Omit<JobRow, "bodyMarkdown" | "signature">;

export const LIST_KINDS = ["broadcast", "letter"] as const;

export async function listJobs(connection: Connection, options: { kind: (typeof LIST_KINDS)[number]; limit: number; oid: string | null }): Promise<JobSummary[]> {
  const rows = await executeQuery(
    connection,
    `SELECT TOP (@Limit) ${JOB_COLUMNS}
       FROM dbo.Correspondence c
      WHERE c.Kind = @Kind AND (@Oid IS NULL OR c.CreatedByOid = @Oid)
      ORDER BY c.CorrespondenceId DESC`,
    [
      { name: "Limit", type: TYPES.Int, value: options.limit },
      { name: "Kind", type: TYPES.VarChar, value: options.kind },
      { name: "Oid", type: TYPES.NVarChar, value: options.oid },
    ],
  );
  return rows.map((row) => {
    const { bodyMarkdown: _body, signature: _signature, ...summary } = toJob(row);
    return summary;
  });
}
