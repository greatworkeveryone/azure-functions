// Ask the Library (SC-AI4): the body askLibrary accepts, checked before anything else
// happens. The browser sends a question and the passages it chose; the server takes
// only the text of them. A passage's `id` is the browser's own label for it: it is
// checked to be a short string and then dropped, never looked up, never sent to the
// model and never logged.

import { boundedString, isRecord } from "../validate";
import { ASK_LIMITS, type AskPassage } from "./input";

export interface AskLibraryRequest {
  passages: AskPassage[];
  question: string;
}

const NUMBER = new Intl.NumberFormat("en-AU");

function readPassage(raw: unknown, position: number): AskPassage | string {
  const which = `Passage ${position}`;
  if (!isRecord(raw)) return `${which} must be an object with a title and text.`;
  const title = boundedString(raw.title, ASK_LIMITS.titleChars)?.trim();
  if (!title) return `${which} needs a title of up to ${ASK_LIMITS.titleChars} characters.`;
  const heading = raw.heading === undefined ? "" : boundedString(raw.heading, ASK_LIMITS.headingChars)?.trim();
  if (heading === undefined) return `${which} has a heading that is not text or is over ${ASK_LIMITS.headingChars} characters.`;
  const text = boundedString(raw.text, ASK_LIMITS.textChars)?.trim();
  if (!text) return `${which} needs text of up to ${NUMBER.format(ASK_LIMITS.textChars)} characters.`;
  if (raw.id !== undefined && boundedString(raw.id, ASK_LIMITS.idChars) === null) return `${which} has an id that is not short text.`;
  return { heading, text, title };
}

/** The question and passages, or the plain sentence that says what is wrong. */
export function parseAskLibraryBody(body: unknown): AskLibraryRequest | { error: string } {
  if (!isRecord(body)) return { error: "Send a question and the passages to answer it from." };

  if (typeof body.question !== "string") return { error: "Send the question as text." };
  const question = body.question.trim();
  if (question.length < ASK_LIMITS.questionMinChars) return { error: `Ask a question of at least ${ASK_LIMITS.questionMinChars} characters.` };
  if (boundedString(question, ASK_LIMITS.questionMaxChars) === null) {
    return { error: `Keep the question to ${ASK_LIMITS.questionMaxChars} characters of plain text.` };
  }

  if (!Array.isArray(body.passages) || body.passages.length < 1 || body.passages.length > ASK_LIMITS.maxPassages) {
    return { error: `Send between 1 and ${ASK_LIMITS.maxPassages} passages to answer from.` };
  }
  const passages: AskPassage[] = [];
  for (const [index, raw] of body.passages.entries()) {
    const passage = readPassage(raw, index + 1);
    if (typeof passage === "string") return { error: passage };
    passages.push(passage);
  }
  return { passages, question };
}
