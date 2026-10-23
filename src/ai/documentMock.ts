// The mock provider's stand-in for a model on quote_extraction and invoice_extraction
// (SC-AI2): deterministic, no network, and good enough on a plain document that the
// whole path can be tried with AI_PROVIDER=mock. It reads labelled lines the obvious
// way and answers null for anything it cannot find, as a real model is told to.
// It is not Floorplan's rules extractor (that runs in the browser) and shares no code with it.

import { isAbnValid } from "./checksums";
import type { DocumentKind } from "./documentFields";

type Answer = Record<string, number | string | null>;

const AMOUNT = /\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{2}))?|\b(\d{1,3}(?:,\d{3})+|\d+)\.(\d{2})\b/g;

// Past this an amount is not a price, and the validator would refuse the whole answer.
const MAX_AMOUNT = 100_000_000;

function amountsIn(line: string): number[] {
  return [...line.matchAll(AMOUNT)]
    .map((found) => Number(`${(found[1] ?? found[3]).replace(/,/g, "")}.${found[2] ?? found[4] ?? "00"}`))
    .filter((amount) => amount <= MAX_AMOUNT);
}

/** The last amount on the last line that matches `label` and not `skip`. */
function labelled(lines: string[], label: RegExp, skip: RegExp): number | null {
  for (const line of [...lines].reverse()) {
    if (!label.test(line) || skip.test(line)) continue;
    const amounts = amountsIn(line);
    if (amounts.length > 0) return amounts[amounts.length - 1];
  }
  return null;
}

function isoDate(year: number, month: number, day: number): string | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  const real = date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  return real && year >= 2000 && year <= 2100 ? date.toISOString().slice(0, 10) : null;
}

/** A day-first date (12/10/2026) after a label such as "Due date:". */
function dateAfter(text: string, label: string): string | null {
  const found = text.match(new RegExp(`(?:${label})\\s*:?\\s*(\\d{1,2})[/.-](\\d{1,2})[/.-](\\d{4})`, "i"));
  return found ? isoDate(Number(found[3]), Number(found[2]), Number(found[1])) : null;
}

function wholeAfter(text: string, pattern: RegExp): number | null {
  const found = text.match(pattern);
  return found ? Number(found[1]) : null;
}

export function mockDocumentFields(kind: DocumentKind, input: string): Answer {
  const lines = input.split(/\r?\n/);
  const abn = [...input.matchAll(/\b(\d{2}) ?(\d{3}) ?(\d{3}) ?(\d{3})\b/g)].map((found) => found.slice(1).join("")).find(isAbnValid) ?? null;
  const number = input.match(/(?:invoice|quote|quotation)\s*(?:no\.?|number|#)\s*[:#]?\s*([A-Za-z0-9][A-Za-z0-9\-/]{1,24})/i)?.[1] ?? null;
  const common: Answer = {
    abn,
    description: null,
    documentNumber: number,
    gst: labelled(lines, /\b(?:gst|tax)\b/i, /free|registered|incl|inc\b|total|sub-?\s?total/i),
    issueDate: dateAfter(input, "(?:invoice |issue |quote )?date(?: of issue)?"),
    subtotalExGst: labelled(lines, /sub-?\s?total|ex\.? ?gst|excl/i, /^$/),
    total: labelled(lines, /\btotal\b|amount due|balance due/i, /sub-?\s?total|ex\.? ?gst|excl|total gst/i),
  };
  if (kind === "quote") {
    return {
      ...common,
      leadTimeDays: wholeAfter(input, /lead time\s*:?\s*(\d{1,3})\s*(?:business |working )?days?/i),
      validForDays: wholeAfter(input, /valid for (\d{1,4}) days?/i),
      validUntil: dateAfter(input, "valid (?:until|to|through)"),
    };
  }
  const documentType = /credit note/i.test(input) ? "credit-note" : /\bstatement\b/i.test(input) ? "statement" : /\binvoice\b/i.test(input) ? "invoice" : null;
  return { ...common, documentType, dueDate: dateAfter(input, "due(?: date)?") };
}
