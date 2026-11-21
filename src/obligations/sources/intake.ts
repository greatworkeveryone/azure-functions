// Problems staff reported (Report a problem) that are still waiting in Job intake: for the people who triage
// (createWorkRequest, facilities managers and above), a thing to do; for the person who reported it, a thing they
// are waiting on, with where it has got to. A report counts until a job exists for it.

import { executeQuery, type SqlRow } from "../../db";
import type { Candidate, SourceAdapter } from "../types";
import { holds, iso, text } from "../util";

const SQL = `SELECT TOP (200) wr.WorkRequestID, wr.BuildingName, wr.Details, wr.CreatedAt, wr.ReportedByOid, wr.ReportedByName
  FROM dbo.WorkRequests wr
 WHERE wr.Source = N'staff' AND wr.Status = N'New' AND NOT EXISTS (SELECT 1 FROM dbo.Jobs j WHERE j.WorkRequestID = wr.WorkRequestID)
 ORDER BY wr.WorkRequestID`;

const clip = (value: string): string => (value.length > 90 ? `${value.slice(0, 90)}...` : value);

export const intakeSource: SourceAdapter<SqlRow[]> = {
  name: "intake",
  load: (connection) => executeQuery(connection, SQL),
  derive(rows, viewer) {
    const out: Candidate[] = [];
    for (const row of rows) {
      const own = viewer.oid !== null && row.ReportedByOid === viewer.oid;
      const triage = holds(viewer, "createWorkRequest");
      if (!own && !triage) continue;
      const mine = own && !triage;
      out.push({
        canAct: triage && !own,
        chasedNext: null,
        dueAt: null,
        from: mine ? null : text(row.ReportedByName),
        group: mine || (own && triage) ? "waiting" : "do",
        id: `intake:${row.WorkRequestID}`,
        key: `intake:${row.WorkRequestID}`,
        kind: "intake",
        link: `/jobs/intake?workRequestId=${row.WorkRequestID}`,
        place: text(row.BuildingName),
        subject: clip(text(row.Details) ?? "A reported problem"),
        verb: mine || own ? "Waiting to be looked at" : "Look at reported problem",
        waitingSince: iso(row.CreatedAt),
        with: mine || own ? "Facilities" : null,
      });
    }
    return out;
  },
};
