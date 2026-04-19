import type { MyWorkRequest } from "./mybuildings-client";

// Pure helpers for resolving the BuildingID that myBuildings' WR list endpoint
// omits. Extracted so both sync paths (per-building and bulk) share one
// implementation and so the resolver is unit-testable without a DB/HTTP.

export interface ResolveContext {
  /** Buildings table lookup by name, used for bulk sync where ID isn't known */
  nameToId?: Map<string, number>;
  /** When syncing a single building, use its known ID as a fallback */
  fallbackId?: number;
}

export function resolveBuildingId(
  wr: MyWorkRequest,
  ctx: ResolveContext,
): number | undefined {
  if (wr.BuildingID != null) return wr.BuildingID;
  if (ctx.fallbackId != null) return ctx.fallbackId;
  if (wr.BuildingName && ctx.nameToId) return ctx.nameToId.get(wr.BuildingName);
  return undefined;
}

export interface ResolveAllResult {
  resolved: MyWorkRequest[];
  unresolvedCount: number;
}

export function resolveAll(
  wrs: MyWorkRequest[],
  ctx: ResolveContext,
): ResolveAllResult {
  let unresolvedCount = 0;
  const resolved = wrs.map((wr) => {
    const id = resolveBuildingId(wr, ctx);
    if (id === undefined) unresolvedCount++;
    return { ...wr, BuildingID: id } as MyWorkRequest;
  });
  return { resolved, unresolvedCount };
}

// If more than this fraction of WRs in a sync are unresolved, something is
// wrong (Buildings table stale, API contract changed) and we should fail loud.
export const UNRESOLVED_THRESHOLD = 0.05;

export function assertResolvedWithinThreshold(
  unresolvedCount: number,
  total: number,
  threshold: number = UNRESOLVED_THRESHOLD,
): void {
  if (total === 0) return;
  const ratio = unresolvedCount / total;
  if (ratio > threshold) {
    throw new Error(
      `Too many work requests could not be resolved to a BuildingID: ` +
        `${unresolvedCount}/${total} (${(ratio * 100).toFixed(1)}%). ` +
        `Buildings table may be stale or myBuildings response shape changed.`,
    );
  }
}

// myBuildings' create endpoint returns the new WorkRequestID in several
// envelope shapes depending on the request. Observed shapes:
//   { Success, Data: { ...echo... }, Result: { WorkRequestID, JobCode } }
//   { Success, Data: { WorkRequestID } }
//   { WorkRequestID }
// This helper picks it out safely from whichever variant the API uses today.
export function extractCreatedWorkRequestId(response: unknown): number | undefined {
  if (!response || typeof response !== "object") return undefined;
  const r = response as Record<string, any>;
  const candidates: unknown[] = [
    r.Result?.WorkRequestID,
    r.Result?.WorkRequestId,
    r.Result?.Id,
    r.Data?.WorkRequestID,
    r.Data?.WorkRequestId,
    r.Data?.Id,
    r.WorkRequestID,
    r.WorkRequestId,
    r.Id,
  ];
  for (const c of candidates) {
    if (typeof c === "number" && Number.isFinite(c) && c > 0) return c;
    if (typeof c === "string" && /^\d+$/.test(c)) {
      const n = Number(c);
      if (n > 0) return n;
    }
  }
  return undefined;
}
