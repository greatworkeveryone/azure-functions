// A person's expected way of using Floorplan (decision 15): when, from where.
// Stored as JSON in dbo.AppUsers.AccessProfile (migration 131); NULL means the
// role's default. Departures are recorded as anomalies, never blocked.

export interface AccessProfile {
  /** Field staff may work out of hours on a call-out (ordinary requests only). */
  callOutAllowed: boolean;
  /** ISO 3166-1 alpha-2 codes, upper case. */
  countries: string[];
  /** ISO weekdays, 1 = Monday … 7 = Sunday. */
  days: number[];
  /** "HH:MM", exclusive; "24:00" means end of day. */
  hoursEnd: string;
  /** "HH:MM", inclusive. */
  hoursStart: string;
  /** IANA zone the window is read in. */
  timeZone: string;
}

export const DARWIN_TZ = "Australia/Darwin";

const CALL_OUT_ROLES = new Set(["facilities", "facilities_manager"]);
const HHMM = /^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/;
const COUNTRY = /^[A-Z]{2}$/;
const MAX_COUNTRIES = 20;

export function defaultAccessProfile(role: string | null): AccessProfile {
  return {
    callOutAllowed: role !== null && CALL_OUT_ROLES.has(role),
    countries: ["AU"],
    days: [1, 2, 3, 4, 5, 6],
    hoursEnd: "20:00",
    hoursStart: "06:00",
    timeZone: DARWIN_TZ,
  };
}

export function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

export function isTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || !value) return false;
  try {
    new Intl.DateTimeFormat("en-AU", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function normaliseCountries(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_COUNTRIES) return null;
  const codes = value.map((c) => (typeof c === "string" ? c.trim().toUpperCase() : ""));
  if (!codes.every((c) => COUNTRY.test(c))) return null;
  return [...new Set(codes)];
}

function normaliseDays(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  if (!value.every((d) => Number.isInteger(d) && d >= 1 && d <= 7)) return null;
  return [...new Set(value as number[])].sort((a, b) => a - b);
}

type Validation = { ok: true; profile: AccessProfile } | { error: string; ok: false };

/** Admin input → a complete profile, or the first thing wrong with it. */
export function validateAccessProfile(input: unknown): Validation {
  if (!input || typeof input !== "object") return { error: "An access profile object is required", ok: false };
  const raw = input as Record<string, unknown>;
  if (!isTimeZone(raw.timeZone)) return { error: "timeZone must be a valid IANA time zone, e.g. Australia/Darwin", ok: false };
  for (const field of ["hoursStart", "hoursEnd"] as const) {
    if (typeof raw[field] !== "string" || !HHMM.test(raw[field] as string)) {
      return { error: `${field} must be HH:MM`, ok: false };
    }
  }
  const hoursStart = raw.hoursStart as string;
  const hoursEnd = raw.hoursEnd as string;
  if (minutesOf(hoursEnd) <= minutesOf(hoursStart)) {
    return { error: "hoursEnd must be after hoursStart (windows cannot cross midnight)", ok: false };
  }
  const days = normaliseDays(raw.days);
  if (!days) return { error: "days must list weekdays 1 (Monday) to 7 (Sunday)", ok: false };
  const countries = normaliseCountries(raw.countries);
  if (!countries) return { error: `countries must list 1–${MAX_COUNTRIES} two-letter country codes`, ok: false };
  if (typeof raw.callOutAllowed !== "boolean") return { error: "callOutAllowed must be true or false", ok: false };
  return {
    ok: true,
    profile: { callOutAllowed: raw.callOutAllowed, countries, days, hoursEnd, hoursStart, timeZone: raw.timeZone as string },
  };
}

/** The stored JSON read leniently: a damaged field falls back to the role's
 *  default rather than switching monitoring off for that person. */
export function parseStoredProfile(json: string | null, role: string | null): AccessProfile {
  const fallback = defaultAccessProfile(role);
  if (!json) return fallback;
  let raw: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== "object") return fallback;
    raw = parsed as Record<string, unknown>;
  } catch {
    return fallback;
  }
  const start = typeof raw.hoursStart === "string" && HHMM.test(raw.hoursStart) ? raw.hoursStart : null;
  const end = typeof raw.hoursEnd === "string" && HHMM.test(raw.hoursEnd) ? raw.hoursEnd : null;
  const windowOk = start !== null && end !== null && minutesOf(end) > minutesOf(start);
  return {
    callOutAllowed: typeof raw.callOutAllowed === "boolean" ? raw.callOutAllowed : fallback.callOutAllowed,
    countries: normaliseCountries(raw.countries) ?? fallback.countries,
    days: normaliseDays(raw.days) ?? fallback.days,
    hoursEnd: windowOk ? (end as string) : fallback.hoursEnd,
    hoursStart: windowOk ? (start as string) : fallback.hoursStart,
    timeZone: isTimeZone(raw.timeZone) ? raw.timeZone : fallback.timeZone,
  };
}
