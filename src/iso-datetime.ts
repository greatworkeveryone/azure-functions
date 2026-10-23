const ISO = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,7})?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/** Parses an ISO 8601 date or date-time (no offset = UTC); null for anything else, including impossible dates. */
export function parseIsoDateTime(raw: unknown): Date | null {
  if (typeof raw !== "string") return null;
  const m = ISO.exec(raw.trim());
  if (!m) return null;
  const [, y, mo, d, h = "0", mi = "0", s = "0", zone] = m;
  const probe = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)));
  // Date.UTC rolls 31 Feb over to March; a round-trip catches it.
  if (probe.getUTCFullYear() !== Number(y) || probe.getUTCMonth() !== Number(mo) - 1 || probe.getUTCDate() !== Number(d)) return null;
  if (Number(h) > 23 || Number(mi) > 59 || Number(s) > 59) return null;
  const date = `${y}-${mo}-${d}`;
  if (m[4] === undefined) return new Date(`${date}T00:00:00Z`);
  const zoneText = zone ? zone.replace(/^([+-]\d{2})(\d{2})$/, "$1:$2") : "Z"; // no offset = UTC
  const time = `${h}:${mi}:${s.padStart(2, "0")}`;
  const parsed = new Date(`${date}T${time}${zoneText}`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
