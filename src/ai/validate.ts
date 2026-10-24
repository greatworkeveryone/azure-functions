// Small hand-written helpers for a purpose's output validator (SC-AI1). Model
// output is untrusted: a validator copies out only the fields it knows, checks
// each one, and refuses everything else. No schema library, so no new dependency.

import type { AiValidation } from "./types";

export const accept = <Output>(value: Output): AiValidation<Output> => ({ ok: true, value });
export const refuse = (reason: string): AiValidation<never> => ({ ok: false, reason });

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The object's own keys that are not in `known`: a model that adds fields is not following the schema. */
export function unknownKeys(value: Record<string, unknown>, known: readonly string[]): string[] {
  return Object.keys(value).filter((key) => !known.includes(key));
}

/** A string of at most `max` characters, or null. Control characters are refused: output is data, and never markup. */
export function boundedString(value: unknown, max: number): string | null {
  if (typeof value !== "string" || value.length > max) return null;
  return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) ? null : value;
}

/** A finite number within [min, max], or null. A numeric string is not a number. */
export function boundedNumber(value: unknown, min: number, max: number): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? value : null;
}

export function oneOf<Choice extends string>(value: unknown, choices: readonly Choice[]): Choice | null {
  return typeof value === "string" && (choices as readonly string[]).includes(value) ? (value as Choice) : null;
}
