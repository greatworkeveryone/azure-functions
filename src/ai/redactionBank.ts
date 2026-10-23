// BSB and account numbers (SC-AI1): the ways bank details are written on an invoice, quote or
// email. A BSB is six digits, usually 062-000 or 062 000, followed by an account number of six
// to ten digits that may be grouped (1234 5678). Three forms need no label to be recognised
// (a hyphenated BSB, a spaced BSB with an account right after it, and a number after "BSB" or
// "Account"); a BSB and account run together ("062000 12345678") are only taken after a bank
// label (Bank, EFT, Direct credit, Deposit...), because on their own they look like two
// ordinary numbers. Each pair is two details: one BSB and one account.

import { GROUP_START, SEP, spansOf, TOKEN_START, type Span } from "./redactionKit";

// Six to ten digits, in one run or grouped with single spaces or hyphens.
const ACCOUNT = `\\d(?:${SEP}?\\d){5,9}`;
const BANK_LABEL =
  "\\b(?:bank(?:ing)?(?:\\s{1,3}details)?|eft|direct\\s{1,3}(?:credit|deposit)|deposit|remit(?:tance)?|payment\\s{1,3}details|account\\s{1,3}details|pay\\s{1,3}to|transfer\\s{1,3}to)\\b";

// "063-000 12345678", "062-000 1234 5678": the hyphen is what a BSB looks like, so no label is needed.
const HYPHENATED_PAIR = new RegExp(`${TOKEN_START}(\\d{3}-\\d{3})[ \\u00a0,/-]{1,3}(${ACCOUNT})(?!\\d)`, "dg");
// "062 000 1234 5678": with no hyphen and no label it must be the whole run of digit groups, so a
// longer number (a reference, a card) is left alone.
const SPACED_PAIR = new RegExp(`${TOKEN_START}${GROUP_START}(\\d{3}[ \\u00a0]\\d{3})[ \\u00a0](\\d(?:[ \\u00a0]?\\d){5,9})(?!\\d|[ \\u00a0]\\d)`, "dg");
// "EFT: 062000 12345678", "Bank: CBA 062-000 1234 5678": a bank label, any words (a bank's name), then the pair.
const LABELLED_PAIR = new RegExp(`${BANK_LABEL}[^\\d\\n]{0,45}(\\d{3}${SEP}?\\d{3})[ \\u00a0,/-]{1,3}(${ACCOUNT})(?!\\d)`, "dgi");

const BSB_LABELLED = new RegExp(`\\bBSB\\b(?:\\s{0,2}(?:no\\.?|number|num\\.?|#))?[\\s:.-]{0,6}(\\d{3}${SEP}?\\d{3})(?!\\d)`, "dgi");
const ACCOUNT_LABELLED = new RegExp(
  `\\b(?:account|acct|acc)\\b\\.?(?:\\s{0,2}(?:no\\.?|number|num\\.?|#))?[\\s:#.-]{0,6}(\\d(?:${SEP}?\\d){4,9})(?!\\d)`,
  "dgi",
);
// "A/C" is also air conditioning, so it needs a marker: A/C no 123456, A/C: 123456.
const AC_LABELLED = new RegExp(`\\ba\\/c\\b\\s{0,2}(?:no\\.?|number|num\\.?|#|:)[\\s:#.-]{0,6}(\\d(?:${SEP}?\\d){4,9})(?!\\d)`, "dgi");

/** The BSB of each pair, and any number after "BSB". */
export function bsbSpans(text: string): Span[] {
  return [
    ...spansOf(text, HYPHENATED_PAIR, 1),
    ...spansOf(text, SPACED_PAIR, 1),
    ...spansOf(text, LABELLED_PAIR, 1),
    ...spansOf(text, BSB_LABELLED, 1),
  ];
}

/** The account of each pair, and any number after "Account", "Acct" or "A/C no". */
export function accountSpans(text: string): Span[] {
  return [
    ...spansOf(text, HYPHENATED_PAIR, 2),
    ...spansOf(text, SPACED_PAIR, 2),
    ...spansOf(text, LABELLED_PAIR, 2),
    ...spansOf(text, ACCOUNT_LABELLED, 1),
    ...spansOf(text, AC_LABELLED, 1),
  ];
}
