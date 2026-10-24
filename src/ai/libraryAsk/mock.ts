// Ask the Library (SC-AI4): the stand-in for a model (AI_PROVIDER=mock). Deterministic,
// no network. It answers the way a careful model would: the sentence of the best
// passages that shares most with the question, cited, or NOT_COVERED when no passage
// shares at least half of the question's words. Its text goes through the same answer
// checks as a real model's.

import { NOT_COVERED_MARKER, readLibraryInput, type ReadPassage } from "./input";

const STOP_WORDS = new Set(
  "a about all am an and any are as at be been but by can could did do does for from had has have how i if in into is it its me my of on or our please should so that the their them then there these they this to was we were what when where which who why will with would you your".split(" "),
);
/** How much of the question a passage must share before the stand-in calls it an answer. */
const COVERAGE = 0.5;
const MAX_ANSWER_PASSAGES = 2;
const MAX_SENTENCE_CHARS = 240;

function termsOf(text: string): Set<string> {
  const terms = new Set<string>();
  for (const word of text.toLowerCase().replace(/['’]/g, "").split(/[^a-z0-9]+/)) {
    if (word.length < 2 || STOP_WORDS.has(word)) continue;
    terms.add(word.length > 3 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word);
  }
  return terms;
}

const sentencesIn = (text: string): string[] =>
  text
    .split("\n")
    .map((line) => line.replace(/^\s*(?:[-*•]|\d{1,2}[.)])\s+/, "").trim())
    .filter((line) => line !== "")
    .flatMap((line) => line.split(/(?<=[.!?])\s+(?=[A-Z])/));

/** One sentence, with nothing the answer checks refuse and no full stop (the citation brings its own). */
const plain = (sentence: string): string =>
  sentence.replace(/[<>]/g, "").replace(/:\/\//g, " ").replace(/\s+/g, " ").trim().replace(/[.!?:;,\s]+$/, "");

function leadSentence(passage: ReadPassage, terms: ReadonlySet<string>): string {
  let best = "";
  let bestHits = -1;
  for (const sentence of sentencesIn(passage.text)) {
    const hits = [...termsOf(sentence)].filter((term) => terms.has(term)).length;
    if (hits > bestHits) {
      best = sentence;
      bestHits = hits;
    }
  }
  const clean = plain(best);
  return clean.length > MAX_SENTENCE_CHARS ? clean.slice(0, MAX_SENTENCE_CHARS).replace(/\s+\S*$/, "") : clean;
}

export function mockLibraryAnswer(input: string): string {
  const read = readLibraryInput(input);
  if (!read) return NOT_COVERED_MARKER;
  const terms = termsOf(read.question);
  if (terms.size === 0) return NOT_COVERED_MARKER;

  const covering = read.passages
    .map((passage) => {
      const words = termsOf(`${passage.source} ${passage.text}`);
      return { hits: [...terms].filter((term) => words.has(term)).length, passage };
    })
    .filter((scored) => scored.hits / terms.size >= COVERAGE)
    .sort((a, b) => b.hits - a.hits || a.passage.n - b.passage.n)
    .slice(0, MAX_ANSWER_PASSAGES);

  const sentences = covering
    .map(({ passage }) => ({ n: passage.n, text: leadSentence(passage, terms) }))
    .filter((sentence) => sentence.text !== "");
  return sentences.length === 0 ? NOT_COVERED_MARKER : sentences.map(({ n, text }) => `${text} [${n}].`).join(" ");
}
