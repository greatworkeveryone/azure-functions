const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

interface CacheEntry {
  data: unknown;
  expiry: number;
}

// Keyed by BuildingId — the tenant list response body
const buildingCache = new Map<number, CacheEntry>();

// Keyed by TenantId — the tenant detail response body
const tenantCache = new Map<number, CacheEntry>();

// TenantId → BuildingId side-map so invalidateTenant can also bust the building list
const tenantBuilding = new Map<number, number>();

export function getCachedTenantList(buildingId: number): unknown | null {
  const entry = buildingCache.get(buildingId);
  if (!entry || Date.now() > entry.expiry) {
    buildingCache.delete(buildingId);
    return null;
  }
  return entry.data;
}

export function setCachedTenantList(buildingId: number, data: unknown): void {
  buildingCache.set(buildingId, { data, expiry: Date.now() + CACHE_TTL_MS });
}

export function getCachedTenantDetail(tenantId: number): unknown | null {
  const entry = tenantCache.get(tenantId);
  if (!entry || Date.now() > entry.expiry) {
    tenantCache.delete(tenantId);
    return null;
  }
  return entry.data;
}

export function setCachedTenantDetail(tenantId: number, buildingId: number, data: unknown): void {
  tenantCache.set(tenantId, { data, expiry: Date.now() + CACHE_TTL_MS });
  tenantBuilding.set(tenantId, buildingId);
}

// Bust a single tenant + its building list. Use when TenantId is known.
export function invalidateTenant(tenantId: number): void {
  tenantCache.delete(tenantId);
  const buildingId = tenantBuilding.get(tenantId);
  if (buildingId !== undefined) buildingCache.delete(buildingId);
}

// Bust both when both IDs are immediately available (most write paths).
export function invalidateTenantAndBuilding(tenantId: number, buildingId: number): void {
  tenantCache.delete(tenantId);
  buildingCache.delete(buildingId);
  tenantBuilding.set(tenantId, buildingId);
}
