// Small text helpers shared by the digest's items and email.

/** "2026-01-05" -> "05/01/2026". Day first, always (decision 6). */
export function formatDisplayDate(dateKey: string): string {
  const [year, month, day] = dateKey.split("-");
  return `${day}/${month}/${year}`;
}

/** One line of text: whitespace collapsed, cut at `max` characters. */
export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
}
