// Timesheets to approve, and the viewer's own. To approve: sent for approval, not yet approved, not the viewer's own,
// in a role group the viewer manages (managedRoles, the function approveTimesheet calls) or, for a general sheet, the
// viewer is the person's reporting manager or the sheet falls to accounts managers (canApproveGeneralSheet). Admin is
// not asked. Own: this week's sheet from Thursday, and last week's if it was started and never sent; sent and not
// approved is waiting, with who approves it.

import { executeQuery, type SqlRow } from "../../db";
import { managedRoles } from "../../functions/timesheets";
import { canApproveGeneralSheet, generalApproverFor } from "../../timesheetGeneral";
import type { Candidate, SourceAdapter } from "../types";
import { iso, text } from "../util";

const SQL = `SELECT TOP (1000) TimesheetID, UserID, UserDisplayName, CONVERT(CHAR(10), WeekStartDate, 23) AS WeekStart, Role, ReadyForApproval, ReadyForApprovalDate, Approved
  FROM dbo.Timesheets WHERE WeekStartDate >= DATEADD(DAY, -14, CAST(SYSUTCDATETIME() AS DATE)) AND (ReadyForApproval = 1 OR Approved = 0)
  ORDER BY WeekStartDate, TimesheetID`;

const DAY = 86_400_000;
const shown = (key: string): string => {
  const [y, m, d] = key.split("-");
  return `${Number(d)}/${Number(m)}/${y}`;
};

/** Monday of the Darwin date `today`, and its weekday (Mon = 1 ... Sun = 7). */
export function mondayOf(today: string): { monday: string; weekday: number } {
  const at = new Date(`${today}T00:00:00Z`);
  const weekday = at.getUTCDay() === 0 ? 7 : at.getUTCDay();
  return { monday: new Date(at.getTime() - (weekday - 1) * DAY).toISOString().slice(0, 10), weekday };
}

const approverWords = (role: string): string => (role === "accounts" ? "an accounts manager" : "a facilities manager");

export const timesheetsSource: SourceAdapter<SqlRow[]> = {
  name: "timesheets",
  load: (connection) => executeQuery(connection, SQL),
  derive(rows, viewer, ctx) {
    if (viewer.roles.includes("admin") || viewer.oid === null) return [];
    const out: Candidate[] = [];
    const people = { links: ctx.links, staff: ctx.staff };
    const managed = managedRoles(viewer.roles);
    const { monday, weekday } = mondayOf(ctx.today);
    for (const row of rows) {
      const sheetRole = text(row.Role) ?? "general";
      const ready = row.ReadyForApproval === true || row.ReadyForApproval === 1;
      const approved = row.Approved === true || row.Approved === 1;
      const mine = row.UserID === viewer.oid;
      const week = String(row.WeekStart);
      const base = { chasedNext: null, dueAt: null, id: `timesheet:${row.TimesheetID}`, key: `timesheet:${row.TimesheetID}`, kind: "timesheet", place: null };
      if (ready && !approved && !mine) {
        const may = sheetRole === "general" ? canApproveGeneralSheet(viewer.oid, viewer.roles, String(row.UserID), people) : (managed as string[]).includes(sheetRole);
        if (may) {
          out.push({ ...base, canAct: true, from: text(row.UserDisplayName), group: "decide", link: `/timesheets?view=approve&week=${week}`, subject: `${text(row.UserDisplayName) ?? "A timesheet"}, week of ${shown(week)}`, verb: "Approve timesheet", waitingSince: iso(row.ReadyForApprovalDate) });
        }
      } else if (mine && ready && !approved) {
        const who = sheetRole === "general" ? generalApproverFor(viewer.oid, people) : null;
        out.push({ ...base, canAct: false, from: null, group: "waiting", link: `/timesheets?week=${week}`, subject: `Your timesheet, week of ${shown(week)}`, verb: "Waiting for approval", waitingSince: iso(row.ReadyForApprovalDate), with: who ? (who.kind === "manager" ? who.name : "an accounts manager") : approverWords(sheetRole) });
      } else if (mine && !ready && !approved && (week < monday || weekday >= 4)) {
        out.push({ ...base, canAct: true, from: null, group: "do", link: `/timesheets?week=${week}`, subject: `Your timesheet, week of ${shown(week)}`, verb: "Send timesheet", waitingSince: `${week}T00:00:00.000Z` });
      }
    }
    if (weekday >= 4 && !rows.some((row) => row.UserID === viewer.oid && row.WeekStart === monday)) {
      out.push({ canAct: true, chasedNext: null, dueAt: null, from: null, group: "do", id: `timesheet:week:${monday}`, key: `timesheet:week:${monday}`, kind: "timesheet", link: `/timesheets?week=${monday}`, place: null, subject: `Your timesheet, week of ${shown(monday)}`, verb: "Send timesheet", waitingSince: `${monday}T00:00:00.000Z` });
    }
    return out;
  },
};
