// Ask the Library (SC-AI4): what a model's reply has to be before anyone reads it.
//
// The reply is either exactly NOT_COVERED, or sentences that each end in the number
// of a passage the person was given: "Check keys in with a photo [1]." The numbers
// are checked against the input the provider was sent (the gateway hands it over),
// so a citation of a passage that was never given, a sentence with no citation, or
// text that is neither is refused and never reaches a screen. What comes out is
// structured (sentences and their numbers), so the browser never parses model text.
//
// This proves the answer is cited, not that it is true: whether a passage supports
// its sentence is the prompt's job, and the passages are shown beside every answer.

import { passageCountOf, NOT_COVERED_MARKER } from "./input";
import { accept, refuse } from "../validate";
import type { AiValidation } from "../types";

export interface LibraryAnswerSentence {
  /** Passage numbers, from 1, each one of the passages given. */
  cites: number[];
  text: string;
}

export type LibraryAnswer = { covered: false } | { covered: true; sentences: LibraryAnswerSentence[] };

const MAX_ANSWER_CHARS = 1_500;
const MAX_SENTENCES = 12;
const MAX_SENTENCE_CHARS = 500;

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
// An answer is plain sentences: no markup, and no address to follow.
const NOT_PLAIN = /[<>]|:\/\//;
const GROUPED_CITES = /\[(\d{1,2}(?:\s*,\s*\d{1,2})+)\]/g;
const A_CITE = /\[(\d{1,2})\]/g;
const LIST_MARKER = /^\s*(?:[-*•]|\d{1,2}[.)])\s+/;
// Two sentences under one citation: the first has none of its own. A full stop after a number
// ("Step 1. Open") or a common abbreviation ("approx. Five") does not end a sentence.
const INNER_BOUNDARY = /(?<!\d|\b(?:e\.g|i\.e|etc|vs|approx|Mr|Mrs|Ms|Dr|St))[.!?]["')]?\s+(?=[A-Z])/;

type Parsed<Value> = { ok: true; value: Value } | { ok: false; reason: string };

const tidy = (text: string): string => text.replace(/\s+/g, " ").trim().replace(/[\s,;:]+$/, "");
const withStop = (text: string): string => (/[.!?]$/.test(text) ? text : `${text}.`);

/** One line's sentences, each with the citations that close it, in "text [1]." or "text. [1]" form. */
function sentencesOf(line: string): Parsed<LibraryAnswerSentence[]> {
  const out: LibraryAnswerSentence[] = [];
  let prose = "";
  let cites: number[] = [];

  const close = (): string | null => {
    const text = tidy(prose);
    if (text === "") return "A citation has no sentence before it.";
    if (INNER_BOUNDARY.test(text)) return "A sentence has no citation of its own.";
    out.push({ cites: [...new Set(cites)], text: withStop(text) });
    return null;
  };

  for (const part of line.split(/(\[\d{1,2}\])/)) {
    const cite = part.match(/^\[(\d{1,2})\]$/);
    if (cite) {
      cites.push(Number(cite[1]));
      continue;
    }
    if (cites.length === 0) {
      prose += part;
      continue;
    }
    // After a citation: the full stop that belongs to the sentence before it comes first, and
    // when nothing else follows, more citations may (a run of them closes one sentence).
    const next = part.replace(/^[\s.,;:!?)"'\u2019\u201d]*/, "");
    if (next === "") continue;
    const problem = close();
    if (problem) return { ok: false, reason: problem };
    cites = [];
    prose = next;
  }
  if (cites.length > 0) {
    const problem = close();
    if (problem) return { ok: false, reason: problem };
  } else if (tidy(prose) !== "") {
    return { ok: false, reason: "The answer has a sentence with no citation." };
  }
  return { ok: true, value: out };
}

export function checkLibraryAnswer(value: unknown, input?: string): AiValidation<LibraryAnswer> {
  if (typeof value !== "string") return refuse("The answer is not text.");
  const text = value.trim();
  if (text === NOT_COVERED_MARKER) return accept({ covered: false });

  const given = passageCountOf(input);
  if (given === 0) return refuse("There are no passages to cite, so the only answer is the not-covered marker.");
  if (text === "" || text.length > MAX_ANSWER_CHARS) return refuse("The answer is empty or longer than allowed.");
  if (text.includes(NOT_COVERED_MARKER)) return refuse("The answer mixes the not-covered marker with other text.");
  if (CONTROL.test(text) || NOT_PLAIN.test(text)) return refuse("The answer holds characters it should not.");

  const single = text.replace(GROUPED_CITES, (_whole, list: string) =>
    list.split(",").map((number) => `[${number.trim()}]`).join(""));
  if (/[[\]]/.test(single.replace(A_CITE, ""))) return refuse("The answer has brackets that are not passage numbers.");

  const sentences: LibraryAnswerSentence[] = [];
  for (const raw of single.split(/\n+/)) {
    const line = raw.replace(LIST_MARKER, "").trim();
    if (line === "") continue;
    const parsed = sentencesOf(line);
    if (!parsed.ok) return refuse(parsed.reason);
    sentences.push(...parsed.value);
  }

  if (sentences.length === 0 || sentences.length > MAX_SENTENCES) return refuse("The answer has no sentences, or too many.");
  for (const sentence of sentences) {
    if (sentence.text.length > MAX_SENTENCE_CHARS) return refuse("A sentence is longer than allowed.");
    const stray = sentence.cites.find((n) => n < 1 || n > given);
    if (stray !== undefined) return refuse(`The answer cites passage ${stray}, but only ${given} were given.`);
  }
  return accept({ covered: true, sentences });
}
