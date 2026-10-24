// Inbound email triage (EB3): what an email is about, without a model. Pure. Keyword rules read the
// subject and the opening of the body; Toddler's classification, when the parse worker has already
// put one on the row, is used as it stands so the model is not asked twice. Both are best guesses
// that only decide which staff lane to look in and how to word a reason: a wrong guess lowers a
// ranking, it never blocks anyone and never assigns by itself (a strong match needs evidence about
// people, see decide.ts).

import { ASSET_CATEGORIES } from "../assetRegister";
import type { Intent, Lane, Urgency, Work } from "./types";

/** Only the opening of a body is read: what follows is usually a quoted thread or a signature. */
const BODY_CHARS = 1500;

const CATEGORY_WORDS: readonly (readonly [(typeof ASSET_CATEGORIES)[number], RegExp])[] = [
  ["Fire & life safety", /\b(fire alarm|fire door|extinguisher|sprinkler|smoke detector|exit sign|emergency light)/i],
  ["HVAC / mechanical", /\b(air[- ]?con|a\/c|hvac|air conditioning|ventilation|too hot|too cold|chiller)/i],
  ["Hydraulic", /\b(leak|leaking|plumb|toilet|drain|blocked|hot water|burst|tap|water pressure|flood)/i],
  ["Electrical", /\b(power point|power outage|no power|electrical|switchboard|circuit|tripping|globe|lights? (?:is|are)? ?(?:not working|out|flickering))/i],
  ["Lifts", /\b(lift|elevator)\b/i],
  ["Cleaning", /\b(cleaning|cleaner|rubbish|bins?)\b/i],
  ["Grounds", /\b(garden|lawn|landscap|tree|irrigation|grounds)/i],
  ["Compliance", /\b(compliance|certificate of|inspection report|audit)/i],
];

const ACCOUNTS_WORDS = /\b(invoice|invoices|payment|remittance|statement|rent|arrears|overdue|receipt|bank details|direct debit|gst|abn|purchase order|credit note)\b/i;
const QUOTE_WORDS = /\bquot(?:e|es|ation)\b/i;
const MAINTENANCE_WORDS = /\b(repair|broken|fault|faulty|not working|maintenance|fix|damaged|damage|leak|blocked|smell|noise|stuck)\b/i;
const COMPLAINT_WORDS = /\b(complain|complaint|unacceptable|disappointed|dissatisfied|fed up|ongoing issue)\b/i;
const URGENT_WORDS = /\b(emergency|flooding|flooded|gas leak|fire|smoke|electric shock|sparking|no power|locked in|burst pipe)\b/i;
const HIGH_WORDS = /\b(urgent|urgently|asap|immediately|as soon as possible|today)\b/i;

/** Maintenance goes to facilities, money questions to accounts, anything else to both. A quote is both: either team may be asked for one. */
export function laneFor(intent: Intent, isQuote = false): Lane {
  if (isQuote) return "both";
  if (intent === "maintenance_request") return "facilities";
  if (intent === "invoice_or_quote" || intent === "rent_or_account") return "accounts";
  return "both";
}

function readable(subject: string | null | undefined, body: string | null | undefined): string {
  return `${subject ?? ""}\n${(body ?? "").slice(0, BODY_CHARS)}`;
}

export function categoryFromText(text: string): string | null {
  let best: { count: number; name: string } | null = null;
  for (const [name, pattern] of CATEGORY_WORDS) {
    const hits = text.match(new RegExp(pattern.source, "gi"))?.length ?? 0;
    if (hits > (best?.count ?? 0)) best = { count: hits, name };
  }
  return best?.name ?? null;
}

export function urgencyFromText(text: string): Urgency | null {
  if (URGENT_WORDS.test(text)) return "urgent";
  if (HIGH_WORDS.test(text)) return "high";
  return null;
}

/** Keyword reading of the subject and the start of the body. Always answers: "other" when nothing speaks. */
export function rulesWork(subject: string | null | undefined, body: string | null | undefined): Work {
  const text = readable(subject, body);
  const category = categoryFromText(text);
  const accounts = (text.match(new RegExp(ACCOUNTS_WORDS.source, "gi")) ?? []).length;
  const quote = QUOTE_WORDS.test(text);
  // A trade named in a quote is the quote's subject, not a fault: it only counts towards maintenance when nobody is quoting.
  const maintenance = (text.match(new RegExp(MAINTENANCE_WORDS.source, "gi")) ?? []).length + (category && !quote ? 1 : 0);

  let intent: Intent = "other";
  if (maintenance > 0 && maintenance >= accounts) intent = "maintenance_request";
  else if (accounts > 0 && /\b(rent|arrears|overdue|statement)\b/i.test(text) && !/\binvoice/i.test(text)) intent = "rent_or_account";
  else if (accounts > 0 || quote) intent = "invoice_or_quote";
  else if (COMPLAINT_WORDS.test(text)) intent = "complaint";

  return {
    buildingName: null,
    category: intent === "maintenance_request" ? category : null,
    intent,
    jobNumber: null,
    lane: laneFor(intent, intent === "invoice_or_quote" && quote && accounts === 0),
    source: "rules",
    tenancyName: null,
    urgency: urgencyFromText(text),
  };
}

const TODDLER_INTENT: Readonly<Record<string, Intent>> = {
  invoice: "invoice_or_quote",
  job: "maintenance_request",
  "job-update": "maintenance_request",
  quote: "invoice_or_quote",
  "quote-approval": "invoice_or_quote",
};

function priorityToUrgency(priority: unknown): Urgency | null {
  const value = typeof priority === "string" ? priority.trim().toLowerCase() : "";
  if (value === "emergency" || value === "urgent") return "urgent";
  if (value === "high") return "high";
  if (value === "low") return "low";
  if (value === "medium" || value === "normal") return "normal";
  return null;
}

/**
 * Toddler's classification of an email, when it made one that says something (not "unknown", and the
 * email was not flagged as unreadable or suspicious). The keyword reading fills what Toddler does not
 * give (a category). Null means "ask the next source".
 */
export function toddlerWork(
  classification: string | null | undefined,
  parsedData: string | null | undefined,
  fallback: Work,
): Work | null {
  const intent = classification ? TODDLER_INTENT[classification] : undefined;
  if (!intent) return null;
  let data: Record<string, unknown> = {};
  try {
    const parsed: unknown = parsedData ? JSON.parse(parsedData) : {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) data = parsed as Record<string, unknown>;
  } catch {
    data = {};
  }
  if (data.suspicious === true) return null;
  const jobRef = typeof data.jobRef === "string" ? data.jobRef.match(/\d{1,9}/)?.[0] : undefined;
  const building = typeof data.buildingName === "string" && data.buildingName.trim() !== "" ? data.buildingName.trim().slice(0, 120) : null;
  return {
    buildingName: building,
    category: intent === "maintenance_request" ? fallback.category : null,
    intent,
    jobNumber: jobRef ? Number(jobRef) : null,
    lane: laneFor(intent, classification === "quote"),
    source: "toddler",
    tenancyName: null,
    urgency: priorityToUrgency(data.priority) ?? fallback.urgency,
  };
}
