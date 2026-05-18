// Pure functions for tenant-incentive validation + array mutation.
// Factored out of the function handler so unit tests can exercise the
// logic without spinning up SQL or HTTP. The handler imports `validate*`,
// `upsertIncentive`, and `deleteIncentive`.

import { randomUUID } from "node:crypto";

export type IncentiveKind = "rentFreeMonths" | "monthlyReduction" | "perSqmRate";

export interface TenancyIncentive {
  id: string;
  kind: IncentiveKind;
  note?: string;
  freeMonthsFromStart?: number;
  reductionAmount?: number;
  reductionMonths?: number | null;
  // perSqmRate
  ratePerSqm?: number;
  durationMonths?: number | null;
}

const UUID_RE = /^[0-9a-f-]{36}$/i;
const NOTE_MAX_LEN = 500;
const MONTHS_MIN = 1;
const MONTHS_MAX = 60;
const REDUCTION_MAX = 1_000_000;

const ALLOWED_KEYS: ReadonlySet<string> = new Set([
  "id",
  "kind",
  "note",
  "freeMonthsFromStart",
  "reductionAmount",
  "reductionMonths",
  "ratePerSqm",
  "durationMonths",
]);

export interface ValidationOk {
  ok: true;
  incentive: TenancyIncentive;
}

export interface ValidationErr {
  ok: false;
  error: string;
}

export type ValidationResult = ValidationOk | ValidationErr;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isPositiveInt(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n > 0;
}

function isIntInRange(n: unknown, min: number, max: number): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= min && n <= max;
}

export function isUuidShaped(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

/**
 * Validates the shape of a TenancyIncentive payload. Returns a normalised
 * incentive (with stripped unknown keys + a server-generated id when the
 * caller omitted or supplied a blank one).
 *
 * Kind-specific fields are required to match the discriminant exactly:
 *   - rentFreeMonths must carry `freeMonthsFromStart`, no reduction fields.
 *   - monthlyReduction must carry `reductionAmount`, optional `reductionMonths`,
 *     no `freeMonthsFromStart`.
 */
export function validateIncentive(raw: unknown): ValidationResult {
  if (!isPlainObject(raw)) {
    return { ok: false, error: "incentive must be an object" };
  }

  // Allowlist check first — unknown keys are a hard reject so we don't
  // silently swallow typos or future-shape drift.
  for (const key of Object.keys(raw)) {
    if (!ALLOWED_KEYS.has(key)) {
      return { ok: false, error: `Unknown key on incentive: ${key}` };
    }
  }

  const { id, kind, note, freeMonthsFromStart, reductionAmount, reductionMonths } =
    raw as Record<string, unknown>;

  if (
    kind !== "rentFreeMonths" &&
    kind !== "monthlyReduction" &&
    kind !== "perSqmRate"
  ) {
    return {
      ok: false,
      error: "kind must be 'rentFreeMonths', 'monthlyReduction', or 'perSqmRate'",
    };
  }

  if (id !== undefined && id !== "") {
    if (typeof id !== "string" || !UUID_RE.test(id)) {
      return { ok: false, error: "id must be a UUID-shaped string" };
    }
  }

  if (note !== undefined) {
    if (typeof note !== "string") {
      return { ok: false, error: "note must be a string" };
    }
    if (note.length > NOTE_MAX_LEN) {
      return { ok: false, error: `note must be ≤${NOTE_MAX_LEN} chars` };
    }
  }

  if (kind === "rentFreeMonths") {
    if (!isIntInRange(freeMonthsFromStart, MONTHS_MIN, MONTHS_MAX)) {
      return {
        ok: false,
        error: `freeMonthsFromStart must be an integer in [${MONTHS_MIN}, ${MONTHS_MAX}]`,
      };
    }
    if (reductionAmount !== undefined) {
      return { ok: false, error: "reductionAmount must not be present when kind is rentFreeMonths" };
    }
    if (reductionMonths !== undefined) {
      return { ok: false, error: "reductionMonths must not be present when kind is rentFreeMonths" };
    }
  } else if (kind === "monthlyReduction") {
    if (
      typeof reductionAmount !== "number" ||
      !Number.isFinite(reductionAmount) ||
      reductionAmount <= 0 ||
      reductionAmount > REDUCTION_MAX
    ) {
      return {
        ok: false,
        error: `reductionAmount must be a finite number in (0, ${REDUCTION_MAX}]`,
      };
    }
    if (reductionMonths !== undefined && reductionMonths !== null) {
      if (!isIntInRange(reductionMonths, MONTHS_MIN, MONTHS_MAX)) {
        return {
          ok: false,
          error: `reductionMonths must be an integer in [${MONTHS_MIN}, ${MONTHS_MAX}] or null`,
        };
      }
    }
    if (freeMonthsFromStart !== undefined) {
      return { ok: false, error: "freeMonthsFromStart must not be present when kind is monthlyReduction" };
    }
  } else {
    // perSqmRate
    const { ratePerSqm, durationMonths } = raw as Record<string, unknown>;
    if (
      typeof ratePerSqm !== "number" ||
      !Number.isFinite(ratePerSqm) ||
      ratePerSqm <= 0 ||
      ratePerSqm > REDUCTION_MAX
    ) {
      return {
        ok: false,
        error: `ratePerSqm must be a finite number in (0, ${REDUCTION_MAX}]`,
      };
    }
    if (durationMonths !== undefined && durationMonths !== null) {
      if (!isIntInRange(durationMonths as unknown, MONTHS_MIN, MONTHS_MAX)) {
        return {
          ok: false,
          error: `durationMonths must be an integer in [${MONTHS_MIN}, ${MONTHS_MAX}] or null`,
        };
      }
    }
    if (freeMonthsFromStart !== undefined) {
      return { ok: false, error: "freeMonthsFromStart must not be present when kind is perSqmRate" };
    }
    if (reductionAmount !== undefined) {
      return { ok: false, error: "reductionAmount must not be present when kind is perSqmRate" };
    }
    if (reductionMonths !== undefined) {
      return { ok: false, error: "reductionMonths must not be present when kind is perSqmRate" };
    }
  }

  const normalised: TenancyIncentive = {
    id: typeof id === "string" && id !== "" ? id : randomUUID(),
    kind,
  };
  if (note !== undefined) normalised.note = note;
  if (kind === "rentFreeMonths") {
    normalised.freeMonthsFromStart = freeMonthsFromStart as number;
  } else if (kind === "monthlyReduction") {
    normalised.reductionAmount = reductionAmount as number;
    if (reductionMonths !== undefined) {
      normalised.reductionMonths = reductionMonths as number | null;
    }
  } else {
    // perSqmRate
    const { ratePerSqm, durationMonths } = raw as Record<string, unknown>;
    normalised.ratePerSqm = ratePerSqm as number;
    if (durationMonths !== undefined) {
      normalised.durationMonths = durationMonths as number | null;
    }
  }
  return { ok: true, incentive: normalised };
}

/**
 * Validate the IDs + body envelope around an incentive upsert. Keeps the
 * handler's request-validation surface in one place.
 */
export function validateUpsertEnvelope(body: unknown): {
  ok: true;
  TenantId: number;
  BuildingId: number;
  incentive: TenancyIncentive;
} | ValidationErr {
  if (!isPlainObject(body)) {
    return { ok: false, error: "body must be an object" };
  }
  if (!isPositiveInt(body.TenantId)) {
    return { ok: false, error: "TenantId must be a positive integer" };
  }
  if (!isPositiveInt(body.BuildingId)) {
    return { ok: false, error: "BuildingId must be a positive integer" };
  }
  const inc = validateIncentive(body.incentive);
  if (!inc.ok) return inc;
  return {
    ok: true,
    TenantId: body.TenantId,
    BuildingId: body.BuildingId,
    incentive: inc.incentive,
  };
}

export function validateDeleteEnvelope(body: unknown): {
  ok: true;
  TenantId: number;
  BuildingId: number;
  incentiveId: string;
} | ValidationErr {
  if (!isPlainObject(body)) {
    return { ok: false, error: "body must be an object" };
  }
  if (!isPositiveInt(body.TenantId)) {
    return { ok: false, error: "TenantId must be a positive integer" };
  }
  if (!isPositiveInt(body.BuildingId)) {
    return { ok: false, error: "BuildingId must be a positive integer" };
  }
  if (!isUuidShaped(body.incentiveId)) {
    return { ok: false, error: "incentiveId must be a UUID-shaped string" };
  }
  return {
    ok: true,
    TenantId: body.TenantId,
    BuildingId: body.BuildingId,
    incentiveId: body.incentiveId,
  };
}

/**
 * Parse the raw JSON column value from the Tenants row. Defaults to [] when
 * null, empty, or malformed — we never want to surface "bad JSON" to the
 * frontend; better to start fresh and let an upsert rewrite the column.
 */
export function parseIncentives(raw: string | null | undefined): TenancyIncentive[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((i): i is TenancyIncentive => {
      // Defensive: only keep entries that look like incentives. We don't
      // re-run full validation here because legacy rows may pre-date a
      // tightening; the goal is "render what we can, drop garbage".
      return (
        isPlainObject(i) &&
        typeof i.id === "string" &&
        (i.kind === "rentFreeMonths" ||
          i.kind === "monthlyReduction" ||
          i.kind === "perSqmRate")
      );
    });
  } catch {
    return [];
  }
}

/**
 * Insert-or-replace by id. If `incoming.id` matches an existing entry, the
 * old entry is replaced in place (stable position). Otherwise appended.
 * Returns a new array; the input is never mutated.
 */
export function upsertIncentive(
  existing: TenancyIncentive[],
  incoming: TenancyIncentive,
): TenancyIncentive[] {
  const idx = existing.findIndex((i) => i.id === incoming.id);
  if (idx === -1) return [...existing, incoming];
  const next = existing.slice();
  next[idx] = incoming;
  return next;
}

export const NOT_FOUND: unique symbol = Symbol("incentive-not-found");

/**
 * Remove by id. Returns `NOT_FOUND` when the id isn't present so the caller
 * can emit a 404 without having to do its own scan.
 */
export function deleteIncentive(
  existing: TenancyIncentive[],
  id: string,
): TenancyIncentive[] | typeof NOT_FOUND {
  const idx = existing.findIndex((i) => i.id === id);
  if (idx === -1) return NOT_FOUND;
  const next = existing.slice();
  next.splice(idx, 1);
  return next;
}
