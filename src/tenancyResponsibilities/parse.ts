// Validation of responsibility writes (TR7). Pure; the handlers do the I/O.

import { ASSET_CATEGORIES } from "../assetRegister";
import { positiveId, type Parsed } from "../tenantLinks/contacts";
import { MAINTAINED_BY, type MaintainedBy, type ResponsibilityFields } from "./types";

const fail = (error: string): { error: string; ok: false } => ({ error, ok: false });
const text = (value: unknown, max: number): string | null | undefined => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().replace(/\s+/g, " ");
  return trimmed.length === 0 ? null : trimmed.length > max ? undefined : trimmed;
};
const optionalId = (value: unknown): number | null | undefined => (value === undefined || value === null ? null : (positiveId(value) ?? undefined));

export function parseResponsibilityFields(body: Record<string, unknown>): Parsed<ResponsibilityFields> {
  const item = text(body.item, 200);
  if (item === undefined || item === null) return fail("item is required (up to 200 characters)");
  const category = text(body.category, 50);
  if (category === undefined || (category !== null && !(ASSET_CATEGORIES as readonly string[]).includes(category))) return fail("category must be one of the maintenance categories");
  const location = text(body.location, 200);
  if (location === undefined) return fail("location is too long (200 characters)");
  if (typeof body.maintainedBy !== "string" || !(MAINTAINED_BY as readonly string[]).includes(body.maintainedBy)) {
    return fail("maintainedBy must be base_building, owner_oncharge or tenant");
  }
  const assetId = optionalId(body.assetId);
  if (assetId === undefined) return fail("assetId must be a whole number");
  const projectEventId = optionalId(body.projectEventId);
  if (projectEventId === undefined) return fail("projectEventId must be a whole number");
  const drawingRef = text(body.drawingRef, 200);
  if (drawingRef === undefined) return fail("drawingRef is too long (200 characters)");
  const note = text(body.note, 1000);
  if (note === undefined) return fail("note is too long (1000 characters)");
  return { ok: true, value: { assetId, category, drawingRef, item, location, maintainedBy: body.maintainedBy as MaintainedBy, note, projectEventId } };
}

/** Tenant-page request categories -> the maintenance category an item is filed under (null: no match, show all). */
const TENANT_CATEGORY_TO_TRADE: Record<string, string | null> = {
  air_conditioning: "HVAC / mechanical",
  building_fabric: "Other",
  cleaning: "Cleaning",
  doors_locks: "Other",
  electrical: "Electrical",
  lifts: "Lifts",
  other: null,
  pests: "Grounds",
  plumbing: "Hydraulic",
};
export const tradeForRequestCategory = (key: string | null): string | null => (key === null ? null : (TENANT_CATEGORY_TO_TRADE[key] ?? null));
