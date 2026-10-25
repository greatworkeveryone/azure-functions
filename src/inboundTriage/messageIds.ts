// Inbound email triage (EB3): reading the ids a reply names. Pure. A reply's In-Reply-To
// header holds the id of the message it answers and References holds the whole thread, oldest
// first, so the nearest ancestor is last. Ids are stored and compared without their angle
// brackets and in lower case (mail systems differ on both).

export const IN_REPLY_TO_MAX = 500;
export const REFERENCES_MAX = 2000;
const ID = /<([^<>\s]{1,300})>/g;

export function normaliseMessageId(id: string): string {
  return id.trim().replace(/^<|>$/g, "").toLowerCase();
}

/** Every id in a header value, normalised, in order. A bare token with no brackets counts when the value holds no bracketed id. */
export function parseMessageIds(value: string | null | undefined): string[] {
  if (!value) return [];
  const bracketed = [...value.matchAll(ID)].map((match) => normaliseMessageId(match[1]));
  const found = bracketed.length > 0 ? bracketed : value.split(/\s+/).map(normaliseMessageId).filter((token) => token.includes("@"));
  return found.filter((id, index) => id !== "" && found.indexOf(id) === index);
}

/** The value of the first header with this name (case-insensitive), or null. */
export function headerValue(headers: readonly { name: string; value: string }[], name: string): string | null {
  const wanted = name.toLowerCase();
  return headers.find((header) => header.name.trim().toLowerCase() === wanted)?.value ?? null;
}

/** What the sync stores: In-Reply-To's first id, and as many References ids as fit, keeping the newest. */
export function replyHeaders(headers: readonly { name: string; value: string }[]): { inReplyTo: string | null; referenceIds: string | null } {
  const inReplyTo = parseMessageIds(headerValue(headers, "In-Reply-To"))[0] ?? null;
  const references = parseMessageIds(headerValue(headers, "References"));
  const kept: string[] = [];
  let length = 0;
  for (const id of [...references].reverse()) {
    if (length + id.length + 1 > REFERENCES_MAX) break;
    kept.unshift(id);
    length += id.length + 1;
  }
  return {
    inReplyTo: inReplyTo && inReplyTo.length <= IN_REPLY_TO_MAX ? inReplyTo : null,
    referenceIds: kept.length > 0 ? kept.join(" ") : null,
  };
}

/** The ids to look up for a stored email: References (oldest first), with In-Reply-To last as the nearest ancestor. */
export function ancestorIds(inReplyTo: string | null | undefined, referenceIds: string | null | undefined): string[] {
  const ids = [...parseMessageIds(referenceIds), ...parseMessageIds(inReplyTo)];
  const nearestLast = ids.filter((id, index) => ids.lastIndexOf(id) === index);
  return nearestLast.slice(-20);
}
