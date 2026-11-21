import { TYPES } from "tedious";
import { AppRole } from "./auth";
import { eligibleManager, type ReportingLink, type StaffMember } from "./leavePolicy";
import type { SqlParam } from "./db";

// The "general" timesheet group: people who hold neither a facilities nor an accounts role
// (plain staff). Their hours are approved by the manager on their reporting line (the same
// links leave uses); with no manager on record, an accounts manager approves. Directors, the
// CFO and admin may approve any sheet, as they can in the other groups.

export type TimesheetGroup = "facilities" | "accounts" | "general";

export type GeneralApprover = { kind: "manager"; name: string } | { kind: "accounts" };

export interface PeopleSnapshot {
  links: readonly ReportingLink[];
  staff: readonly StaffMember[];
}

const OPEN_ROLES: readonly string[] = [AppRole.ADMIN, AppRole.CFO, AppRole.DIRECTOR];

/** The named reporting manager, if the person has one on record who is still active and eligible. */
function namedManager(subjectOid: string, people: PeopleSnapshot): StaffMember | null {
  const subject = people.staff.find((person) => person.oid === subjectOid);
  if (!subject) return null;
  const link = people.links.find((entry) => entry.userId === subject.id);
  const manager = link ? people.staff.find((person) => person.id === link.managerId) : undefined;
  return manager && eligibleManager(subject, manager) ? manager : null;
}

/** Who approves this person's general sheet, in words the screen can use. */
export function generalApproverFor(subjectOid: string, people: PeopleSnapshot): GeneralApprover {
  const manager = namedManager(subjectOid, people);
  return manager ? { kind: "manager", name: manager.name } : { kind: "accounts" };
}

/** Whether `callerOid` (holding `roles`) may act as approver on `subjectOid`'s general sheet. */
export function canApproveGeneralSheet(callerOid: string, roles: readonly string[], subjectOid: string, people: PeopleSnapshot): boolean {
  if (roles.some((role) => OPEN_ROLES.includes(role))) return true;
  const manager = namedManager(subjectOid, people);
  if (manager) return manager.oid === callerOid;
  return roles.includes(AppRole.ACCOUNTS_APPROVAL);
}

/** True when the caller's role alone opens every general sheet (no per-person lookup needed). */
export function opensEveryGeneralSheet(roles: readonly string[]): boolean {
  return roles.some((role) => OPEN_ROLES.includes(role));
}

/** The people whose general sheet the caller approves, when the role alone does not say. */
export function generalSubjectsFor(callerOid: string, roles: readonly string[], people: PeopleSnapshot, isGeneral: (role: string) => boolean): string[] {
  return people.staff
    .filter((person) => isGeneral(person.role) && person.oid !== callerOid && canApproveGeneralSheet(callerOid, roles, person.oid, people))
    .map((person) => person.oid);
}

/**
 * SQL for "sheets in the caller's groups": plain role groups, plus general sheets either all
 * (opens-every-sheet roles) or only the listed subjects. Parameters are pushed onto `params`.
 */
export function timesheetScopeSql(
  groups: readonly TimesheetGroup[],
  generalSubjects: readonly string[] | "all",
  params: SqlParam[],
  prefix = "Scope",
): string {
  const plain = groups.filter((group) => group !== "general");
  const parts: string[] = [];
  const wantsGeneral = groups.includes("general");
  const roleList = [...plain, ...(wantsGeneral && generalSubjects === "all" ? ["general"] : [])];
  if (roleList.length > 0) {
    parts.push(`Role IN (${roleList.map((_, i) => `@${prefix}Role${i}`).join(", ")})`);
    roleList.forEach((role, i) => params.push({ name: `${prefix}Role${i}`, type: TYPES.NVarChar, value: role }));
  }
  if (wantsGeneral && generalSubjects !== "all" && generalSubjects.length > 0) {
    parts.push(`(Role = N'general' AND UserID IN (${generalSubjects.map((_, i) => `@${prefix}Subject${i}`).join(", ")}))`);
    generalSubjects.forEach((oid, i) => params.push({ name: `${prefix}Subject${i}`, type: TYPES.NVarChar, value: oid }));
  }
  return parts.length > 0 ? `(${parts.join(" OR ")})` : "1 = 0";
}
