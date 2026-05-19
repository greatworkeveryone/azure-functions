import { randomUUID } from "node:crypto";

export type RentScheduleMethodKind =
  | "cpi"
  | "commencement"
  | "fixed"
  | "market"
  | "other";

export interface ScheduledRateStep {
  id: string;
  /** Starting AHAC ph annual amount, set on commencement rows. Reviews at the same rate as rent. */
  ahacBasePerAnnum?: number;
  /** Starting annual rent for commencement rows — the origin the schedule builds from. */
  baseRentPerAnnum?: number;
  /** Total leaseable area (m²) for this period. Used to compute per-m² rate. */
  sqm?: number;
  effectiveFrom: string; // ISO date e.g. "2026-07-01"
  effectiveTo?: string;  // ISO date — end of this period (exclusive)
  methodKind?: RentScheduleMethodKind;
  /** Raw CPI index value for this period (e.g. 115.6). Present when methodKind="cpi". */
  cpiValue?: number;
  /** CPI index value from the previous period — stored explicitly so edits are stable. */
  cpiValuePrev?: number;
  /** Increase % from the previous period. 0 allowed for commencement rows. */
  ratePercent: number;
  note?: string;
  flagComment?: string;
}

export interface StepValidationOk {
  ok: true;
  step: ScheduledRateStep;
}

export interface StepValidationErr {
  ok: false;
  error: string;
}

export type StepValidationResult = StepValidationOk | StepValidationErr;

const UUID_RE = /^[0-9a-f-]{36}$/i;
// YYYY-MM-DD
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const NOTE_MAX_LEN = 300;
const RATE_MIN = -100;
const RATE_MAX = 100;

const METHOD_KINDS: ReadonlySet<string> = new Set([
  "cpi",
  "commencement",
  "fixed",
  "market",
  "other",
]);

const ALLOWED_KEYS: ReadonlySet<string> = new Set([
  "id",
  "ahacBasePerAnnum",
  "baseRentPerAnnum",
  "sqm",
  "effectiveFrom",
  "effectiveTo",
  "methodKind",
  "cpiValue",
  "cpiValuePrev",
  "ratePercent",
  "note",
  "flagComment",
]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function isUuidShaped(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

export function validateStep(raw: unknown): StepValidationResult {
  if (!isPlainObject(raw)) {
    return { ok: false, error: "step must be an object" };
  }

  for (const key of Object.keys(raw)) {
    if (!ALLOWED_KEYS.has(key)) {
      return { ok: false, error: `Unknown key on step: ${key}` };
    }
  }

  const { id, ahacBasePerAnnum, baseRentPerAnnum, sqm, effectiveFrom, effectiveTo, methodKind, cpiValue, cpiValuePrev, ratePercent, note, flagComment } = raw;

  if (id !== undefined && id !== "") {
    if (!isUuidShaped(id)) {
      return { ok: false, error: "id must be a UUID-shaped string" };
    }
  }

  if (typeof effectiveFrom !== "string" || !ISO_DATE_RE.test(effectiveFrom)) {
    return { ok: false, error: "effectiveFrom must be an ISO date string (YYYY-MM-DD)" };
  }

  if (effectiveTo !== undefined) {
    if (typeof effectiveTo !== "string" || !ISO_DATE_RE.test(effectiveTo)) {
      return { ok: false, error: "effectiveTo must be an ISO date string (YYYY-MM-DD)" };
    }
  }

  if (ahacBasePerAnnum !== undefined) {
    if (typeof ahacBasePerAnnum !== "number" || !Number.isFinite(ahacBasePerAnnum) || ahacBasePerAnnum < 0) {
      return { ok: false, error: "ahacBasePerAnnum must be a non-negative number" };
    }
  }

  if (baseRentPerAnnum !== undefined) {
    if (typeof baseRentPerAnnum !== "number" || !Number.isFinite(baseRentPerAnnum) || baseRentPerAnnum < 0) {
      return { ok: false, error: "baseRentPerAnnum must be a non-negative number" };
    }
  }

  if (sqm !== undefined) {
    if (typeof sqm !== "number" || !Number.isFinite(sqm) || sqm < 0) {
      return { ok: false, error: "sqm must be a non-negative number" };
    }
  }

  if (methodKind !== undefined) {
    if (!METHOD_KINDS.has(methodKind as string)) {
      return { ok: false, error: `methodKind must be one of: ${[...METHOD_KINDS].join(", ")}` };
    }
  }

  if (cpiValue !== undefined) {
    if (typeof cpiValue !== "number" || !Number.isFinite(cpiValue) || cpiValue <= 0) {
      return { ok: false, error: "cpiValue must be a positive number" };
    }
  }

  if (cpiValuePrev !== undefined) {
    if (typeof cpiValuePrev !== "number" || !Number.isFinite(cpiValuePrev) || cpiValuePrev <= 0) {
      return { ok: false, error: "cpiValuePrev must be a positive number" };
    }
  }

  if (
    typeof ratePercent !== "number" ||
    !Number.isFinite(ratePercent) ||
    ratePercent < RATE_MIN ||
    ratePercent > RATE_MAX
  ) {
    return {
      ok: false,
      error: `ratePercent must be a number in [${RATE_MIN}, ${RATE_MAX}]`,
    };
  }

  if (note !== undefined) {
    if (typeof note !== "string") return { ok: false, error: "note must be a string" };
    if (note.length > NOTE_MAX_LEN) {
      return { ok: false, error: `note must be ≤${NOTE_MAX_LEN} chars` };
    }
  }

  if (flagComment !== undefined) {
    if (typeof flagComment !== "string") return { ok: false, error: "flagComment must be a string" };
    if (flagComment.length > NOTE_MAX_LEN) {
      return { ok: false, error: `flagComment must be ≤${NOTE_MAX_LEN} chars` };
    }
  }

  const normalised: ScheduledRateStep = {
    effectiveFrom,
    id: typeof id === "string" && id !== "" ? id : randomUUID(),
    ratePercent,
  };
  if (ahacBasePerAnnum !== undefined) normalised.ahacBasePerAnnum = ahacBasePerAnnum as number;
  if (baseRentPerAnnum !== undefined) normalised.baseRentPerAnnum = baseRentPerAnnum as number;
  if (sqm !== undefined) normalised.sqm = sqm as number;
  if (effectiveTo !== undefined) normalised.effectiveTo = effectiveTo as string;
  if (methodKind !== undefined) normalised.methodKind = methodKind as RentScheduleMethodKind;
  if (cpiValue !== undefined) normalised.cpiValue = cpiValue as number;
  if (cpiValuePrev !== undefined) normalised.cpiValuePrev = cpiValuePrev as number;
  if (note !== undefined) normalised.note = note as string;
  if (flagComment !== undefined) normalised.flagComment = flagComment as string;
  return { ok: true, step: normalised };
}

export function validateUpsertStepEnvelope(body: unknown):
  | { ok: true; TenantId: number; BuildingId: number; step: ScheduledRateStep }
  | StepValidationErr {
  if (!isPlainObject(body)) return { ok: false, error: "body must be an object" };
  const { TenantId, BuildingId } = body;
  if (typeof TenantId !== "number" || !Number.isInteger(TenantId) || TenantId <= 0) {
    return { ok: false, error: "TenantId must be a positive integer" };
  }
  if (typeof BuildingId !== "number" || !Number.isInteger(BuildingId) || BuildingId <= 0) {
    return { ok: false, error: "BuildingId must be a positive integer" };
  }
  const result = validateStep(body.step);
  if (!result.ok) return result;
  return { ok: true, TenantId: TenantId as number, BuildingId: BuildingId as number, step: result.step };
}

export function validateDeleteStepEnvelope(body: unknown):
  | { ok: true; TenantId: number; BuildingId: number; stepId: string }
  | StepValidationErr {
  if (!isPlainObject(body)) return { ok: false, error: "body must be an object" };
  const { TenantId, BuildingId, stepId } = body;
  if (typeof TenantId !== "number" || !Number.isInteger(TenantId) || TenantId <= 0) {
    return { ok: false, error: "TenantId must be a positive integer" };
  }
  if (typeof BuildingId !== "number" || !Number.isInteger(BuildingId) || BuildingId <= 0) {
    return { ok: false, error: "BuildingId must be a positive integer" };
  }
  if (!isUuidShaped(stepId)) {
    return { ok: false, error: "stepId must be a UUID-shaped string" };
  }
  return { ok: true, TenantId: TenantId as number, BuildingId: BuildingId as number, stepId: stepId as string };
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Walks the rate steps and returns the annual rent for the period that contains
 * `today`. Mirrors the frontend `resolveScheduleRent` so that the backend-computed
 * `effectiveRentPerAnnum` / `monthlyRental` / `dollarsToExpiry` are schedule-aware.
 *
 * Falls back to `fallbackAnnual` when steps is empty or no non-pending row is found.
 */
export function resolveScheduleAnnual(
  steps: ScheduledRateStep[],
  fallbackAnnual: number,
  sqm: number,
  today: string,
): number {
  if (steps.length === 0) return fallbackAnnual;

  const sorted = [...steps].sort((a, b) =>
    a.effectiveFrom.localeCompare(b.effectiveFrom),
  );

  let running = fallbackAnnual;
  let runningSqmRate = sqm > 0 ? fallbackAnnual / sqm : 0;
  let prevCpiValue: number | null = null;
  let hasPending = false;

  interface ComputedRow {
    effectiveFrom: string;
    effectiveTo?: string;
    annual: number;
    pending: boolean;
  }

  const rows: ComputedRow[] = [];

  for (const step of sorted) {
    const isRate = step.methodKind !== "commencement";
    const stepSqm = step.sqm ?? sqm;

    if (step.methodKind === "commencement") {
      hasPending = false;
      if (step.baseRentPerAnnum != null) {
        running = step.baseRentPerAnnum;
        runningSqmRate = stepSqm > 0 ? step.baseRentPerAnnum / stepSqm : 0;
      }
    }

    if (step.methodKind === "cpi" && step.cpiValue == null) hasPending = true;
    if (
      (step.methodKind === "market" || step.methodKind === "other") &&
      step.ratePercent === 0
    ) hasPending = true;

    if (hasPending) {
      rows.push({
        annual: 0,
        effectiveFrom: step.effectiveFrom,
        effectiveTo: step.effectiveTo,
        pending: true,
      });
      continue;
    }

    const effectivePrevCpi = step.cpiValuePrev ?? prevCpiValue;
    const factor =
      step.methodKind === "cpi" &&
      step.cpiValue != null &&
      effectivePrevCpi != null
        ? step.cpiValue / effectivePrevCpi
        : 1 + step.ratePercent / 100;

    if (isRate) {
      runningSqmRate = runningSqmRate * factor;
      running = runningSqmRate * stepSqm;
    }

    if (step.cpiValue != null) prevCpiValue = step.cpiValue;

    rows.push({
      annual: r2(running),
      effectiveFrom: step.effectiveFrom,
      effectiveTo: step.effectiveTo,
      pending: false,
    });
  }

  const current =
    rows.find(
      (r) =>
        !r.pending &&
        r.effectiveFrom <= today &&
        (r.effectiveTo == null || r.effectiveTo >= today),
    ) ?? [...rows].reverse().find((r) => !r.pending);

  return current?.annual ?? fallbackAnnual;
}

export function parseSteps(raw: string | null | undefined): ScheduledRateStep[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (s): s is ScheduledRateStep =>
        isPlainObject(s) &&
        typeof s.id === "string" &&
        typeof s.effectiveFrom === "string" &&
        typeof s.ratePercent === "number",
    );
  } catch {
    return [];
  }
}

export function upsertStep(
  existing: ScheduledRateStep[],
  incoming: ScheduledRateStep,
): ScheduledRateStep[] {
  const idx = existing.findIndex((s) => s.id === incoming.id);
  if (idx === -1) return [...existing, incoming];
  const next = existing.slice();
  next[idx] = incoming;
  return next;
}

export const NOT_FOUND: unique symbol = Symbol("step-not-found");

export function deleteStep(
  existing: ScheduledRateStep[],
  id: string,
): ScheduledRateStep[] | typeof NOT_FOUND {
  const idx = existing.findIndex((s) => s.id === id);
  if (idx === -1) return NOT_FOUND;
  const next = existing.slice();
  next.splice(idx, 1);
  return next;
}

// ── Change log diff ───────────────────────────────────────────────────────────

export type StepDiff = Record<string, { from: unknown; to: unknown }>;

const DIFF_FIELDS: ReadonlyArray<keyof ScheduledRateStep> = [
  "effectiveFrom",
  "effectiveTo",
  "methodKind",
  "ratePercent",
  "baseRentPerAnnum",
  "ahacBasePerAnnum",
  "sqm",
  "cpiValue",
  "cpiValuePrev",
  "note",
  "flagComment",
];

export function diffSteps(
  prev: ScheduledRateStep,
  next: ScheduledRateStep,
): StepDiff | null {
  const diff: StepDiff = {};
  for (const field of DIFF_FIELDS) {
    const from = prev[field];
    const to = next[field];
    if (from !== to) {
      diff[field] = { from: from ?? null, to: to ?? null };
    }
  }
  return Object.keys(diff).length > 0 ? diff : null;
}

// ── Carpark schedule groups (m057) ────────────────────────────────────────────

export interface CarparkRateStep {
  id: string;
  /** Must match a rent schedule row's effectiveFrom. */
  effectiveFrom: string;
  methodKind?: RentScheduleMethodKind;
  /** New monthly total when methodKind is undefined (manual reset). */
  newMonthlyRate?: number;
  /** CPI index value (new period) when methodKind === "cpi". */
  cpiValue?: number;
  /** CPI index value from the previous period — stored explicitly so edits are stable. */
  cpiValuePrev?: number;
  /** Rate % when methodKind is fixed / market / other. */
  ratePercent?: number;
  note?: string;
}

export interface CarparkScheduleGroup {
  id: string;
  label: string;
  carparkIds: string[];
  /** Starting total monthly rate for the group. */
  baseMonthlyRate: number;
  /** ISO date (YYYY-MM-DD) — which schedule period this group first applies from. */
  commencedAt: string;
  /** Manual rate overrides for specific review dates. */
  rateSteps?: CarparkRateStep[];
}

const LABEL_MAX = 200;
const CARPARK_IDS_MAX = 100;

const GROUP_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  "id", "label", "carparkIds", "baseMonthlyRate", "commencedAt", "rateSteps",
]);

const RATE_STEP_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  "id", "effectiveFrom", "methodKind", "newMonthlyRate", "cpiValue", "cpiValuePrev", "ratePercent", "note",
]);

const VALID_METHOD_KINDS = new Set<string>(["cpi", "commencement", "fixed", "market", "other"]);

function validateCarparkRateStep(raw: unknown, idx: number): { ok: true; step: CarparkRateStep } | StepValidationErr {
  if (!isPlainObject(raw)) return { ok: false, error: `rateSteps[${idx}] must be an object` };
  for (const key of Object.keys(raw)) {
    if (!RATE_STEP_ALLOWED_KEYS.has(key)) return { ok: false, error: `Unknown key on rateStep[${idx}]: ${key}` };
  }
  const { id, effectiveFrom, methodKind, newMonthlyRate, cpiValue, cpiValuePrev, ratePercent, note } = raw;
  if (!isUuidShaped(id)) return { ok: false, error: `rateSteps[${idx}].id must be a UUID` };
  if (typeof effectiveFrom !== "string" || !ISO_DATE_RE.test(effectiveFrom)) return { ok: false, error: `rateSteps[${idx}].effectiveFrom must be YYYY-MM-DD` };
  if (methodKind !== undefined && (typeof methodKind !== "string" || !VALID_METHOD_KINDS.has(methodKind))) return { ok: false, error: `rateSteps[${idx}].methodKind is invalid` };
  if (newMonthlyRate !== undefined && (typeof newMonthlyRate !== "number" || !Number.isFinite(newMonthlyRate) || newMonthlyRate < 0)) return { ok: false, error: `rateSteps[${idx}].newMonthlyRate must be a non-negative number` };
  if (cpiValue !== undefined && (typeof cpiValue !== "number" || !Number.isFinite(cpiValue) || cpiValue <= 0)) return { ok: false, error: `rateSteps[${idx}].cpiValue must be a positive number` };
  if (cpiValuePrev !== undefined && (typeof cpiValuePrev !== "number" || !Number.isFinite(cpiValuePrev) || cpiValuePrev <= 0)) return { ok: false, error: `rateSteps[${idx}].cpiValuePrev must be a positive number` };
  if (ratePercent !== undefined && (typeof ratePercent !== "number" || !Number.isFinite(ratePercent))) return { ok: false, error: `rateSteps[${idx}].ratePercent must be a number` };
  if (note !== undefined && typeof note !== "string") return { ok: false, error: `rateSteps[${idx}].note must be a string` };
  return {
    ok: true,
    step: {
      id: id as string,
      effectiveFrom: effectiveFrom as string,
      ...(methodKind !== undefined && { methodKind: methodKind as RentScheduleMethodKind }),
      ...(newMonthlyRate !== undefined && { newMonthlyRate: newMonthlyRate as number }),
      ...(cpiValue !== undefined && { cpiValue: cpiValue as number }),
      ...(cpiValuePrev !== undefined && { cpiValuePrev: cpiValuePrev as number }),
      ...(ratePercent !== undefined && { ratePercent: ratePercent as number }),
      ...(note !== undefined && { note: (note as string).trim() }),
    },
  };
}

export function validateCarparkScheduleGroup(raw: unknown): { ok: true; group: CarparkScheduleGroup } | StepValidationErr {
  if (!isPlainObject(raw)) return { ok: false, error: "group must be an object" };

  for (const key of Object.keys(raw)) {
    if (!GROUP_ALLOWED_KEYS.has(key)) return { ok: false, error: `Unknown key on group: ${key}` };
  }

  const { id, label, carparkIds, baseMonthlyRate, commencedAt } = raw;

  if (!isUuidShaped(id)) return { ok: false, error: "group.id must be a UUID-shaped string" };
  if (typeof label !== "string" || label.trim().length === 0) return { ok: false, error: "group.label must be a non-empty string" };
  if (label.length > LABEL_MAX) return { ok: false, error: `group.label must be ≤${LABEL_MAX} chars` };
  if (!Array.isArray(carparkIds) || carparkIds.length === 0) return { ok: false, error: "group.carparkIds must be a non-empty array" };
  if (carparkIds.length > CARPARK_IDS_MAX) return { ok: false, error: `group.carparkIds must have ≤${CARPARK_IDS_MAX} entries` };
  if (carparkIds.some((cid) => typeof cid !== "string" || cid.trim().length === 0)) return { ok: false, error: "each carparkId must be a non-empty string" };
  if (typeof baseMonthlyRate !== "number" || !Number.isFinite(baseMonthlyRate) || baseMonthlyRate < 0) return { ok: false, error: "group.baseMonthlyRate must be a non-negative number" };
  if (typeof commencedAt !== "string" || !ISO_DATE_RE.test(commencedAt)) return { ok: false, error: "group.commencedAt must be an ISO date string (YYYY-MM-DD)" };

  const { rateSteps } = raw;
  let validatedSteps: CarparkRateStep[] | undefined;
  if (rateSteps !== undefined) {
    if (!Array.isArray(rateSteps)) return { ok: false, error: "group.rateSteps must be an array" };
    validatedSteps = [];
    for (let i = 0; i < rateSteps.length; i++) {
      const result = validateCarparkRateStep(rateSteps[i], i);
      if (!result.ok) return result;
      validatedSteps.push(result.step);
    }
  }

  return {
    ok: true,
    group: {
      id: id as string,
      label: label.trim(),
      carparkIds: carparkIds as string[],
      baseMonthlyRate,
      commencedAt,
      ...(validatedSteps !== undefined && { rateSteps: validatedSteps }),
    },
  };
}

export function validateUpsertGroupEnvelope(body: unknown):
  | { ok: true; TenantId: number; BuildingId: number; group: CarparkScheduleGroup }
  | StepValidationErr {
  if (!isPlainObject(body)) return { ok: false, error: "body must be an object" };
  const { TenantId, BuildingId } = body;
  if (typeof TenantId !== "number" || !Number.isInteger(TenantId) || TenantId <= 0) return { ok: false, error: "TenantId must be a positive integer" };
  if (typeof BuildingId !== "number" || !Number.isInteger(BuildingId) || BuildingId <= 0) return { ok: false, error: "BuildingId must be a positive integer" };
  const result = validateCarparkScheduleGroup(body.group);
  if (!result.ok) return result;
  return { ok: true, TenantId: TenantId as number, BuildingId: BuildingId as number, group: result.group };
}

export function validateDeleteGroupEnvelope(body: unknown):
  | { ok: true; TenantId: number; BuildingId: number; groupId: string }
  | StepValidationErr {
  if (!isPlainObject(body)) return { ok: false, error: "body must be an object" };
  const { TenantId, BuildingId, groupId } = body;
  if (typeof TenantId !== "number" || !Number.isInteger(TenantId) || TenantId <= 0) return { ok: false, error: "TenantId must be a positive integer" };
  if (typeof BuildingId !== "number" || !Number.isInteger(BuildingId) || BuildingId <= 0) return { ok: false, error: "BuildingId must be a positive integer" };
  if (!isUuidShaped(groupId)) return { ok: false, error: "groupId must be a UUID-shaped string" };
  return { ok: true, TenantId: TenantId as number, BuildingId: BuildingId as number, groupId: groupId as string };
}

export function parseGroups(raw: string | null | undefined): CarparkScheduleGroup[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (g): g is Record<string, unknown> =>
          isPlainObject(g) &&
          isUuidShaped(g.id) &&
          typeof g.label === "string" &&
          Array.isArray(g.carparkIds) &&
          typeof g.baseMonthlyRate === "number" &&
          typeof g.commencedAt === "string",
      )
      .map((g): CarparkScheduleGroup => ({
        id: g.id as string,
        label: g.label as string,
        carparkIds: g.carparkIds as string[],
        baseMonthlyRate: g.baseMonthlyRate as number,
        commencedAt: g.commencedAt as string,
        ...(Array.isArray(g.rateSteps) && g.rateSteps.length > 0 && {
          rateSteps: (g.rateSteps as unknown[]).filter(
            (s): s is CarparkRateStep =>
              isPlainObject(s) && isUuidShaped(s.id) && typeof s.effectiveFrom === "string",
          ),
        }),
      }));
  } catch {
    return [];
  }
}

export function upsertGroup(existing: CarparkScheduleGroup[], incoming: CarparkScheduleGroup): CarparkScheduleGroup[] {
  const idx = existing.findIndex((g) => g.id === incoming.id);
  if (idx === -1) return [...existing, incoming];
  const next = existing.slice();
  next[idx] = incoming;
  return next;
}

export function deleteGroup(existing: CarparkScheduleGroup[], id: string): CarparkScheduleGroup[] | typeof NOT_FOUND {
  const idx = existing.findIndex((g) => g.id === id);
  if (idx === -1) return NOT_FOUND;
  const next = existing.slice();
  next.splice(idx, 1);
  return next;
}

// ── Misc fees (m059) ──────────────────────────────────────────────────────────

export type MiscFeeFrequency = "monthly" | "quarterly" | "annual";

export interface MiscFeeRateStep {
  id: string;
  effectiveFrom: string;
  methodKind?: RentScheduleMethodKind;
  /** Manual new amount in stated frequency. */
  newAmount?: number;
  cpiValue?: number;
  ratePercent?: number;
  note?: string;
}

export interface MiscFee {
  id: string;
  title: string;
  frequency: MiscFeeFrequency;
  /** Starting amount in stated frequency (not normalised to monthly). */
  baseAmount: number;
  commencedAt: string;
  endsAt?: string;
  note?: string;
  rateSteps?: MiscFeeRateStep[];
}

const FEE_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  "id", "title", "frequency", "baseAmount", "commencedAt", "endsAt", "note", "rateSteps",
]);

const FEE_RATE_STEP_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  "id", "effectiveFrom", "methodKind", "newAmount", "cpiValue", "ratePercent", "note",
]);

const VALID_FREQUENCIES = new Set<string>(["monthly", "quarterly", "annual"]);

function validateMiscFeeRateStep(raw: unknown, idx: number): { ok: true; step: MiscFeeRateStep } | StepValidationErr {
  if (!isPlainObject(raw)) return { ok: false, error: `rateSteps[${idx}] must be an object` };
  for (const key of Object.keys(raw)) {
    if (!FEE_RATE_STEP_ALLOWED_KEYS.has(key)) return { ok: false, error: `Unknown key on rateStep[${idx}]: ${key}` };
  }
  const { id, effectiveFrom, methodKind, newAmount, cpiValue, ratePercent, note } = raw;
  if (!isUuidShaped(id)) return { ok: false, error: `rateSteps[${idx}].id must be a UUID` };
  if (typeof effectiveFrom !== "string" || !ISO_DATE_RE.test(effectiveFrom)) return { ok: false, error: `rateSteps[${idx}].effectiveFrom must be YYYY-MM-DD` };
  if (methodKind !== undefined && (typeof methodKind !== "string" || !VALID_METHOD_KINDS.has(methodKind))) return { ok: false, error: `rateSteps[${idx}].methodKind is invalid` };
  if (newAmount !== undefined && (typeof newAmount !== "number" || !Number.isFinite(newAmount) || newAmount < 0)) return { ok: false, error: `rateSteps[${idx}].newAmount must be a non-negative number` };
  if (cpiValue !== undefined && (typeof cpiValue !== "number" || !Number.isFinite(cpiValue) || cpiValue <= 0)) return { ok: false, error: `rateSteps[${idx}].cpiValue must be a positive number` };
  if (ratePercent !== undefined && (typeof ratePercent !== "number" || !Number.isFinite(ratePercent))) return { ok: false, error: `rateSteps[${idx}].ratePercent must be a number` };
  if (note !== undefined && typeof note !== "string") return { ok: false, error: `rateSteps[${idx}].note must be a string` };
  return {
    ok: true,
    step: {
      id: id as string,
      effectiveFrom: effectiveFrom as string,
      ...(methodKind !== undefined && { methodKind: methodKind as RentScheduleMethodKind }),
      ...(newAmount !== undefined && { newAmount: newAmount as number }),
      ...(cpiValue !== undefined && { cpiValue: cpiValue as number }),
      ...(ratePercent !== undefined && { ratePercent: ratePercent as number }),
      ...(note !== undefined && { note: (note as string).trim() }),
    },
  };
}

export function validateMiscFee(raw: unknown): { ok: true; fee: MiscFee } | StepValidationErr {
  if (!isPlainObject(raw)) return { ok: false, error: "fee must be an object" };
  for (const key of Object.keys(raw)) {
    if (!FEE_ALLOWED_KEYS.has(key)) return { ok: false, error: `Unknown key on fee: ${key}` };
  }
  const { id, title, frequency, baseAmount, commencedAt, endsAt, note } = raw;
  if (!isUuidShaped(id)) return { ok: false, error: "fee.id must be a UUID-shaped string" };
  if (typeof title !== "string" || title.trim().length === 0) return { ok: false, error: "fee.title must be a non-empty string" };
  if (title.length > 200) return { ok: false, error: "fee.title must be ≤200 chars" };
  if (typeof frequency !== "string" || !VALID_FREQUENCIES.has(frequency)) return { ok: false, error: "fee.frequency must be monthly | quarterly | annual" };
  if (typeof baseAmount !== "number" || !Number.isFinite(baseAmount) || baseAmount < 0) return { ok: false, error: "fee.baseAmount must be a non-negative number" };
  if (typeof commencedAt !== "string" || !ISO_DATE_RE.test(commencedAt)) return { ok: false, error: "fee.commencedAt must be an ISO date string (YYYY-MM-DD)" };
  if (endsAt !== undefined && (typeof endsAt !== "string" || !ISO_DATE_RE.test(endsAt))) return { ok: false, error: "fee.endsAt must be an ISO date string (YYYY-MM-DD) if provided" };
  if (note !== undefined && typeof note !== "string") return { ok: false, error: "fee.note must be a string" };

  const { rateSteps } = raw;
  let validatedSteps: MiscFeeRateStep[] | undefined;
  if (rateSteps !== undefined) {
    if (!Array.isArray(rateSteps)) return { ok: false, error: "fee.rateSteps must be an array" };
    validatedSteps = [];
    for (let i = 0; i < rateSteps.length; i++) {
      const result = validateMiscFeeRateStep(rateSteps[i], i);
      if (!result.ok) return result;
      validatedSteps.push(result.step);
    }
  }

  return {
    ok: true,
    fee: {
      id: id as string,
      title: (title as string).trim(),
      frequency: frequency as MiscFeeFrequency,
      baseAmount,
      commencedAt,
      ...(endsAt !== undefined && { endsAt }),
      ...(note !== undefined && { note: (note as string).trim() }),
      ...(validatedSteps !== undefined && { rateSteps: validatedSteps }),
    },
  };
}

export function validateUpsertFeeEnvelope(body: unknown):
  | { ok: true; TenantId: number; BuildingId: number; fee: MiscFee }
  | StepValidationErr {
  if (!isPlainObject(body)) return { ok: false, error: "body must be an object" };
  const { TenantId, BuildingId } = body;
  if (typeof TenantId !== "number" || !Number.isInteger(TenantId) || TenantId <= 0) return { ok: false, error: "TenantId must be a positive integer" };
  if (typeof BuildingId !== "number" || !Number.isInteger(BuildingId) || BuildingId <= 0) return { ok: false, error: "BuildingId must be a positive integer" };
  const result = validateMiscFee(body.fee);
  if (!result.ok) return result;
  return { ok: true, TenantId: TenantId as number, BuildingId: BuildingId as number, fee: result.fee };
}

export function validateDeleteFeeEnvelope(body: unknown):
  | { ok: true; TenantId: number; BuildingId: number; feeId: string }
  | StepValidationErr {
  if (!isPlainObject(body)) return { ok: false, error: "body must be an object" };
  const { TenantId, BuildingId, feeId } = body;
  if (typeof TenantId !== "number" || !Number.isInteger(TenantId) || TenantId <= 0) return { ok: false, error: "TenantId must be a positive integer" };
  if (typeof BuildingId !== "number" || !Number.isInteger(BuildingId) || BuildingId <= 0) return { ok: false, error: "BuildingId must be a positive integer" };
  if (!isUuidShaped(feeId)) return { ok: false, error: "feeId must be a UUID-shaped string" };
  return { ok: true, TenantId: TenantId as number, BuildingId: BuildingId as number, feeId: feeId as string };
}

export function parseMiscFees(raw: string | null | undefined): MiscFee[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (f): f is Record<string, unknown> =>
          isPlainObject(f) &&
          isUuidShaped(f.id) &&
          typeof f.title === "string" &&
          typeof f.frequency === "string" &&
          typeof f.baseAmount === "number" &&
          typeof f.commencedAt === "string",
      )
      .map((f): MiscFee => ({
        id: f.id as string,
        title: f.title as string,
        frequency: f.frequency as MiscFeeFrequency,
        baseAmount: f.baseAmount as number,
        commencedAt: f.commencedAt as string,
        ...(typeof f.endsAt === "string" && { endsAt: f.endsAt }),
        ...(typeof f.note === "string" && f.note.length > 0 && { note: f.note }),
        ...(Array.isArray(f.rateSteps) && f.rateSteps.length > 0 && {
          rateSteps: (f.rateSteps as unknown[]).filter(
            (s): s is MiscFeeRateStep =>
              isPlainObject(s) && isUuidShaped(s.id) && typeof s.effectiveFrom === "string",
          ),
        }),
      }));
  } catch {
    return [];
  }
}

export function upsertMiscFee(existing: MiscFee[], incoming: MiscFee): MiscFee[] {
  const idx = existing.findIndex((f) => f.id === incoming.id);
  if (idx === -1) return [...existing, incoming];
  const next = existing.slice();
  next[idx] = incoming;
  return next;
}

export function deleteMiscFee(existing: MiscFee[], id: string): MiscFee[] | typeof NOT_FOUND {
  const idx = existing.findIndex((f) => f.id === id);
  if (idx === -1) return NOT_FOUND;
  const next = existing.slice();
  next.splice(idx, 1);
  return next;
}
