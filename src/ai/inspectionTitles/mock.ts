// Tidy job titles (SC-AI6): the stand-in for a model (AI_PROVIDER=mock). Deterministic, no
// network. It tidies the way a careful reader would: whitespace squeezed, a trailing
// "(3 findings)" dropped, the first letter capitalised, the whole fitted to the limit at a
// word. It adds nothing, so it can never invent a fact. Its text goes through the same
// answer checks as a real model's.

import { readTitlesInput } from "./input";
import { MAX_TITLE_CHARS, NOT_ONE_LINE } from "./validate";

const FALLBACK = "Inspection job";
const SEPARATORS = /[\s,;:–—-]+$/;

function tidyTitle(title: string): string {
  const plain = title
    .replace(/\[[A-Z]{2,10}\]/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/:\/\//g, " ")
    .replace(/[<>`*#[\]{}]/g, " ")
    .replace(new RegExp(NOT_ONE_LINE, "gu"), " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\s*\(\d+ findings?\)$/i, "")
    .replace(SEPARATORS, "");
  const cased = plain.charAt(0).toUpperCase() + plain.slice(1);
  let fitted = cased;
  if (cased.length > MAX_TITLE_CHARS) {
    const cut = cased.slice(0, MAX_TITLE_CHARS);
    // Back to the last whole word, unless the cut already falls between two.
    fitted = cased[MAX_TITLE_CHARS] === " " || !cut.includes(" ") ? cut : cut.slice(0, cut.lastIndexOf(" "));
  }
  return fitted.replace(SEPARATORS, "") || FALLBACK;
}

export function mockJobTitles(input: string): string {
  const jobs = readTitlesInput(input);
  return JSON.stringify({ titles: jobs ? jobs.map((job) => tidyTitle(job.title)) : [] });
}
