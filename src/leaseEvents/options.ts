// A tenancy's options as the lease event engine reads them (WP32): the
// structured columns migration 106 adds when they are set, else WP19's parse of
// the free-text OptionPeriods, which is how every tenancy read before the
// backfill. Pure.

import type { SqlRow } from "../db";
import {
  type OptionMethodKind,
  type OptionNoticeWindow,
  optionNoticeWindow,
  parseOptionPeriods,
} from "../leaseOptions";
import { mapMethodKind } from "../leaseMethod";
import { sqlDateToIso } from "../nextReviewDate";

export interface LeaseOptions {
  /** Options still to exercise; null when nothing records them. */
  remaining: number | null;
  /** "structured": the 106 columns; "parsed": read from OptionPeriods; "none": neither. */
  source: "none" | "parsed" | "structured";
  /** Months in each option; null when unknown. */
  termMonths: number | null;
  total: number | null;
}

const intOrNull = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isInteger(n) ? n : null;
};

export function leaseOptionsOf(row: SqlRow): LeaseOptions {
  const parsed = parseOptionPeriods(typeof row.OptionPeriods === "string" ? row.OptionPeriods : null);
  const remaining = intOrNull(row.OptionsRemaining);
  if (remaining !== null) {
    return {
      remaining,
      source: "structured",
      termMonths: intOrNull(row.OptionTermMonths) ?? parsed?.termMonths ?? null,
      total: intOrNull(row.OptionsTotal) ?? remaining,
    };
  }
  if (parsed) return { remaining: parsed.count, source: "parsed", termMonths: parsed.termMonths, total: parsed.count };
  return { remaining: null, source: "none", termMonths: null, total: null };
}

/** Where `today` sits in the tenancy's option notice window, counting only options still left. */
export function optionWindowOf(row: SqlRow, today: string): OptionNoticeWindow {
  const options = leaseOptionsOf(row);
  return optionNoticeWindow(
    {
      expiry: sqlDateToIso(row.Expiry),
      optionNoticeMonths: intOrNull(row.OptionNoticeMonths),
      optionPeriods: typeof row.OptionPeriods === "string" ? row.OptionPeriods : null,
      optionsRemaining: options.source === "structured" ? options.remaining : null,
    },
    today,
  );
}

/** The lease's own review method, for an option term's ongoing reviews (WP32 default). */
export function leaseReviewMethod(row: SqlRow): OptionMethodKind {
  const kind = mapMethodKind(typeof row.ReviewType === "string" ? row.ReviewType : "");
  return kind === "cpi" || kind === "fixed" || kind === "market" ? kind : "other";
}

export function leaseFixedPercent(row: SqlRow): number | null {
  const n = row.FixedReviewPercent === null || row.FixedReviewPercent === undefined ? Number.NaN : Number(row.FixedReviewPercent);
  return Number.isFinite(n) ? n : null;
}

export function leaseIntervalMonths(row: SqlRow): number {
  const n = intOrNull(row.ReviewIntervalMonths);
  return n !== null && n >= 1 ? n : 12;
}
