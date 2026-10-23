// Shared pieces of the redaction rules (SC-AI1): what a stretch of text is, the separator and
// token-boundary patterns every rule uses, and the helper that turns a pattern's matches into
// stretches. The rules themselves are in ./redactionRules.ts and ./redactionBank.ts.

export interface Span {
  end: number;
  start: number;
}

/** One separator between digit groups: a space, a non-breaking space or a hyphen. */
export const SEP = "[ \\u00a0-]";
/** Not glued to a longer token, an amount or a hyphenated id. */
export const TOKEN_START = "(?<![\\w.,$-])";

/** Not in the middle of a run of digit groups: "123 456 789 012" is one number, not "789 012" at the end of it. */
export const GROUP_START = "(?<!\\d[ \\u00a0-])";

export const digitsOf = (value: string): string => value.replace(/\D/g, "");

/**
 * The stretches one pattern matches: its whole match, or one capture group of it (the pattern
 * must carry the `d` and `g` flags). `accept` can refuse a match by the text it found.
 */
export function spansOf(text: string, pattern: RegExp, group = 0, accept?: (value: string) => boolean): Span[] {
  const found: Span[] = [];
  for (const match of text.matchAll(pattern)) {
    const range = match.indices?.[group];
    if (!range) continue;
    const [start, end] = range;
    if (accept && !accept(text.slice(start, end))) continue;
    found.push({ end, start });
  }
  return found;
}
