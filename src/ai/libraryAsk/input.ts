// Ask the Library (SC-AI4): the text a model is shown. askLibrary builds it from a
// validated request; the purpose's validator and its mock read it back, so the layout
// lives here and nowhere else.
//
// Passage numbers are the order the route was given them, never anything the browser
// said: the first line states how many passages there are, and an answer may cite only
// those. Nothing the browser sends can write a line of its own: the question, titles
// and headings are cut to one line, and a passage's text cannot start a passage.

export const NOT_COVERED_MARKER = "NOT_COVERED";

/** Mirrored in the frontend (src/helpers/libraryAsk/limits.ts): the browser cuts to these before it sends. */
export const ASK_LIMITS = {
  headingChars: 240,
  idChars: 120,
  maxPassages: 5,
  questionMaxChars: 300,
  questionMinChars: 3,
  textChars: 1_500,
  titleChars: 160,
} as const;

export interface AskPassage {
  /** The heading path, joined: "Who does what > Managers". Empty for the top of a procedure. */
  heading: string;
  text: string;
  /** The procedure's title. */
  title: string;
}

export interface ReadPassage {
  n: number;
  source: string;
  text: string;
}

/** Square brackets are the answer's citation marks, so none of the browser's text may carry one. */
const withoutBrackets = (text: string): string => text.replace(/\[/g, "(").replace(/\]/g, ")");
const oneLine = (text: string): string => withoutBrackets(text.replace(/\s+/g, " ").trim());
const passageText = (text: string): string => withoutBrackets(text.replace(/\r\n?/g, "\n")).replace(/^=== /gm, "== ").trim();

export function buildLibraryInput(question: string, passages: readonly AskPassage[]): string {
  const blocks = passages.map((passage, index) => {
    const source = oneLine([passage.title, passage.heading].filter((part) => part.trim() !== "").join(" > "));
    return `=== Passage ${index + 1} ===\nSource: ${source}\n${passageText(passage.text)}`;
  });
  return [`Passages: ${passages.length}`, `Question: ${oneLine(question)}`, ...blocks].join("\n");
}

/**
 * How many passages the input says it holds: 0 when it is missing or not in this layout,
 * so a check that depends on it fails closed.
 */
export function passageCountOf(input: unknown): number {
  const found = typeof input === "string" ? input.match(/^Passages: ([1-9])\n/) : null;
  const count = found ? Number(found[1]) : 0;
  return count <= ASK_LIMITS.maxPassages ? count : 0;
}

/** The question and passages back out of an input built above, or null when it is not one (the mock then says "not covered"). */
export function readLibraryInput(input: string): { passages: ReadPassage[]; question: string } | null {
  const count = passageCountOf(input);
  if (count === 0) return null;
  const parts = input.split(/\n=== Passage ([1-9]) ===\n/);
  const question = parts[0].match(/^Question: (.*)$/m)?.[1] ?? "";
  const passages: ReadPassage[] = [];
  for (let at = 1; at < parts.length; at += 2) {
    const [sourceLine = "", ...lines] = parts[at + 1].split("\n");
    passages.push({ n: Number(parts[at]), source: sourceLine.replace(/^Source: /, ""), text: lines.join("\n") });
  }
  const inOrder = passages.length === count && passages.every((passage, index) => passage.n === index + 1);
  return inOrder ? { passages, question } : null;
}
