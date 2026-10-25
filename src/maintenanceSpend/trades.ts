// The trade a job's spend is reported under. Jobs.Category is free text: maintenance
// jobs carry one of the maintenance categories (ASSET_CATEGORIES, the backend copy of
// the frontend's MAINTENANCE_CATEGORIES), facilities jobs carry "Common Areas" or
// "Tenancy Works", and an older job may carry anything or nothing. A known category
// takes its list label whatever its case; any other text is kept as written, as a
// trade of its own; blank is "Not categorised".

import { ASSET_CATEGORIES } from "../assetRegister";

export const NOT_CATEGORISED = "Not categorised";

const KNOWN: readonly string[] = ASSET_CATEGORIES;
const KNOWN_BY_LOWER = new Map(KNOWN.map((label) => [label.toLowerCase(), label]));

/** The trade label for a job's category. */
export function tradeLabel(category: unknown): string {
  const text = typeof category === "string" ? category.trim().replace(/\s+/g, " ") : "";
  if (text === "") return NOT_CATEGORISED;
  return KNOWN_BY_LOWER.get(text.toLowerCase()) ?? text;
}

/** Grouping key: the same trade whatever the case of its free text (the first spelling seen names the group). */
export const tradeKey = (label: string): string => label.toLowerCase();

/** 0 a listed trade, 1 any other text, 2 "Not categorised". */
const tier = (label: string): number => (label === NOT_CATEGORISED ? 2 : KNOWN.includes(label) ? 0 : 1);

/** The listed trades in their list order, then any others alphabetically, then "Not categorised". */
export function compareTrades(a: string, b: string): number {
  const byTier = tier(a) - tier(b);
  if (byTier !== 0) return byTier;
  return tier(a) === 0 ? KNOWN.indexOf(a) - KNOWN.indexOf(b) : a.localeCompare(b, "en-AU");
}
