// Turns a model's text into a value the purpose trusts (SC-AI1), or says why not.
// The text is untrusted data throughout: it is parsed, never evaluated, and only
// what the purpose's validator copies out survives. Nothing here renders it.

import { refuse } from "./validate";
import type { AiPurpose, AiValidation } from "./types";

// A generous ceiling on characters per token, so a model that ignores max_tokens
// is refused instead of stored and parsed at any length.
const MAX_CHARS_PER_TOKEN = 8;
const FENCED = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n?```$/i;

/** Models often wrap JSON in a code fence even in JSON mode; one fence round the whole answer is allowed. */
function unfence(text: string): string {
  const match = text.match(FENCED);
  return match ? match[1].trim() : text;
}

export function interpretOutput<Output>(purpose: AiPurpose<Output>, text: string, input?: string): AiValidation<Output> {
  if (text.length > purpose.maxOutputTokens * MAX_CHARS_PER_TOKEN) return refuse("The answer is far longer than the purpose allows.");
  const trimmed = text.trim();
  let value: unknown = trimmed;
  if (purpose.expectsJson) {
    try {
      value = JSON.parse(unfence(trimmed));
    } catch {
      return refuse("The answer is not valid JSON.");
    }
  }
  try {
    const checked = purpose.validate(value, input);
    return checked && typeof checked === "object" && typeof checked.ok === "boolean" ? checked : refuse("The validator gave no verdict.");
  } catch {
    return refuse("The validator could not read the answer.");
  }
}
