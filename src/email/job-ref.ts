// Deterministic email → job matcher. The model never sets MatchedJobID — this
// is the only source. Shared by ingestEmail, the Graph sync and the parse
// worker so all three agree on what "references a job" means.

// Subject: "Job #42", "job 42", "JOB#42". [ \t] so a match never spans lines;
// the trailing \b stops "Job #42a".
const SUBJECT_JOB_REF_RE = /\bjob[ \t]*#?[ \t]*(\d{1,9})\b/i;

// Body: "#" required — bare "job 1 of 3" in prose is too common to trust.
const BODY_JOB_REF_RE = /\bjob[ \t]*#[ \t]*(\d{1,9})\b/i;

// Document numbers from src/doc-number.ts: YYMMDD-{PO|QT|IV}-{jobId}-{acronym}-{seq};
// the job id is group 3. Leading \b rather than ^: real subjects are
// "Purchase Order 260419-PO-42-ACM-7 — …" (src/pdf/default-po-email.ts),
// often behind "Re:" / "RE: Fwd:".
// Deliberately NOT matched: legacy PO-{JobID}-{seq} (migration 012 seed data
// only) and the PO-{PurchaseOrderID} display fallback — that carries a PO id,
// not a job id, so matching it could link the wrong job.
const DOC_NUMBER_RE = /\b(\d{6})-(PO|QT|IV)-(\d+)-/i;

// [pattern, capture group holding the job id], in precedence order.
type Pattern = readonly [RegExp, number];
const SUBJECT_PATTERNS: readonly Pattern[] = [
  [SUBJECT_JOB_REF_RE, 1],
  [DOC_NUMBER_RE, 3],
];
const BODY_PATTERNS: readonly Pattern[] = [
  [DOC_NUMBER_RE, 3],
  [BODY_JOB_REF_RE, 1],
];

// Quoted history: everything from the first reply/forward header onward.
// (?:^|>) lets the HTML forms ("<b>From:</b>", "<div>On … wrote:") match too.
const HISTORY_CUT_RES: readonly RegExp[] = [
  /(?:^|>)[ \t]*On[ \t][^\n]{0,300}(?:\n[^\n]{0,300})?\bwrote:/im,
  /(?:^|>)[ \t]*From:/im,
  /-{2,}[ \t]*Original Message[ \t]*-{2,}/i,
];
const INNER_BLOCKQUOTE_RE = /<blockquote\b[^>]*>(?:(?!<blockquote\b)[\s\S])*?<\/blockquote>/gi;
const QUOTED_LINE_RE = /^[ \t]*>.*$/gm;

// SQL INT ceiling — anything larger is noise, not a job id.
const MAX_JOB_ID = 2147483647;

function stripQuotedHistory(body: string): string {
  let text = body;
  for (const re of HISTORY_CUT_RES) {
    const match = re.exec(text);
    if (match) text = text.slice(0, match.index);
  }
  // Innermost first so nested quotes unwrap fully.
  for (let prev = ""; prev !== text; ) {
    prev = text;
    text = text.replace(INNER_BLOCKQUOTE_RE, "");
  }
  const unclosed = text.search(/<blockquote\b/i);
  if (unclosed >= 0) text = text.slice(0, unclosed);
  return text.replace(QUOTED_LINE_RE, "");
}

function firstJobId(text: string | null | undefined, patterns: readonly Pattern[]): number | null {
  if (!text) return null;
  for (const [pattern, group] of patterns) {
    const match = text.match(pattern);
    const id = match ? Number(match[group]) : NaN;
    if (Number.isInteger(id) && id > 0 && id <= MAX_JOB_ID) return id;
  }
  return null;
}

/**
 * Subject wins over body. Subject: "Job N" / "Job #N", then a document number.
 * Body (quoted history stripped): a document number, then "Job #N" only.
 */
export function jobIdFromText(
  subject: string | null | undefined,
  body: string | null | undefined,
): number | null {
  return firstJobId(subject, SUBJECT_PATTERNS) ?? firstJobId(body ? stripQuotedHistory(body) : null, BODY_PATTERNS);
}
