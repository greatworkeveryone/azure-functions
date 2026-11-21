// Jobs whose next action waits on the viewer, from the server-derived nextAction every job payload carries (AF2:
// consumed here, never recomputed). Approvals and MYOB recording have their own adapters and their own authority
// check, so those steps are skipped here. A job nobody owns is shown to the people on that side who can pick it up,
// marked as a team item. Jobs the viewer owns that wait on someone else are in "waiting".

import { executeQuery } from "../../db";
import { presentNextAction, type StepViewer } from "../../jobStepPresent";
import type { JobStep, NextAction } from "../../jobStepTypes";
import { withJobSteps } from "../../jobStepFacts";
import type { SourceAdapter } from "../types";
import { holds, iso, jobTitle, num, text } from "../util";
import type { SqlRow } from "../../db";

const NOT_HERE = new Set(["choose_quote", "approve_invoice"]);
const ACCOUNTS_STEPS = new Set(["get_invoice", "approve_invoice", "record_myob"]);

const SQL = `SELECT TOP (1500) j.JobID, j.Title, j.Status, j.AwaitingRole, j.IsContract, j.IsInternal, j.AssignedTo, j.AssignedToUserID,
       j.ApprovedQuoteID, j.StatusSince, j.CreatedAt, j.ExpectedProgressUpdate, j.BuildingID, b.BuildingName
  FROM dbo.Jobs j LEFT JOIN dbo.Buildings b ON b.BuildingID = j.BuildingID
 WHERE j.IsArchived = 0 AND j.IsTest = 0 AND j.Status <> N'Done'
 ORDER BY j.JobID`;

export const jobsSource: SourceAdapter<SqlRow[]> = {
  name: "jobs",
  async load(connection) {
    return withJobSteps(connection, await executeQuery(connection, SQL));
  },
  derive(rows, viewer) {
    const stepViewer: StepViewer = { can: (capability) => holds(viewer, capability), name: viewer.name, oid: viewer.oid, userId: viewer.userId };
    const onFacilities = viewer.roles.some((role) => role === "facilities" || role === "facilities_manager");
    const onAccounts = viewer.roles.some((role) => role === "accounts" || role === "accounts_manager");
    const out = [];
    for (const row of rows) {
      const next = row.NextAction as NextAction | undefined;
      const step = row.Step as JobStep | undefined;
      if (!next || !step || next.action === "downloadPacket") continue;
      if (NOT_HERE.has(step.key) || (step.key === "record_myob" && next.action !== "closeJob")) continue;
      const shown = presentNextAction(next, stepViewer);
      const mine = num(row.AssignedToUserID) !== null && num(row.AssignedToUserID) === viewer.userId;
      const side = ACCOUNTS_STEPS.has(step.key) ? onAccounts : onFacilities;
      const teamItem = !shown.onViewer && !shown.isPassive && next.externalWait === null && side && (next.unassigned || (!next.person && next.waitingOnUserId === null));
      if (!(shown.onViewer && !shown.isPassive) && !teamItem && !mine) continue;
      const doing = (shown.onViewer && !shown.isPassive) || teamItem;
      const target = shown.jumpTarget ? `&step=${shown.jumpTarget}` : "";
      out.push({
        canAct: doing,
        chasedNext: null,
        dueAt: iso(row.ExpectedProgressUpdate),
        from: null,
        group: doing ? ("do" as const) : ("waiting" as const),
        id: `job:${row.JobID}`,
        key: `job:${row.JobID}`,
        kind: "job",
        link: `/jobs?jobId=${row.JobID}${target}`,
        place: text(row.BuildingName),
        subject: jobTitle(row),
        verb: doing ? shown.label : shown.waitLine,
        waitingSince: iso(row.StatusSince) ?? iso(row.CreatedAt),
        with: doing ? null : next.externalWait ?? next.who,
        ...(teamItem && !shown.onViewer ? { team: true } : {}),
      });
    }
    return out;
  },
};
