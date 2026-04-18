// Shared date helpers for myBuildings API interactions.
// myBuildings expects dates as "D MMM YYYY" (e.g. "14 Apr 2024").

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

export function toMyBuildingsDate(date: Date): string {
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

export const TWO_YEARS_MS = 2 * 365 * 24 * 60 * 60 * 1000;
