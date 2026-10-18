// The query of GET /getMyobActivity (SPR-M4), checked before any database
// work: kind (proposals or calls), company file, proposal state, Darwin dates
// from and to (both days included), and format (json or csv).

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const STATES = ["approved", "exception", "proposed", "pushed", "verified", "withdrawn"] as const;

export type ActivityKind = "calls" | "proposals";
export type ActivityState = (typeof STATES)[number];

export interface ActivityFilters {
  companyFileId: string | null;
  from: Date | null;
  state: ActivityState | null;
  /** Exclusive: midnight Darwin after the last day asked for. */
  to: Date | null;
}

export interface ActivityQuery {
  filters: ActivityFilters;
  format: "csv" | "json";
  kind: ActivityKind;
}

const darwinMidnight = (day: string, plusDays = 0) => {
  const date = new Date(`${day}T00:00:00+09:30`);
  return Number.isNaN(date.getTime()) ? null : new Date(date.getTime() + plusDays * 86_400_000);
};

export function parseActivityQuery(query: URLSearchParams): { ok: true; value: ActivityQuery } | { error: string; ok: false } {
  const kind = query.get("kind") ?? "proposals";
  if (kind !== "proposals" && kind !== "calls") return { error: "kind must be proposals or calls", ok: false };
  const file = query.get("file");
  if (file && !GUID.test(file)) return { error: "file must be a MYOB company file id", ok: false };
  const state = query.get("state");
  if (state && !(STATES as readonly string[]).includes(state)) return { error: `state must be one of ${STATES.join(", ")}`, ok: false };
  const fromText = query.get("from");
  const toText = query.get("to");
  for (const day of [fromText, toText]) if (day && (!DATE.test(day) || !darwinMidnight(day))) return { error: "Dates are YYYY-MM-DD", ok: false };
  const from = fromText ? darwinMidnight(fromText) : null;
  const to = toText ? darwinMidnight(toText, 1) : null;
  if (from && to && to <= from) return { error: "The end date is before the start date", ok: false };
  return {
    ok: true,
    value: {
      filters: { companyFileId: file ? file.toLowerCase() : null, from, state: (state as ActivityState | null) ?? null, to },
      format: query.get("format") === "csv" ? "csv" : "json",
      kind,
    },
  };
}
