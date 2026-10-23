// Replaces personal details in text with placeholders before it goes to any model
// (SC-AI1). Pure and deterministic: the same text always gives the same result,
// and redacting twice changes nothing more (a placeholder matches no rule).

import { PLACEHOLDERS, protectedSpans, REDACTION_RULES, type RedactionKind, type Span } from "./redactionRules";

export interface Redaction {
  byKind: Record<RedactionKind, number>;
  /** How many details were replaced, of every kind. */
  count: number;
  text: string;
}

const overlaps = (a: Span, b: Span): boolean => a.start < b.end && b.start < a.end;

/**
 * Rules run in priority order over the original text. A match that touches a
 * business number (ABN, ACN) or a detail already claimed by an earlier rule is
 * dropped, so every character is replaced at most once and ABNs always survive.
 */
export function redactText(input: string): Redaction {
  const byKind: Record<RedactionKind, number> = { account: 0, bsb: 0, card: 0, email: 0, phone: 0, tfn: 0 };
  const kept = protectedSpans(input);
  const accepted: Array<Span & { kind: RedactionKind }> = [];

  for (const rule of REDACTION_RULES) {
    for (const span of rule.spans(input)) {
      if (span.end <= span.start) continue;
      if (kept.some((protectedSpan) => overlaps(span, protectedSpan))) continue;
      if (accepted.some((taken) => overlaps(span, taken))) continue;
      accepted.push({ ...span, kind: rule.kind });
      byKind[rule.kind] += 1;
    }
  }

  accepted.sort((a, b) => a.start - b.start);
  let text = "";
  let cursor = 0;
  for (const span of accepted) {
    text += input.slice(cursor, span.start) + PLACEHOLDERS[span.kind];
    cursor = span.end;
  }
  text += input.slice(cursor);
  return { byKind, count: accepted.length, text };
}
