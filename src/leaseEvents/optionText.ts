// One source of truth for a lease's options (data review S2-4). The structured
// counts (migration 106) win wherever the app decides, so an edit to the option
// text re-derives them in the same transaction, ledgered:
//
//   readable ("2 x 5 years")  total and term from the text; remaining is the
//                             text's count when nothing was recorded (a recorded
//                             0 of 0 counts as nothing), else the lower of the two,
//                             so an edit never gives back an option already
//                             exercised (the old Accept options dialog rewrites the
//                             text to what is left)
//   blank or plainly none     none: 0 of 0
//   unreadable prose          the counts stay as they are (nothing invented);
//                             the tenancy page shows both, so accounts see the gap
//
// On a database without 106 there is nothing to derive into.

import type { Connection } from "tedious";
import { TYPES } from "tedious";
import { executeQuery } from "../db";
import { parseOptionPeriods } from "../leaseOptions";

export interface OptionCounts {
  remaining: number | null;
  termMonths: number | null;
  total: number | null;
}

const NONE_WORDS = /^(?:nil|none|no|n\/?a|-+|no options?)$/i;

/** The counts the text gives, or null when it can't be read (keep the counts). */
export function deriveOptionsFromText(text: string | null | undefined, current: OptionCounts): OptionCounts | null {
  const trimmed = (text ?? "").trim();
  if (trimmed === "" || NONE_WORDS.test(trimmed)) return { remaining: 0, termMonths: null, total: 0 };
  const parsed = parseOptionPeriods(trimmed);
  if (!parsed) return null;
  // A recorded none (0 of 0) says the lease granted nothing, not that options were used, so it
  // reads as not recorded and the text can set the counts (data recheck S2). Otherwise an
  // understated "none" could never be corrected from the text.
  const recorded = current.remaining !== null && !(current.total === 0 && current.remaining === 0);
  const remaining = recorded ? Math.min(current.remaining as number, parsed.count) : parsed.count;
  return { remaining, termMonths: parsed.termMonths, total: parsed.count };
}

const int = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));
const same = (a: OptionCounts, b: OptionCounts) => a.remaining === b.remaining && a.total === b.total && a.termMonths === b.termMonths;

/** For an option text edit inside the caller's transaction (the row already locked): the counts before and
 *  after, or null when 106 isn't applied, the text can't be read, or nothing changes. */
export async function optionCountsForTextEdit(
  connection: Connection,
  tenantId: number,
  text: string | null | undefined,
): Promise<{ after: OptionCounts; before: OptionCounts } | null> {
  const probe = await executeQuery(connection, "SELECT COL_LENGTH('dbo.Tenants', 'OptionsRemaining') AS Len");
  if (probe[0]?.Len == null) return null;
  const rows = await executeQuery(connection, "SELECT OptionsTotal, OptionsRemaining, OptionTermMonths FROM dbo.Tenants WHERE TenantId = @TenantId", [
    { name: "TenantId", type: TYPES.Int, value: tenantId },
  ]);
  const before: OptionCounts = { remaining: int(rows[0]?.OptionsRemaining), termMonths: int(rows[0]?.OptionTermMonths), total: int(rows[0]?.OptionsTotal) };
  const after = deriveOptionsFromText(text, before);
  return after && !same(before, after) ? { after, before } : null;
}
