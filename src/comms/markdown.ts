// ─────────────────────────────────────────────────────────────────────────────
// The markdown subset an email body is written in, read on the server.
//
// KEEP IN SYNC: this is a copy of the frontend's src/helpers/markdown.ts (SC-CM1,
// which the letter preview and the template editor use), so that what the sender
// sees in the preview is what the recipient gets. A change here is a change there,
// and the other way round. src/comms/__fixtures__/markdown-parity.json holds the
// same fixtures in both repos; each side's test parses them and must agree with the
// blocks and tokens recorded in the file.
//
// Pure and synchronous: no I/O, trivially testable.
// ─────────────────────────────────────────────────────────────────────────────

export type MarkdownBlock =
  | { items: string[]; kind: "list"; ordered: boolean }
  | { kind: "heading"; level: 2 | 3; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "quote"; text: string }
  | { kind: "rule" }
  | { header: string[]; kind: "table"; rows: string[][] };

export type InlineToken =
  | { href: string; kind: "link"; text: string }
  | { kind: "code"; text: string }
  | { kind: "em"; text: string }
  | { kind: "field"; path: string }
  | { kind: "strong"; text: string }
  | { kind: "text"; text: string };

/** The pieces of a line that is only searched for merge fields, never for emphasis. */
export type FieldPart = { kind: "field"; path: string } | { kind: "text"; text: string };

const HEADING = /^(#{2,3})\s+(.*)$/;
const BULLET = /^[-*]\s+(.*)$/;
const NUMBERED = /^\d+\.\s+(.*)$/;
const QUOTE = /^>\s?(.*)$/;
const RULE = /^(-{3,}|\*{3,}|_{3,})$/;
const TABLE_DIVIDER = /^\|?[\s:|-]+\|[\s:|-]*$/;

function splitRow(line: string): string[] {
  return line.replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
}

/**
 * Splits a markdown document into block-level tokens.
 *
 * Consecutive non-blank lines join into one paragraph, matching markdown's
 * soft-wrap rule — our source files are hard-wrapped at 80 columns, so without
 * this every document would render as a column of one-line paragraphs.
 */
export function parseMarkdown(source: string): MarkdownBlock[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push({ kind: "paragraph", text: paragraph.join(" ").trim() });
      paragraph = [];
    }
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();

    if (!trimmed) {
      flushParagraph();
      continue;
    }

    if (RULE.test(trimmed)) {
      flushParagraph();
      blocks.push({ kind: "rule" });
      continue;
    }

    const heading = HEADING.exec(trimmed);
    if (heading) {
      flushParagraph();
      blocks.push({
        kind: "heading",
        level: heading[1].length === 2 ? 2 : 3,
        text: heading[2].trim(),
      });
      continue;
    }

    // Table: a header row followed by a |---|---| divider.
    if (trimmed.includes("|") && TABLE_DIVIDER.test(lines[index + 1]?.trim() ?? "")) {
      flushParagraph();
      const header = splitRow(trimmed);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && lines[index].trim().includes("|")) {
        rows.push(splitRow(lines[index].trim()));
        index += 1;
      }
      index -= 1;
      blocks.push({ header, kind: "table", rows });
      continue;
    }

    const quote = QUOTE.exec(trimmed);
    if (quote) {
      flushParagraph();
      blocks.push({ kind: "quote", text: quote[1].trim() });
      continue;
    }

    const bullet = BULLET.exec(trimmed);
    const numbered = NUMBERED.exec(trimmed);
    if (bullet || numbered) {
      flushParagraph();
      const ordered = Boolean(numbered);
      const items: string[] = [];
      while (index < lines.length) {
        const candidate = lines[index];
        const candidateTrimmed = candidate.trim();
        const nextItem = ordered ? NUMBERED.exec(candidateTrimmed) : BULLET.exec(candidateTrimmed);
        if (nextItem) {
          items.push(nextItem[1].trim());
        } else if (candidateTrimmed && /^\s{2,}/.test(candidate) && items.length > 0) {
          // Continuation of the previous item's hard-wrapped text.
          items[items.length - 1] += ` ${candidateTrimmed}`;
        } else {
          break;
        }
        index += 1;
      }
      index -= 1;
      blocks.push({ items, kind: "list", ordered });
      continue;
    }

    paragraph.push(trimmed);
  }

  flushParagraph();
  return blocks;
}

// A merge field is `{{path}}`. Anything between a pair of braces is one, so a typo is
// named in the letter's missing list rather than printing as stray punctuation.
const INLINE = /(\*\*[^*]+\*\*|(?<!\*)\*[^*]+\*(?!\*)|`[^`]+`|\[[^\]]+\]\([^)]+\)|\{\{[^{}\n]+\}\})/g;
const FIELDS = /\{\{[^{}\n]+\}\}/g;

// A merged value is text, never markup: before it goes into a string that is parsed, the
// characters this reader acts on are swapped for private-use ones that mean nothing to it,
// and every reader of merged text (parseInline, splitFields, the plain-text copy) swaps
// them back. So a tenant called "Smith *Holdings*" prints as typed, and a value can never
// open a link or become a field of its own.
const INERT = "*`[]{}";
const INERT_BASE = 0xe000;

export function escapeInline(value: string): string {
  return value.replace(/[*`[\]{}]/g, (char) => String.fromCharCode(INERT_BASE + INERT.indexOf(char)));
}

export function restoreInline(text: string): string {
  return text.replace(/[\ue000-\ue005]/g, (char) => INERT[char.charCodeAt(0) - INERT_BASE]);
}

/** Splits text into plain runs and merge fields, leaving every other marker alone: for the places that show text as typed (headings, captions). */
export function splitFields(text: string): FieldPart[] {
  const parts: FieldPart[] = [];
  let cursor = 0;
  for (const match of text.matchAll(FIELDS)) {
    const start = match.index ?? 0;
    if (start > cursor) parts.push({ kind: "text", text: restoreInline(text.slice(cursor, start)) });
    parts.push({ kind: "field", path: match[0].slice(2, -2).trim() });
    cursor = start + match[0].length;
  }
  if (cursor < text.length) parts.push({ kind: "text", text: restoreInline(text.slice(cursor)) });
  return parts;
}

/** Bold or italic text may hold fields: the emphasis stays on the words round them. */
function emphasised(kind: "em" | "strong", inner: string): InlineToken[] {
  return splitFields(inner).map((part): InlineToken => {
    if (part.kind === "field") return part;
    return kind === "strong" ? { kind: "strong", text: part.text } : { kind: "em", text: part.text };
  });
}

/** Splits one line of text into inline tokens (bold, italic, code, links, merge fields). */
export function parseInline(text: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let cursor = 0;

  for (const match of text.matchAll(INLINE)) {
    const start = match.index ?? 0;
    if (start > cursor) tokens.push({ kind: "text", text: restoreInline(text.slice(cursor, start)) });

    const raw = match[0];
    if (raw.startsWith("**")) {
      tokens.push(...emphasised("strong", raw.slice(2, -2)));
    } else if (raw.startsWith("`")) {
      tokens.push({ kind: "code", text: restoreInline(raw.slice(1, -1)) });
    } else if (raw.startsWith("[")) {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(raw);
      if (link) tokens.push({ href: restoreInline(link[2]), kind: "link", text: restoreInline(link[1]) });
    } else if (raw.startsWith("{{")) {
      tokens.push({ kind: "field", path: raw.slice(2, -2).trim() });
    } else {
      tokens.push(...emphasised("em", raw.slice(1, -1)));
    }
    cursor = start + raw.length;
  }

  if (cursor < text.length) tokens.push({ kind: "text", text: restoreInline(text.slice(cursor)) });
  return tokens;
}
