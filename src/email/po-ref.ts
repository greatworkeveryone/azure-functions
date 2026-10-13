// Finds purchase order numbers quoted in email text. Pure; shared by the
// parse worker's hint extraction and the email -> job matcher.
//
// Two formats are in circulation:
//   current  Johanne's MYOB format  66Sm261013, 9Ce261013b  (reference-codes.ts)
//   legacy   YYMMDD-PO-{job}-{acr}-{seq}  260419-PO-42-ACM-7  (doc-number.ts)

import { parseReference } from "../reference-codes";

// A label, then separators, then a token. Only the label is case-insensitive:
// codes are case-sensitive and are checked by parseReference, not here.
//   "PO 66Sm261013"  "PO#: 9Ce261013b"  "P.O. XYZ-001"  "Purchase Order 260419-PO-9-INT-1"
//   "PO number 66Sm261013"  "Order No. 66Sm261013"
// The separator is required (or a digit must follow directly) so "police" and
// "position" are not read as "PO" + a word; a bare "Order" is not a label.
const PO_CANDIDATE_RE = new RegExp(
  String.raw`(?:(?:\bP\.?O\.?|\bPurchase\s*Order)(?:\s*(?:No\b\.?|Number\b|#))?|\bOrder\s*(?:No\b\.?|Number\b|#))` +
    String.raw`(?:[\s:#.-]+|(?=\d))([A-Za-z0-9][A-Za-z0-9-]{1,20})(?![A-Za-z0-9])`,
  "gi",
);

const LEGACY_DOC_NUMBER_RE = /^\d{6}-PO-\d+-[A-Za-z0-9]+-\d+$/i;

function candidates(text: string): string[] {
  const found: string[] = [];
  // HTML bodies put "&nbsp;" between the label and the number.
  for (const match of text.replace(/&nbsp;/gi, " ").matchAll(PO_CANDIDATE_RE)) {
    const token = match[1].replace(/-+$/, "");
    if (token.length >= 2) found.push(token);
  }
  return found;
}

/** Tokens that are real PO numbers in the current format, in order, no repeats. */
export function findReferencePoNumbers(text: string | null | undefined): string[] {
  if (!text) return [];
  const valid = candidates(text).filter((token) => parseReference(token).length > 0);
  return [...new Set(valid)];
}

/**
 * Best PO number in the text. A token that is a real number in either format
 * beats a looser one; among equals the earliest wins (callers put the subject
 * first). Loose tokens are the long-standing behaviour for suppliers' own PO
 * ids ("PO #ABC-123", "PO: SUBJECT-REF"): they need a digit or a hyphen, so
 * "PO box" and "PO numbers" are not swallowed.
 */
export function findPoNumber(text: string | null | undefined): string | null {
  if (!text) return null;
  const all = candidates(text);
  const strict = all.find((token) => LEGACY_DOC_NUMBER_RE.test(token) || parseReference(token).length > 0);
  if (strict) return strict;
  return all.find((token) => /[0-9]/.test(token) || token.includes("-")) ?? null;
}
