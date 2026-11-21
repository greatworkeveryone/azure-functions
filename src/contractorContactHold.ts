// SECA-04: after a contractor's email or ABN changes, a purchase order to that contractor needs the
// sender's tick until a second person (accounts manager, CFO or director, not the editor) confirms the
// change, or two business days have passed. Pure: the handler passes the stored columns and the clock.

export const HOLD_BUSINESS_DAYS = 2;

export interface ContactChangeFacts {
  changedAt: Date | null;
  changedBy: string | null;
  confirmedAt: Date | null;
}

/** The moment the hold ends: `days` weekdays after the change (Saturday and Sunday do not count). */
export function holdEndsAt(changedAt: Date, days: number = HOLD_BUSINESS_DAYS): Date {
  const end = new Date(changedAt.getTime());
  let left = days;
  while (left > 0) {
    end.setUTCDate(end.getUTCDate() + 1);
    const day = end.getUTCDay();
    if (day !== 0 && day !== 6) left -= 1;
  }
  return end;
}

/** True while the sender has to tick that they have checked the new address. */
export function contactChangeHolds(facts: ContactChangeFacts, now: Date = new Date()): boolean {
  if (!facts.changedAt || facts.confirmedAt) return false;
  return now.getTime() < holdEndsAt(facts.changedAt).getTime();
}

/** "Email changed on 21/11/2026 by Sam Lee" with the date as Darwin sees it (UTC+9:30, no daylight saving). */
export function contactChangeSentence(facts: Pick<ContactChangeFacts, "changedAt" | "changedBy">): string {
  const when = facts.changedAt ? new Date(facts.changedAt.getTime() + 9.5 * 3600_000) : null;
  const date = when ? `${when.getUTCDate()}/${when.getUTCMonth() + 1}/${when.getUTCFullYear()}` : "an unknown date";
  return `Email changed on ${date}${facts.changedBy ? ` by ${facts.changedBy}` : ""}`;
}

/** The columns whose change redirects money: the email address and the ABN. Compared trimmed and case-folded. */
export function contactDetailsChanged(
  before: { ABN?: string | null; EmailAddress?: string | null },
  after: { ABN?: string | null; EmailAddress?: string | null },
): boolean {
  const norm = (value: string | null | undefined) => (value ?? "").trim().toLowerCase();
  return norm(before.EmailAddress) !== norm(after.EmailAddress) || norm(before.ABN) !== norm(after.ABN);
}

/** Who a hold started by the myBuildings sync is attributed to: nobody in Floorplan, so nobody can tick past it as the editor. */
export const SYNC_CHANGED_BY = "myBuildings sync";
