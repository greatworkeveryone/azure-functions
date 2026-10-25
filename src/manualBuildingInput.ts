// Input rules for the manual-buildings upsert (U8): the pure part, so the
// handler stays about the database. Manual buildings are the ones not managed
// in myBuildings: BuildingID <= 0 (migration 093).

export const BUILDING_CATEGORIES = ["commercial", "residence", "development"] as const;
export type BuildingCategory = (typeof BUILDING_CATEGORIES)[number];

export const MAX_BUILDING_NAME = 255;
export const MAX_BUILDING_ADDRESS = 500;
export const MAX_OWNER_NAME = 200;

export interface ManualBuildingInput {
  /** Fields left undefined are untouched by an update; ownerName null clears it. */
  address?: string;
  /** Present: edit that manual building. Absent: create one. */
  buildingId?: number;
  category?: BuildingCategory;
  name?: string;
  ownerName?: string | null;
}

export type ParsedManualBuilding = { ok: true; value: ManualBuildingInput } | { error: string; ok: false };

const fail = (error: string): ParsedManualBuilding => ({ error, ok: false });

export function isBuildingCategory(value: unknown): value is BuildingCategory {
  return typeof value === "string" && (BUILDING_CATEGORIES as readonly string[]).includes(value);
}

export function parseManualBuildingInput(body: Record<string, unknown>): ParsedManualBuilding {
  const value: ManualBuildingInput = {};

  if (body.buildingId !== undefined) {
    const id = body.buildingId;
    if (typeof id !== "number" || !Number.isInteger(id)) return fail("buildingId must be a whole number");
    if (id > 0) return fail("Only manual buildings (negative ids) can be edited here; myBuildings buildings come from the sync");
    value.buildingId = id;
  }

  if (body.name !== undefined) {
    if (typeof body.name !== "string" || !body.name.trim()) return fail("name is required");
    const name = body.name.trim();
    if (name.length > MAX_BUILDING_NAME) return fail(`name must be ${MAX_BUILDING_NAME} characters or fewer`);
    value.name = name;
  }

  if (body.address !== undefined && body.address !== null) {
    if (typeof body.address !== "string") return fail("address must be text");
    const address = body.address.trim();
    if (address.length > MAX_BUILDING_ADDRESS) return fail(`address must be ${MAX_BUILDING_ADDRESS} characters or fewer`);
    if (address) value.address = address;
  }

  if (body.category !== undefined) {
    if (!isBuildingCategory(body.category)) return fail("category must be commercial, residence or development");
    value.category = body.category;
  }

  if (body.ownerName !== undefined) {
    if (body.ownerName === null) {
      value.ownerName = null;
    } else if (typeof body.ownerName !== "string") {
      return fail("ownerName must be text");
    } else {
      const owner = body.ownerName.trim();
      if (owner.length > MAX_OWNER_NAME) return fail(`ownerName must be ${MAX_OWNER_NAME} characters or fewer`);
      value.ownerName = owner || null;
    }
  }

  return { ok: true, value };
}
