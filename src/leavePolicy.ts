import { AppRole } from "./auth";
export const LEAVE_READ_ROLES = [AppRole.USER] as const;
export const REPORTING_ROLES = [AppRole.CFO, AppRole.DIRECTOR] as const;
export interface StaffMember {
  id: number;
  name: string;
  role: string;
  oid: string;
}
export interface ReportingLink {
  userId: number;
  managerId: number;
}
const senior = ["cfo", "director"];
const managers = [...senior, "facilities_manager", "accounts_manager"];
export function eligibleManager(subject: StaffMember, manager: StaffMember): boolean {
  if (subject.id === manager.id) return false;
  if (["facilities_manager", "accounts_manager", "admin", "cfo", "director", "user"].includes(subject.role))
    return senior.includes(manager.role);
  return (
    senior.includes(manager.role) ||
    (subject.role === "facilities" && manager.role === "facilities_manager") ||
    (subject.role === "accounts" && manager.role === "accounts_manager")
  );
}
export function leaveApprovers(
  subject: StaffMember,
  staff: StaffMember[],
  links: ReportingLink[],
): StaffMember[] {
  const assigned = links.find((link) => link.userId === subject.id);
  return staff.filter(
    (person) => eligibleManager(subject, person) && (!assigned || assigned.managerId === person.id),
  );
}
export function parseReporting(body: Record<string, unknown>, staff: StaffMember[]): ReportingLink[] {
  if (!Array.isArray(body.links) || body.links.length > 500)
    throw new Error("Provide at most 500 reporting relationships");
  const links: ReportingLink[] = body.links.map((raw: unknown) => {
    if (!raw || typeof raw !== "object") throw new Error("Invalid reporting relationship");
    const { userId, managerId } = raw as ReportingLink;
    if (!Number.isInteger(userId) || !Number.isInteger(managerId))
      throw new Error("Choose active staff members");
    const subject = staff.find((person) => person.id === userId),
      manager = staff.find((person) => person.id === managerId);
    if (!subject || !manager || !eligibleManager(subject, manager))
      throw new Error("Choose a qualified manager; managers report to CFO or directors");
    return { userId, managerId };
  });
  if (new Set(links.map((link) => link.userId)).size !== links.length)
    throw new Error("Each person can have one reporting manager");
  for (const link of links) {
    const seen = new Set<number>([link.userId]);
    let cursor: number | undefined = link.managerId;
    while (cursor !== undefined) {
      if (seen.has(cursor)) throw new Error("Reporting relationships cannot form a cycle");
      seen.add(cursor);
      cursor = links.find((item) => item.userId === cursor)?.managerId;
    }
  }
  return links;
}
export const LEAVE_KINDS = ["annual_leave", "personal_leave", "unpaid_leave", "other_leave"] as const;
export function validRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value < 2147483647;
}
export function parseLeave(body: Record<string, unknown>) {
  const date = (value: unknown) =>
    typeof value === "string" &&
    /^20\d{2}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value;
  if (!date(body.startDate) || !date(body.endDate)) throw new Error("Enter valid start and end dates");
  const startDate = body.startDate as string,
    endDate = body.endDate as string,
    days = (Date.parse(endDate) - Date.parse(startDate)) / 86400000 + 1;
  if (days < 1 || days > 366) throw new Error("Use a date range of no more than 366 days");
  if (!LEAVE_KINDS.includes(body.kind as (typeof LEAVE_KINDS)[number]))
    throw new Error("Choose a leave type");
  if (
    typeof body.hours !== "number" ||
    !Number.isFinite(body.hours) ||
    body.hours <= 0 ||
    body.hours > days * 24 ||
    Math.abs(Math.round(body.hours * 100) - body.hours * 100) > 0.000001
  )
    throw new Error("Enter total leave hours, to at most two decimal places");
  if (body.note !== undefined && (typeof body.note !== "string" || body.note.length > 500))
    throw new Error("Keep the note under 500 characters");
  return {
    kind: body.kind as string,
    startDate,
    endDate,
    hours: body.hours,
    note: typeof body.note === "string" ? body.note.trim() : "",
  };
}
export const isLeaveManager = (role: string) => managers.includes(role);
