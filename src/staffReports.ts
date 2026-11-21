// "Report a problem" for plain staff (decision D4): the pure rules. A report is a row in
// dbo.WorkRequests with Source = 'staff', so it lands in Job intake beside the myBuildings
// requests and is triaged the same way. Its WorkRequestID comes from a range myBuildings
// never reaches. The frontend repeats STAFF_REPORT_ID_BASE to mark such rows in the list.

export const STAFF_REPORT_ID_BASE = 1_900_000_000;
export const STAFF_REPORT_MAX_DETAILS = 1000;

export type ReportStage = "received" | "job" | "closed";

export interface ReportInput {
  buildingId: number;
  details: string;
}

/** Validates a report body. The reporter is never read from it: identity comes from the token. */
export function parseStaffReport(body: Record<string, unknown>): ReportInput {
  const buildingId = body.buildingId;
  if (typeof buildingId !== "number" || !Number.isInteger(buildingId)) throw new Error("Choose the building the problem is in");
  const details = typeof body.details === "string" ? body.details.trim() : "";
  if (!details) throw new Error("Say what is wrong");
  if (details.length > STAFF_REPORT_MAX_DETAILS) throw new Error(`Keep it to ${STAFF_REPORT_MAX_DETAILS} characters`);
  return { buildingId, details };
}

/** Where a report is, in the reporter's words: received, turned into a job, or closed. */
export function reportStage(row: { IsArchived?: unknown; JobID?: unknown; JobStatus?: unknown }): ReportStage {
  if (row.JobID == null) return "received";
  return row.JobStatus === "Done" || row.IsArchived ? "closed" : "job";
}
