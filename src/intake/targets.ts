// Response targets (TR1): how many business hours Facilities promises to acknowledge a request within, per priority.
// Unset (NULL) means no promise: no clock on the screen and nothing for the escalation sweep to raise.

import { TYPES, type Connection } from "tedious";
import { executeQuery } from "../db";
import { INTAKE_PRIORITIES, type IntakePriority } from "./state";

export interface IntakeTarget {
  hours: number | null;
  priority: IntakePriority;
  setAt: string | null;
  setBy: string | null;
}

/** Matches the CHECK in migration 182. */
const MAX_TARGET_HOURS = 720;

export async function readTargets(connection: Connection): Promise<IntakeTarget[]> {
  const rows = await executeQuery(connection, "SELECT Priority, AckWithinBusinessHours, SetAt, SetBy FROM dbo.IntakeResponseTargets");
  const byPriority = new Map(rows.map((row) => [String(row.Priority), row]));
  return INTAKE_PRIORITIES.map((priority) => {
    const row = byPriority.get(priority);
    const hours = row?.AckWithinBusinessHours;
    return {
      hours: hours === null || hours === undefined ? null : Number(hours),
      priority,
      setAt: row?.SetAt instanceof Date ? row.SetAt.toISOString() : null,
      setBy: typeof row?.SetBy === "string" ? row.SetBy : null,
    };
  });
}

export type ParsedTargets = { error: string; ok: false } | { ok: true; value: Partial<Record<IntakePriority, number | null>> };

/** { targets: { High: 4, Low: null } }: a whole number of business hours, or null to clear. Priorities not named are left alone. */
export function parseTargets(body: Record<string, unknown>): ParsedTargets {
  const extra = Object.keys(body).find((key) => key !== "targets");
  if (extra) return { error: `Unknown field "${extra.slice(0, 40)}"`, ok: false };
  const raw = body.targets;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { error: "targets must be an object keyed by priority", ok: false };
  const value: Partial<Record<IntakePriority, number | null>> = {};
  for (const [key, hours] of Object.entries(raw as Record<string, unknown>)) {
    if (!(INTAKE_PRIORITIES as readonly string[]).includes(key)) return { error: `Unknown priority "${key.slice(0, 40)}"`, ok: false };
    if (hours === null) value[key as IntakePriority] = null;
    else if (typeof hours === "number" && Number.isInteger(hours) && hours >= 1 && hours <= MAX_TARGET_HOURS) value[key as IntakePriority] = hours;
    else return { error: `${key}: hours must be a whole number from 1 to ${MAX_TARGET_HOURS}, or empty for no target`, ok: false };
  }
  if (Object.keys(value).length === 0) return { error: "Name at least one priority", ok: false };
  return { ok: true, value };
}

/** Writes only what changed. SetAt moves only when the hours do, so an unchanged save never lets the clock reach back. */
export async function writeTargets(connection: Connection, changes: Partial<Record<IntakePriority, number | null>>, by: string): Promise<IntakePriority[]> {
  const changed: IntakePriority[] = [];
  for (const [priority, hours] of Object.entries(changes) as [IntakePriority, number | null][]) {
    const rows = await executeQuery(
      connection,
      `UPDATE dbo.IntakeResponseTargets
          SET AckWithinBusinessHours = @Hours, SetAt = SYSUTCDATETIME(), SetBy = @By
        OUTPUT inserted.Priority
        WHERE Priority = @Priority AND ISNULL(AckWithinBusinessHours, 0) <> ISNULL(@Hours, 0)`,
      [
        { name: "Hours", type: TYPES.Int, value: hours },
        { name: "By", type: TYPES.NVarChar, value: by.slice(0, 160) },
        { name: "Priority", type: TYPES.NVarChar, value: priority },
      ],
    );
    if (rows.length > 0) changed.push(priority);
  }
  return changed;
}
