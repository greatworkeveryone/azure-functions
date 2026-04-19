// Contractor-acronym generator — deterministic 3-letter code from the
// contractor's name, with collision avoidance against a set of already-taken
// acronyms. Used as the {ACR} segment of PO/Quote numbers.
//
// Algorithm:
//   1. Strip non-alpha, uppercase, split into words.
//   2. "Initials" candidate: first letter of each of the first 3 words.
//   3. If < 3 letters, pad from the compacted name's unused chars.
//   4. If the candidate collides, progressively replace positions with the
//      next unused chars from the compacted name.
//   5. If we still have a collision, append a digit (2, 3, 4, …) replacing
//      the last letter — guaranteed to terminate since we only have ~26³
//      possible combinations and the taken set is bounded by the contractor
//      count.
//
// Pure function — no DB / network. See `contractor-acronym.test.ts`.

function compactAlpha(name: string): string {
  return (name || "").toUpperCase().replace(/[^A-Z]/g, "");
}

function words(name: string): string[] {
  return (name || "")
    .toUpperCase()
    .split(/[^A-Z]+/)
    .filter((w) => w.length > 0);
}

function baseAcronym(name: string): string {
  const ws = words(name);
  if (ws.length === 0) return "";
  const initials = ws.slice(0, 3).map((w) => w[0]).join("");
  if (initials.length >= 3) return initials;
  // Pad from the first word's remaining chars (more readable than jumping
  // straight into the compacted form across word boundaries).
  const first = ws[0];
  let out = initials;
  let i = 1;
  while (out.length < 3 && i < first.length) {
    out += first[i];
    i += 1;
  }
  while (out.length < 3) out += "X";
  return out;
}

export function generateAcronym(
  name: string,
  taken: ReadonlySet<string>,
): string {
  const compacted = compactAlpha(name);
  if (compacted.length === 0) {
    // No usable letters (empty / non-Latin-only name). Try X, XX, XXX + digit.
    return uniquify("XXX", taken);
  }

  const base = baseAcronym(name);
  if (!taken.has(base)) return base;

  // Try replacing the 3rd, then 2nd, then 1st char with each remaining
  // unused letter from the compacted name.
  const usedChars = new Set(base);
  for (let pos = 2; pos >= 0; pos -= 1) {
    for (let i = 0; i < compacted.length; i += 1) {
      const ch = compacted[i];
      if (usedChars.has(ch)) continue;
      const candidate =
        base.slice(0, pos) + ch + base.slice(pos + 1);
      if (!taken.has(candidate)) return candidate;
    }
  }

  // Still colliding — fall through to digit-suffix strategy.
  return uniquify(base, taken);
}

function uniquify(base: string, taken: ReadonlySet<string>): string {
  // Prefer the base string itself if it's free — we only fall through to
  // digit-suffix variants on an actual collision.
  if (!taken.has(base)) return base;
  // Replace the last char with a digit: base[0..2] + '2', '3', …, '9',
  // then extend into base[0..1] + 2-digit numbers, etc. Terminates once a
  // gap is found.
  const prefix2 = base.slice(0, 2);
  const prefix1 = base.slice(0, 1);
  for (let d = 2; d <= 9; d += 1) {
    const candidate = `${prefix2}${d}`;
    if (!taken.has(candidate)) return candidate;
  }
  for (let d = 10; d <= 99; d += 1) {
    const candidate = `${prefix1}${d}`;
    if (candidate.length <= 3 && !taken.has(candidate)) return candidate;
  }
  // Exhausted — extremely unlikely; surface the problem rather than
  // returning a duplicate silently.
  throw new Error(
    `generateAcronym: exhausted all 3-char variants for name="${base}"`,
  );
}
