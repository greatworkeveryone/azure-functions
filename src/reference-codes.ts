// Reference numbers in the CFO's MYOB format (Johanne's "Standard codes for
// Consistency across AR and AP" sheet):
//
//   Purchase Order # = Building ID + Charge Code + Date    e.g. 66Sm261013
//
// Pure module, no DB. Codes are CASE-SENSITIVE ("McM", "SECr"); never fold
// case when matching them.

// MYOB documents a purchase `Number` (Bill and Purchase Order) as String(13).
// The sheet says "limit 16"; the API limit is the binding one.
export const MYOB_PURCHASE_NUMBER_MAX = 13;

export const REFERENCE_TIME_ZONE = "Australia/Darwin";

// ── Code tables ──────────────────────────────────────────────────────────────

export const CHARGE_CODES: Readonly<Record<string, string>> = {
  ad: "Advertisement",
  bc: "Body corporate",
  cl: "Cleaning",
  cc: "Credit card",
  cs: "Computer support / software",
  d: "Donation",
  e: "Electrical maintenance",
  ed: "Education",
  el: "Electricity (private)",
  en: "Entertainment",
  fa: "Fire alarm",
  fs: "Fire service",
  ft: "Fire testing etc",
  gas: "Gas",
  gm: "Grounds / gardening",
  ins: "Insurance",
  k: "Keys, fobs and access",
  le: "Legal / professional",
  lm: "Lift maintenance",
  m: "Maintenance",
  me: "Mechanical",
  os: "Office supplies",
  pr: "Project",
  pc: "Petty cash",
  ph: "Telephone / broadband / ADSL / internet",
  ps: "Printing service",
  pd: "Personal development",
  pm: "Pool maintenance",
  po: "Postage",
  q: "Quote",
  ra: "Rates",
  reg: "Registration",
  s: "Service equipment",
  se: "Security",
  sh: "Shares",
  st: "Stationery",
  t: "Testing",
  tx: "Tax",
  tr: "Travel",
  vf: "Vehicle fuel",
  vh: "Vehicle hire",
  vr: "Vehicle repair & maintenance",
  vt: "Vehicle transfer",
  w: "Waste removal",
  wa: "Water",
  // Legacy only: never assigned automatically.
  SECr: "Chubb residencies",
};

// Not buildings and not adopted for new references; kept so legacy MYOB
// references still decode.
export const NON_BUILDING_CODES: Readonly<Record<string, string>> = {
  OE: "Office expenses (not a building)",
  TU: "Toyota Ute (vehicle)",
  FU: "Ford Ute (vehicle)",
  HMC: "Honda Motor Cycle (vehicle)",
  TR: "Trailer (vehicle)",
  MS: "Microsoft (Paradise Data) (vendor)",
  ALL: "Many buildings",
};

export const LEGACY_BUILDING_CODES: Readonly<Record<string, string>> = {
  "10G": "10 Georgina Crescent",
  "12G": "12 Georgina Crescent",
  "23T": "23 Temira Crt",
  "24G": "24 Gunbar",
  "26G": "26 Gunbar",
  "2P": "2 Palmerston Circuit",
  "30D": "30 Daly Street",
  "45S": "45 Stuart Highway",
  "49S": "49 Stuart Highway",
  "4S": "4 Searcy Carpark",
  "66S": "66 Smith St",
  "6S": "6 Searcy",
  "7M": "7 Melville St",
  "86M": "86 Mitchell Street",
  "9C": "9-11 Cavanagh Street",
  "9M": "9 Melville St",
  ALB: "Albatross Street",
  HA: "47 Stuart Highway, Highway Arcade",
  // Handwriting on the sheet is unclear; confirm with Johanne.
  HB: "Lot C - Hingston Beach",
  HH: "Highway House",
  LT: "Lambell Terrace",
  MAN: "3/5 Mangola Crt",
  McM: "McMinn Street",
  RCK: "Randazzo Centre, Katherine",
};

// ── Dates (Australia/Darwin) ─────────────────────────────────────────────────

const darwinFormat = new Intl.DateTimeFormat("en-AU", {
  timeZone: REFERENCE_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Calendar date in Darwin. UTC is wrong here: Darwin is UTC+9:30 with no
 *  DST, so before 09:30 local the UTC date is still yesterday. */
export function darwinDate(date: Date): { year: number; month: number; day: number } {
  const parts = darwinFormat.formatToParts(date);
  const pick = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { year: pick("year"), month: pick("month"), day: pick("day") };
}

export function formatDarwinYYMMDD(date: Date): string {
  const { year, month, day } = darwinDate(date);
  return `${String(year % 100).padStart(2, "0")}${String(month).padStart(2, "0")}${String(day).padStart(2, "0")}`;
}

// ── Formatting ───────────────────────────────────────────────────────────────

const SUFFIX_LETTERS = "bcdefghijklmnopqrstuvwxyz";
const CODE_CHARS = /^[A-Za-z0-9]+$/;

/**
 * `{building}{charge}{YYMMDD}`, e.g. `66Sm261013`. A second PO on the same
 * building, charge and day gets a lowercase suffix `b`..`z`. Throws rather
 * than truncating: a number MYOB would reject must not reach the database.
 */
export function formatPoReference(input: {
  buildingCode: string;
  chargeCode: string;
  date: Date;
  existing: readonly string[];
}): string {
  const { buildingCode, chargeCode, date, existing } = input;
  if (!CODE_CHARS.test(buildingCode)) throw new Error(`Invalid building code "${buildingCode}"`);
  if (!CODE_CHARS.test(chargeCode)) throw new Error(`Invalid charge code "${chargeCode}"`);

  const base = `${buildingCode}${chargeCode}${formatDarwinYYMMDD(date)}`;
  const taken = new Set(existing);
  let reference = base;
  if (taken.has(base)) {
    const free = [...SUFFIX_LETTERS].find((letter) => !taken.has(`${base}${letter}`));
    if (!free) throw new Error(`No free suffix left for reference ${base}`);
    reference = `${base}${free}`;
  }
  if (reference.length > MYOB_PURCHASE_NUMBER_MAX) {
    throw new Error(
      `Reference ${reference} is ${reference.length} characters; MYOB allows ${MYOB_PURCHASE_NUMBER_MAX}`,
    );
  }
  return reference;
}

// ── Parsing ──────────────────────────────────────────────────────────────────

export type ReferencePeriodKind = "day" | "month" | "year" | "twoYear" | "half" | "quarter";

export interface ReferencePeriod {
  kind: ReferencePeriodKind;
  /** Inclusive, ISO YYYY-MM-DD, as Darwin calendar dates. */
  from: string;
  to: string;
}

export interface ParsedReference {
  buildingCode: string;
  buildingLabel: string;
  chargeCode: string;
  period: ReferencePeriod;
  /** Lowercase b..z added by formatPoReference on a same-day collision. */
  suffix: string | null;
}

const pad2 = (n: number) => String(n).padStart(2, "0");
const isoDate = (year: number, month: number, day: number) => `${year}-${pad2(month)}-${pad2(day)}`;
const lastDayOfMonth = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();

function monthSpan(year: number, firstMonth: number, lastMonth: number): { from: string; to: string } {
  return {
    from: isoDate(year, firstMonth, 1),
    to: isoDate(year, lastMonth, lastDayOfMonth(year, lastMonth)),
  };
}

/** Date part of a reference (no collision suffix), or null if it is not one. */
function parsePeriod(text: string): ReferencePeriod | null {
  let m = text.match(/^(\d{2})(\d{2})(\d{2})$/);
  if (m) {
    const year = 2000 + Number(m[1]);
    const month = Number(m[2]);
    const day = Number(m[3]);
    if (month < 1 || month > 12 || day < 1 || day > lastDayOfMonth(year, month)) return null;
    const iso = isoDate(year, month, day);
    return { kind: "day", from: iso, to: iso };
  }
  m = text.match(/^(\d{2})(\d{2})$/);
  if (m) {
    const month = Number(m[2]);
    if (month < 1 || month > 12) return null;
    return { kind: "month", ...monthSpan(2000 + Number(m[1]), month, month) };
  }
  m = text.match(/^(\d{2})a$/);
  if (m) return { kind: "year", ...monthSpan(2000 + Number(m[1]), 1, 12) };
  m = text.match(/^(\d{2})a2$/);
  if (m) {
    // The sheet defines the date part as the last date of service, so YY is
    // the final year of the two.
    const last = 2000 + Number(m[1]);
    return { kind: "twoYear", from: isoDate(last - 1, 1, 1), to: isoDate(last, 12, 31) };
  }
  m = text.match(/^(\d{2})s([12])$/);
  if (m) {
    const first = m[2] === "1" ? 1 : 7;
    return { kind: "half", ...monthSpan(2000 + Number(m[1]), first, first + 5) };
  }
  m = text.match(/^(\d{2})q([1-4])$/);
  if (m) {
    const first = (Number(m[2]) - 1) * 3 + 1;
    return { kind: "quarter", ...monthSpan(2000 + Number(m[1]), first, first + 2) };
  }
  return null;
}

const byLengthDesc = (a: string, b: string) => b.length - a.length;

/**
 * Every valid decomposition of a legacy or current reference. Building codes
 * are tried longest-first, then charge codes; the rest must be exactly one
 * date part, optionally followed by a collision suffix. Case-sensitive.
 *
 * `extraBuildingCodes` carries codes that exist only in the database
 * (Buildings.ReferenceCode) so this module needs no DB access.
 */
export function parseReference(
  ref: string,
  extraBuildingCodes: Readonly<Record<string, string>> = {},
): ParsedReference[] {
  const text = (ref ?? "").trim();
  if (!text) return [];

  const buildings: Record<string, string> = {
    ...extraBuildingCodes,
    ...LEGACY_BUILDING_CODES,
    ...NON_BUILDING_CODES,
  };
  const buildingCodes = Object.keys(buildings).sort(byLengthDesc);
  const chargeCodes = Object.keys(CHARGE_CODES).sort(byLengthDesc);

  const results: ParsedReference[] = [];
  for (const buildingCode of buildingCodes) {
    if (!text.startsWith(buildingCode)) continue;
    const afterBuilding = text.slice(buildingCode.length);
    for (const chargeCode of chargeCodes) {
      if (!afterBuilding.startsWith(chargeCode)) continue;
      const datePart = afterBuilding.slice(chargeCode.length);
      const buildingLabel = buildings[buildingCode];

      const bare = parsePeriod(datePart);
      if (bare) results.push({ buildingCode, buildingLabel, chargeCode, period: bare, suffix: null });

      const last = datePart.slice(-1);
      if (datePart.length > 1 && last >= "b" && last <= "z") {
        const withSuffix = parsePeriod(datePart.slice(0, -1));
        if (withSuffix) {
          results.push({ buildingCode, buildingLabel, chargeCode, period: withSuffix, suffix: last });
        }
      }
    }
  }
  return results;
}

// ── Charge code for a job ────────────────────────────────────────────────────

export const FALLBACK_CHARGE_CODE = "m";

export function isChargeCode(value: unknown): value is string {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(CHARGE_CODES, value);
}

// First match wins, so specific rules sit above general ones ("fire alarm"
// before "fire"). Job categories are free text; these are the words the app
// and its work-request types actually use. Nothing here may produce SECr,
// which is legacy-only.
const CATEGORY_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bfire (alarm|detection|indicator)|\bsmoke (alarm|detect)/, "fa"],
  [/\bfire (test|testing|inspection)/, "ft"],
  [/\bfire\b|\bsprinkler|\bhydrant|\bextinguisher/, "fs"],
  [/\blifts?\b|\belevator|\bescalator/, "lm"],
  [/\belectric/, "e"],
  [/\bhvac\b|\bair ?con|\bmechanical\b|\bcooling tower|\brefrigerat/, "me"],
  [/\bgrounds\b|\bgarden|\blandscap|\blawn|\bmowing\b|\birrigation/, "gm"],
  [/\bpools?\b/, "pm"],
  [/\bclean/, "cl"],
  [/\bsecurity\b|\bcctv\b|\bintruder\b/, "se"],
  [/\bwaste\b|\brubbish\b|\brefuse\b|\bbins?\b/, "w"],
  [/\bkeys?\b|\bfobs?\b|\blocks?\b|\blocksmith|\baccess\b/, "k"],
  [/\bprojects?\b|\bcapital\b/, "pr"],
  [/\bplumb|\bhydraulic|\bdrain/, "m"],
];

function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function lookupChargeCode(text: string | null | undefined): string | null {
  if (!text) return null;
  const normalised = normalise(text);
  if (!normalised) return null;
  for (const [pattern, code] of CATEGORY_RULES) {
    if (pattern.test(normalised)) return code;
  }
  return null;
}

/** Charge code for a free-text job category. Unknown categories get "m". */
export function chargeCodeForCategory(category: string | null | undefined): string {
  return lookupChargeCode(category) ?? FALLBACK_CHARGE_CODE;
}

/**
 * Facilities jobs only carry "Common Areas" / "Tenancy Works" as category, so
 * the discipline is in the work-request type; try category, then type, then
 * sub-type before falling back.
 */
export function chargeCodeForJob(job: {
  category?: string | null;
  type?: string | null;
  subType?: string | null;
}): string {
  return (
    lookupChargeCode(job.category) ??
    lookupChargeCode(job.type) ??
    lookupChargeCode(job.subType) ??
    FALLBACK_CHARGE_CODE
  );
}
