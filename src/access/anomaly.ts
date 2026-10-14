import { minutesOf, type AccessProfile } from "./profile";

// The four access-pattern rules of decision 15, as pure functions. Nothing here
// blocks a request (S11 blocks money actions); a finding becomes an
// AccessEvents.Anomaly value, an access.anomaly ledger row and a line in the
// daily report. The same rules, evaluated on App Insights' own geolocation,
// are the alert rules in docs/runbooks/monitoring.md.

export type AccessKind = "money" | "request" | "signin";
export type AnomalyCode = "burst" | "new_country" | "new_device" | "outside_window";

/** Most serious first; AccessEvents.Anomaly stores the first that applies. */
export const ANOMALY_SEVERITY: readonly AnomalyCode[] = ["new_country", "burst", "outside_window", "new_device"];

export const BURST_DESCRIPTION = "more than 300 requests in 5 minutes";

// Ordinary requests out of hours are expected from these roles; their money
// actions are still checked against the window.
const WINDOW_EXEMPT_ROLES = new Set(["admin", "director"]);

export interface AccessFacts {
  at: Date;
  burst: boolean;
  /** Client-reported country (x-fp-country); null when unknown. */
  country: string | null;
  /** The user agent hash was seen for this person in the last 90 days. */
  deviceSeen: boolean;
  /** The person has any earlier access event: the first device is a baseline. */
  hasHistory: boolean;
  kind: AccessKind;
  profile: AccessProfile;
  role: string | null;
}

export interface LocalClock {
  hour: number;
  isoDay: number;
  minute: number;
}

const WEEKDAY: Record<string, number> = { Fri: 5, Mon: 1, Sat: 6, Sun: 7, Thu: 4, Tue: 2, Wed: 3 };
const DAY_NAMES = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function localClock(at: Date, timeZone: string): LocalClock {
  const parts = new Intl.DateTimeFormat("en-AU", {
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    timeZone,
    weekday: "short",
  }).formatToParts(at);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  return { hour: Number(get("hour")) % 24, isoDay: WEEKDAY[get("weekday")] ?? 0, minute: Number(get("minute")) };
}

export function withinWindow(clock: LocalClock, profile: AccessProfile): boolean {
  if (!profile.days.includes(clock.isoDay)) return false;
  const now = clock.hour * 60 + clock.minute;
  return now >= minutesOf(profile.hoursStart) && now < minutesOf(profile.hoursEnd);
}

export function evaluateAccess(facts: AccessFacts): AnomalyCode[] {
  const found = new Set<AnomalyCode>();
  const { profile } = facts;

  if (facts.country && !profile.countries.includes(facts.country)) found.add("new_country");
  if (facts.burst) found.add("burst");

  if (!withinWindow(localClock(facts.at, profile.timeZone), profile)) {
    const excused =
      facts.kind !== "money" &&
      ((facts.role !== null && WINDOW_EXEMPT_ROLES.has(facts.role)) || profile.callOutAllowed);
    if (!excused) found.add("outside_window");
  }

  if (facts.hasHistory && !facts.deviceSeen) found.add("new_device");

  return ANOMALY_SEVERITY.filter((code) => found.has(code));
}

export function primaryAnomaly(codes: readonly AnomalyCode[]): AnomalyCode | "none" {
  return codes[0] ?? "none";
}

function describeDays(days: readonly number[]): string {
  const sorted = [...days].sort((a, b) => a - b);
  const contiguous = sorted.every((d, i) => i === 0 || d === sorted[i - 1] + 1);
  if (contiguous && sorted.length > 2) return `${DAY_NAMES[sorted[0]]}–${DAY_NAMES[sorted[sorted.length - 1]]}`;
  return sorted.map((d) => DAY_NAMES[d]).join(", ");
}

const pad = (n: number): string => String(n).padStart(2, "0");

/** One plain sentence for the ledger reason and the daily report. */
export function describeAnomaly(code: AnomalyCode, facts: AccessFacts): string {
  const { profile } = facts;
  switch (code) {
    case "new_country":
      return `Used Floorplan from ${facts.country}, which is not one of this person's expected countries (${profile.countries.join(", ")}).`;
    case "outside_window": {
      const clock = localClock(facts.at, profile.timeZone);
      const what = facts.kind === "money" ? "A money action" : facts.kind === "signin" ? "A sign-in" : "Use of Floorplan";
      return (
        `${what} at ${pad(clock.hour)}:${pad(clock.minute)} ${DAY_NAMES[clock.isoDay]} (${profile.timeZone}), ` +
        `outside the expected ${profile.hoursStart}–${profile.hoursEnd} ${describeDays(profile.days)}.`
      );
    }
    case "burst":
      return `A burst of activity: ${BURST_DESCRIPTION} from one person.`;
    case "new_device":
      return "Signed in from a device or browser not seen for this person in the last 90 days.";
  }
}
