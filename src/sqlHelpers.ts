// Small shared helpers for the SQL store and endpoint modules. New code imports these; the older local copies
// of `iso` elsewhere in src are left alone on purpose (touching ~28 files for a one-liner is not worth the churn).

import type { SqlParam } from "./db";

/** A SQL datetime as an ISO string, or null when the column is NULL or not a Date. */
export const iso = (value: unknown): string | null => (value instanceof Date ? value.toISOString() : null);

/** A named query parameter. */
export const sqlParam = (name: string, type: SqlParam["type"], value: unknown): SqlParam => ({ name, type, value });

/** The string, trimmed, or null when it is not a string or is blank. */
export const trimmedOrNull = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value.trim() : null);
