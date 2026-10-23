// What gets replaced before text goes to a model (SC-AI1), one rule per kind of
// personal detail. Each rule answers one question: which stretches of this text
// are one? The engine in ./redaction.ts resolves overlaps and does the replacing.
//
// Written to be cheap to run on any input: every repeat is bounded, and a match
// can only start at the front of a token, so the cost grows with the length of
// the text and never with its shape (redaction.test.ts times hostile input).
//
// Not replaced, on purpose: ABNs and ACNs (extraction needs them), dates, money,
// postcodes and document numbers. Bare 10-digit numbers are left alone unless they
// look like a mobile (04...) or follow a label such as "Ph" or "Account", because
// a bare number is as often an invoice number as a phone number. Names and street
// addresses are not removed at all: no pattern can tell them from other words.
// That is why the model runs on Randazzo Properties' own Azure tenant.

export type RedactionKind = "account" | "bsb" | "card" | "email" | "phone" | "tfn";

export interface Span {
  end: number;
  start: number;
}

export interface RedactionRule {
  kind: RedactionKind;
  spans: (text: string) => Span[];
}

export const PLACEHOLDERS: Record<RedactionKind, string> = {
  account: "[ACCOUNT]",
  bsb: "[BSB]",
  card: "[CARD]",
  email: "[EMAIL]",
  phone: "[PHONE]",
  tfn: "[TFN]",
};

/* ── Checksums ─────────────────────────────────────────────────────────────── */

export function isLuhnValid(digits: string): boolean {
  let sum = 0;
  for (let i = digits.length - 1, double = false; i >= 0; i--, double = !double) {
    let n = Number(digits[i]);
    if (double) n = n > 4 ? n * 2 - 9 : n * 2;
    sum += n;
  }
  return digits.length > 0 && sum % 10 === 0;
}

/** Nine-digit tax file number: weights 1 4 3 7 5 8 6 9 10, sum divisible by 11. */
export function isTfnValid(digits: string): boolean {
  if (!/^\d{9}$/.test(digits)) return false;
  const weights = [1, 4, 3, 7, 5, 8, 6, 9, 10];
  return weights.reduce((sum, weight, i) => sum + weight * Number(digits[i]), 0) % 11 === 0;
}

/** Eleven-digit ABN: take 1 from the first digit, weights 10 1 3 5 ... 19, sum divisible by 89. */
export function isAbnValid(digits: string): boolean {
  if (!/^\d{11}$/.test(digits)) return false;
  const weights = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19];
  const values = digits.split("").map(Number);
  values[0] -= 1;
  return values.reduce((sum, value, i) => sum + value * weights[i], 0) % 89 === 0;
}

/** Card issuers' number ranges, loosely: enough to leave alone a long number that only happens to pass Luhn. */
function plausibleCardPrefix(digits: string): boolean {
  const first = digits[0];
  if (first === "4" || first === "5" || first === "6") return true;
  if (first === "3") return /^3[0456789]/.test(digits);
  if (first === "2") return Number(digits.slice(0, 4)) >= 2221 && Number(digits.slice(0, 4)) <= 2720;
  return false;
}

/* ── Building blocks ───────────────────────────────────────────────────────── */

const SEP = "[ \\u00a0-]"; // between digit groups
const TOKEN_START = "(?<![\\w.,$-])"; // not glued to a longer token, an amount or a hyphenated id
const digitsOf = (value: string): string => value.replace(/\D/g, "");

function spansOf(text: string, pattern: RegExp, group = 0, accept?: (value: string) => boolean): Span[] {
  const found: Span[] = [];
  for (const match of text.matchAll(pattern)) {
    const range = match.indices?.[group];
    if (!range) continue;
    const [start, end] = range;
    if (accept && !accept(text.slice(start, end))) continue;
    found.push({ end, start });
  }
  return found;
}

/* ── Protected: never replaced ─────────────────────────────────────────────── */

const ABN_LABELLED = new RegExp(
  `\\b(?:ABN|ACN|A\\.B\\.N|A\\.C\\.N|Australian\\s{1,3}(?:Business|Company)\\s{1,3}Number)\\b\\.?[\\s:#.-]{0,6}(\\d(?:[ \\u00a0]?\\d){7,10})(?!\\d)`,
  "dgi",
);
const ABN_BARE = new RegExp(`${TOKEN_START}\\d{2}[ \\u00a0]?\\d{3}[ \\u00a0]?\\d{3}[ \\u00a0]?\\d{3}(?!\\d)`, "dg");

/** Business numbers: a labelled ABN or ACN, or any 11 digits that pass the ABN checksum. */
export function protectedSpans(text: string): Span[] {
  return [...spansOf(text, ABN_LABELLED, 1), ...spansOf(text, ABN_BARE, 0, (value) => isAbnValid(digitsOf(value)))];
}

/* ── Rules, in priority order ──────────────────────────────────────────────── */

const EMAIL = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,128}@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.){1,8}[A-Za-z]{2,24}/dg;

// A run of digit groups joined by single spaces or hyphens. A card is a stretch of
// whole groups, 13 to 19 digits, that passes Luhn, so a card followed by its expiry
// ("4111 1111 1111 1111 12/26") is found without taking the expiry with it.
const DIGIT_RUN = new RegExp(`${TOKEN_START}\\d+(?:${SEP}\\d+)*`, "dg");

/** The longest card-shaped stretch of whole groups starting at group `from`, or null. At most 19 groups are looked at. */
function cardWindowAt(text: string, groups: Span[], from: number): { next: number; span: Span } | null {
  let digits = 0;
  let reach = from;
  while (reach < groups.length && digits + groups[reach].end - groups[reach].start <= 19) {
    digits += groups[reach].end - groups[reach].start;
    reach += 1;
  }
  for (let to = reach - 1; to >= from; to--) {
    const span = { end: groups[to].end, start: groups[from].start };
    const candidate = digitsOf(text.slice(span.start, span.end));
    if (candidate.length >= 13 && plausibleCardPrefix(candidate) && isLuhnValid(candidate)) return { next: to + 1, span };
  }
  return null;
}

function cardSpans(text: string): Span[] {
  const found: Span[] = [];
  for (const run of text.matchAll(DIGIT_RUN)) {
    const base = run.index ?? 0;
    const groups = [...run[0].matchAll(/\d+/g)].map((group) => ({
      end: base + (group.index ?? 0) + group[0].length,
      start: base + (group.index ?? 0),
    }));
    for (let from = 0; from < groups.length; ) {
      const window = cardWindowAt(text, groups, from);
      if (window) {
        found.push(window.span);
        from = window.next;
      } else {
        from += 1;
      }
    }
  }
  return found;
}

const TFN_LABELLED = new RegExp(
  `\\b(?:TFN|tax\\s{1,3}file\\s{1,3}(?:no\\.?|number|num\\.?))\\b[\\s:#.-]{0,6}(\\d(?:${SEP}?\\d){6,8})(?!\\d)`,
  "dgi",
);
const TFN_BARE = new RegExp(`${TOKEN_START}\\d{3}${SEP}\\d{3}${SEP}\\d{3}(?!\\d|${SEP}\\d)`, "dg");

const BSB_ACCOUNT_PAIR = new RegExp(`${TOKEN_START}(\\d{3}-\\d{3})[ \\u00a0,/-]{1,3}(\\d{6,10})(?!\\d)`, "dg");
const BSB_LABELLED = new RegExp(`\\bBSB\\b(?:\\s{0,2}(?:no\\.?|number|num\\.?|#))?[\\s:.-]{0,6}(\\d{3}${SEP}?\\d{3})(?!\\d)`, "dgi");
const ACCOUNT_LABELLED = new RegExp(
  `\\b(?:account|acct|acc)\\b(?:\\s{0,2}(?:no\\.?|number|num\\.?|#))?[\\s:#.-]{0,6}(\\d(?:${SEP}?\\d){4,9})(?!\\d)`,
  "dgi",
);
// "A/C" is also air conditioning, so it needs a marker: A/C no 123456, A/C: 123456.
const AC_LABELLED = new RegExp(`\\ba\\/c\\b\\s{0,2}(?:no\\.?|number|num\\.?|#|:)[\\s:#.-]{0,6}(\\d(?:${SEP}?\\d){4,9})(?!\\d)`, "dgi");

const MOBILE = new RegExp(`${TOKEN_START}(?:04|\\+61${SEP}?(?:\\(0\\)${SEP}?|0${SEP}?)?4)(?:${SEP}?\\d){8}(?!\\d)`, "dg");
const LANDLINE = new RegExp(
  `${TOKEN_START}(?:\\(0[2378]\\)${SEP}?\\d{4}${SEP}?\\d{4}|0[2378](?:${SEP}\\d{4}${SEP}?\\d{4}|\\d{4}${SEP}\\d{4})|\\+61${SEP}?(?:\\(0\\)${SEP}?|0${SEP}?)?[2378](?:${SEP}?\\d){8})(?!\\d)`,
  "dg",
);
const SERVICE_NUMBER = new RegExp(`${TOKEN_START}1[38]00${SEP}\\d{3}${SEP}\\d{3}(?!\\d)`, "dg");
const PHONE_LABELLED = new RegExp(
  `\\b(?:ph|phone|tel|telephone|mob|mobile|cell|fax)\\b\\.?(?:\\s{0,2}(?:no\\.?|number|num\\.?|#))?[\\s:.-]{0,6}(\\+?\\(?\\d[\\d ()\\u00a0-]{5,18}\\d)(?!\\d)`,
  "dgi",
);
const phoneLength = (value: string): boolean => digitsOf(value).length >= 8 && digitsOf(value).length <= 12;

export const REDACTION_RULES: readonly RedactionRule[] = [
  { kind: "email", spans: (text) => spansOf(text, EMAIL) },
  { kind: "card", spans: cardSpans },
  { kind: "tfn", spans: (text) => spansOf(text, TFN_LABELLED, 1) },
  { kind: "tfn", spans: (text) => spansOf(text, TFN_BARE, 0, (value) => isTfnValid(digitsOf(value))) },
  {
    kind: "bsb",
    spans: (text) => [...spansOf(text, BSB_ACCOUNT_PAIR, 1), ...spansOf(text, BSB_LABELLED, 1)],
  },
  {
    kind: "account",
    spans: (text) => [
      ...spansOf(text, BSB_ACCOUNT_PAIR, 2),
      ...spansOf(text, ACCOUNT_LABELLED, 1),
      ...spansOf(text, AC_LABELLED, 1),
    ],
  },
  {
    kind: "phone",
    spans: (text) => [
      ...spansOf(text, MOBILE),
      ...spansOf(text, LANDLINE),
      ...spansOf(text, SERVICE_NUMBER),
      ...spansOf(text, PHONE_LABELLED, 1, phoneLength),
    ],
  },
];
