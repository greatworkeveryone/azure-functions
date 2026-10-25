// Decision 27: first Facilities action on an admin job, in Darwin calendar days.
import { addDaysIso, todayInDarwin } from "./darwinDate";
export const INITIAL_ADMIN_DEADLINE_DAYS: Readonly<Record<string, number>> = Object.freeze({ Critical: 2, High: 4, Low: 14, Normal: 7 });
export function initialAdminDeadline(priority: string | null | undefined, now: Date = new Date()): string {
  return addDaysIso(todayInDarwin(now), INITIAL_ADMIN_DEADLINE_DAYS[priority ?? "Normal"] ?? 7);
}
