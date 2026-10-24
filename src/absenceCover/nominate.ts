// "Who covers for me": nominating a cover for dates (optionally for a leave request),
// and ending a nomination. The person nominates for themselves; their reporting-line
// manager, a manager of their team, the CFO or a director can nominate for them. The
// cover must be an active person who works in Floorplan and is not admin. A nomination
// is ended, never deleted, and several can overlap: the newest one in force wins.

import { TYPES, type Connection } from "tedious";
import { addDaysIso, daysBetweenIso, isIsoDate } from "../darwinDate";
import { executeQuery } from "../db";
import { listActiveUsers } from "../escalation/store";
import { ROLES } from "../escalation/roles";
import { loadPeople } from "../peopleWorkflow";
import { inTeamOf, type CoverCaller } from "./access";
import { archiveDelegateRow, getDelegate, insertDelegate, listUpcomingDelegates, type DelegateRow } from "./delegateStore";
import { coverError } from "./errors";
import { holdsCapability } from "./eligibility";

export const MAX_NOMINATION_DAYS = 366;
const REASON_MAX = 200;

export interface NominationInput {
  delegateUserId: number;
  fromDate: string;
  leaveRequestId: number | null;
  toDate: string;
  userId: number | null;
}

const asId = (value: unknown, field: string, optional = false): number | null => {
  if ((value === undefined || value === null) && optional) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw coverError.badRequest(`${field} must be a person or request id.`);
  return value;
};

export function parseNomination(body: Record<string, unknown>): NominationInput {
  const delegateUserId = asId(body.delegateUserId, "delegateUserId") as number;
  const from = body.fromDate;
  const to = body.toDate;
  if (!isIsoDate(from) || !isIsoDate(to)) throw coverError.badRequest("Choose the first and last day the cover is needed.");
  if (to < from) throw coverError.badRequest("The last day cannot be before the first.");
  if (daysBetweenIso(from, to) + 1 > MAX_NOMINATION_DAYS) throw coverError.badRequest(`Choose at most ${MAX_NOMINATION_DAYS} days.`);
  return { delegateUserId, fromDate: from, leaveRequestId: asId(body.leaveRequestId, "leaveRequestId", true), toDate: to, userId: asId(body.userId, "userId", true) };
}

export interface NominationDto {
  coverDelegateId: number;
  delegateName: string;
  delegateUserId: number;
  fromDate: string;
  leaveRequestId: number | null;
  rowVersion: string;
  toDate: string;
  userId: number;
  userName: string;
}

export const toNominationDto = (row: DelegateRow): NominationDto => ({
  coverDelegateId: row.coverDelegateId,
  delegateName: row.delegateName,
  delegateUserId: row.delegateUserId,
  fromDate: row.fromDate,
  leaveRequestId: row.leaveRequestId,
  rowVersion: row.rowVersion,
  toDate: row.toDate,
  userId: row.userId,
  userName: row.userName,
});

/** Self, the person's reporting-line manager, or a manager of their team (not admin). */
async function mayNominateFor(connection: Connection, caller: CoverCaller, subjectId: number, subjectRole: string): Promise<boolean> {
  if (caller.userId === subjectId) return true;
  const { links } = await loadPeople(connection);
  if (links.some((link) => link.userId === subjectId && link.managerId === caller.userId)) return true;
  return inTeamOf(caller, subjectRole);
}

async function checkLeave(connection: Connection, leaveRequestId: number, userId: number): Promise<void> {
  const rows = await executeQuery(connection, `SELECT UserId, Status FROM dbo.LeaveRequests WHERE RequestId = @Id`, [
    { name: "Id", type: TYPES.Int, value: leaveRequestId },
  ]);
  const leave = rows[0];
  if (!leave || Number(leave.UserId) !== userId) throw coverError.notFound("That leave request is not theirs.");
  if (leave.Status !== "pending" && leave.Status !== "approved") throw coverError.refused("leave_not_live", "That leave request is no longer pending or approved.");
}

export async function saveNomination(connection: Connection, caller: CoverCaller, input: NominationInput, today: string): Promise<{ created: boolean; nomination: NominationDto }> {
  const directory = await listActiveUsers(connection);
  const subjectId = input.userId ?? caller.userId;
  const subject = directory.find((user) => user.userId === subjectId);
  if (!subject) throw coverError.notFound("That person is not an active user.");
  if (!(await mayNominateFor(connection, caller, subject.userId, subject.role))) {
    throw coverError.forbidden("Only they, their manager or their team's manager can choose who covers for them.");
  }
  const delegate = directory.find((user) => user.userId === input.delegateUserId);
  if (!delegate) throw coverError.refused("delegate_not_active", "That person is not an active user, so they cannot cover.");
  if (delegate.userId === subject.userId) throw coverError.refused("delegate_is_self", "Choose someone else to cover.");
  if (delegate.role === ROLES.admin || !holdsCapability(delegate.role, "viewEscalations")) {
    throw coverError.refused("delegate_cannot_cover", `${delegate.name} cannot take on this work, so choose someone else.`);
  }
  if (input.toDate < addDaysIso(today, -1)) throw coverError.refused("dates_past", "Those dates have already passed.");
  if (input.leaveRequestId !== null) await checkLeave(connection, input.leaveRequestId, subject.userId);

  const same = (await listUpcomingDelegates(connection, today, subject.userId)).find(
    (row) => row.userId === subject.userId && row.delegateUserId === delegate.userId && row.fromDate === input.fromDate && row.toDate === input.toDate,
  );
  if (same) return { created: false, nomination: toNominationDto(same) };
  const id = await insertDelegate(connection, {
    createdBy: caller.name,
    createdByUserId: caller.userId,
    delegateUserId: delegate.userId,
    fromDate: input.fromDate,
    leaveRequestId: input.leaveRequestId,
    toDate: input.toDate,
    userId: subject.userId,
  });
  const saved = await getDelegate(connection, id);
  if (!saved) throw new Error("The nomination was not saved");
  return { created: true, nomination: toNominationDto(saved) };
}

export async function archiveNomination(connection: Connection, caller: CoverCaller, id: number, rowVersion: string, reason: string | null): Promise<void> {
  const row = await getDelegate(connection, id, true);
  if (!row || row.archivedAt !== null) throw coverError.notFound("That nomination has already ended.");
  const directory = await listActiveUsers(connection);
  const subject = directory.find((user) => user.userId === row.userId);
  const mayEnd = row.userId === caller.userId || (subject !== undefined && (await mayNominateFor(connection, caller, row.userId, subject.role)));
  if (!mayEnd) throw coverError.forbidden("Only they, their manager or their team's manager can end this.");
  if (row.rowVersion !== rowVersion) throw coverError.changed();
  const text = (reason ?? "").trim().slice(0, REASON_MAX) || "Ended by hand";
  if (!(await archiveDelegateRow(connection, id, rowVersion, { name: caller.name, userId: caller.userId }, text))) throw coverError.changed();
}

export async function listNominations(connection: Connection, caller: CoverCaller, today: string, subjectId: number | null): Promise<NominationDto[]> {
  const target = subjectId ?? caller.userId;
  if (target !== caller.userId) {
    const subject = (await listActiveUsers(connection)).find((user) => user.userId === target);
    if (!subject || !(await mayNominateFor(connection, caller, subject.userId, subject.role))) throw coverError.forbidden("You cannot see their cover nominations.");
  }
  return (await listUpcomingDelegates(connection, today, target)).map(toNominationDto);
}
