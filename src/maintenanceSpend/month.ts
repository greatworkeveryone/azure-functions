// A Darwin calendar month for the Maintenance spend report's ?month=YYYY-MM.

import { addDaysIso, addMonthsClamped } from "../darwinDate";
import type { Period } from "./financialYear";

const LABEL = /^(\d{4})-(0[1-9]|1[0-2])$/;
const FIRST_YEAR = 2000;

/** The month named, first to last day. One month ahead is allowed (clock skew at midnight), as for financial years. */
export function parseMonth(raw: string, today: string): Period | { error: string } {
  const parts = raw.match(LABEL);
  if (!parts || Number(parts[1]) < FIRST_YEAR) return { error: `month must look like 2026-11: a calendar month from ${FIRST_YEAR}-01` };
  const from = `${parts[1]}-${parts[2]}-01`;
  if (from > addMonthsClamped(`${today.slice(0, 7)}-01`, 1)) return { error: "month must not be more than one month ahead" };
  return { from, label: `${parts[1]}-${parts[2]}`, to: addDaysIso(addMonthsClamped(from, 1), -1) };
}
