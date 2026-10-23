// The entries of a stored JSON array, each as its own text, so a write can change one
// entry and leave every other as it was stored, byte for byte (WP26c appendRelief, D11).

/** The top-level entries of a JSON array, each as its own stored text, or null when the text isn't a JSON array. */
export function jsonArrayElements(text: string): { raw: string; value: unknown }[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const raws: string[] = [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  let start = text.indexOf("[") + 1;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === "[" || char === "{") depth += 1;
    else if ((char === "]" || char === "}") && depth > 0) depth -= 1;
    else if (char === "]") {
      const last = text.slice(start, index).trim();
      if (last !== "") raws.push(last);
      break;
    } else if (char === "," && depth === 0) {
      raws.push(text.slice(start, index).trim());
      start = index + 1;
    }
  }
  if (raws.length !== parsed.length) return null;
  const values: unknown[] = parsed;
  return raws.map((raw, index) => ({ raw, value: values[index] }));
}
