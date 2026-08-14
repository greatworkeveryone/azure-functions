// src/email/feedback-email.ts
//
// Composes the in-app feedback email — subject, body and the context footer.
// Pure and I/O-free so the composition is unit-testable and the function
// handler stays a thin auth/validation/dispatch shell (env-list parsing
// follows getDirectorEmails).

export const FEEDBACK_TOPICS = ["bug", "data", "design", "feature", "other"] as const;

export type FeedbackTopic = (typeof FEEDBACK_TOPICS)[number];

const TOPIC_LABELS: Record<FeedbackTopic, string> = {
  bug: "Bug / something's broken",
  data: "Data looks wrong",
  design: "Design or layout",
  feature: "Feature request",
  other: "Other",
};

export const MAX_URL_CHARS = 500;
export const MAX_USER_AGENT_CHARS = 300;
export const MAX_CUSTOM_TOPIC_CHARS = 80;
// "1920 × 1080 (dpr 2)" is already 19 chars — this is a diagnostic field, so
// err toward keeping it rather than trimming it away.
export const MAX_VIEWPORT_CHARS = 40;

export function isFeedbackTopic(value: string): value is FeedbackTopic {
  return FEEDBACK_TOPICS.some((topic) => topic === value);
}

// Mirrors EMAIL_REGEX in src/functions/users.ts, duplicated locally rather
// than imported — email/ importing from functions/ would be backwards layering.
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Recipients for feedback mail, from env. Splits on comma or semicolon and
 *  drops anything that doesn't look like an address, so a config typo (or a
 *  ";"-joined paste) surfaces as the loud "no recipients configured" 500
 *  rather than an opaque failure once it reaches Graph. Empty array when
 *  unset or all-junk — the caller decides how loudly to fail. */
export function getFeedbackRecipients(): string[] {
  const raw = process.env.FEEDBACK_EMAIL_RECIPIENTS ?? "";
  return raw
    .split(/[,;]/)
    .map((entry) => entry.trim())
    .filter((entry) => EMAIL_REGEX.test(entry));
}

// Mandatory line breaks per UAX #14 — a plain-text renderer will break on any
// of these, so collapsing only \r\n would still let a caller split the line.
// U+0085 = NEL, U+2028 = line separator, U+2029 = paragraph separator. TAB
// isn't a line break but is folded in here too: left alone it would let a
// caller fake the footer's column alignment.
const LINE_BREAKS = /[\r\n\t\v\f\u0085\u2028\u2029]+/g;
// Zero-width and bidi-override characters — invisible in a mail client but
// able to hide or reorder what a reader sees. Covers ZWSP/ZWNJ/ZWJ/LRM/RLM
// (U+200B-U+200F), the explicit bidi embedding/override controls
// (U+202A-U+202E), the bidi isolate controls (U+2066-U+2069), and the
// zero-width no-break space / BOM (U+FEFF).
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

/** Flatten line breaks and clamp, so each footer field stays on exactly one
 *  line and the footer's shape is predictable. Note this does NOT stop a user
 *  typing a fake footer inside the free-text body — the body legitimately keeps
 *  its newlines; the subject and the real footer carry the verified identity. */
export function sanitiseLine(value: string, maxLength: number): string {
  const flattened = value
    .replace(LINE_BREAKS, " ")
    .replace(INVISIBLE, "")
    .replace(/\s+/g, " ")
    .trim();
  // Split into code points, not UTF-16 units — slice() would cut a surrogate
  // pair in half (e.g. an emoji) and leave a lone, unrenderable surrogate.
  const points = [...flattened];
  return points.length > maxLength
    ? `${points.slice(0, maxLength).join("").trimEnd()}…`
    : flattened;
}

export interface FeedbackEmailInput {
  body: string;
  customTopic: string | null;
  /** Always the verified token identity — never anything from the request body. */
  sender: { email: string; name: string };
  sentAt: Date;
  topic: FeedbackTopic;
  url: string;
  userAgent: string;
  viewport: string;
}

export interface FeedbackEmail {
  body: string;
  subject: string;
}

/** dd/MM/yyyy h:mm am/pm in Darwin time — the Function host runs UTC, so an
 *  unqualified format would stamp times hours off from the sender's clock. */
function formatSentAt(date: Date): string {
  return date.toLocaleString("en-AU", {
    day: "2-digit",
    hour: "numeric",
    hour12: true,
    minute: "2-digit",
    month: "2-digit",
    timeZone: "Australia/Darwin",
    year: "numeric",
  });
}

export function buildFeedbackEmail(input: FeedbackEmailInput): FeedbackEmail {
  const custom = input.customTopic ? sanitiseLine(input.customTopic, MAX_CUSTOM_TOPIC_CHARS) : "";
  const heading = input.topic === "other" && custom ? custom : TOPIC_LABELS[input.topic];

  const body = [
    heading,
    "",
    input.body.trim(),
    "",
    "────────────────────────────",
    `From:     ${input.sender.name} <${input.sender.email}>`,
    `Page:     ${sanitiseLine(input.url, MAX_URL_CHARS)}`,
    `Sent:     ${formatSentAt(input.sentAt)}`,
    `Browser:  ${sanitiseLine(input.userAgent, MAX_USER_AGENT_CHARS)}`,
    `Viewport: ${sanitiseLine(input.viewport, MAX_VIEWPORT_CHARS)}`,
  ].join("\n");

  return { body, subject: `[Floorplan feedback] ${heading} — ${input.sender.name}` };
}
