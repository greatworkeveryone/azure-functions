export function escapeLikePattern(input: string): string {
  return input.replace(/[\\%_\[]/g, (ch) => "\\" + ch);
}

export type SearchQueryValidation =
  | { ok: true; value: string }
  | { ok: false; reason: "empty" | "too_long" };

const MAX_QUERY_LENGTH = 100;

export function validateSearchQuery(
  raw: string | undefined,
): SearchQueryValidation {
  const trimmed = (raw ?? "").trim();
  if (trimmed.length === 0) return { ok: false, reason: "empty" };
  if (trimmed.length > MAX_QUERY_LENGTH) return { ok: false, reason: "too_long" };
  return { ok: true, value: trimmed };
}
