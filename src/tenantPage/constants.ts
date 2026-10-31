// The tenant page's fixed lists and limits (TR3, PLAN §15). The frontend carries a copy of the
// category and urgency keys for its chips; the server is the one that enforces them.

export const TENANT_PAGE_FLAG = "tenantPage";

export const REQUEST_CATEGORIES = [
  { key: "air_conditioning", label: "Air conditioning or heating" },
  { key: "plumbing", label: "Plumbing or leaks" },
  { key: "electrical", label: "Electrical or lighting" },
  { key: "doors_locks", label: "Doors, locks or access" },
  { key: "lifts", label: "Lifts" },
  { key: "cleaning", label: "Cleaning or rubbish" },
  { key: "pests", label: "Pests" },
  { key: "building_fabric", label: "Walls, floors, ceilings or windows" },
  { key: "other", label: "Something else" },
] as const;

export type RequestCategory = (typeof REQUEST_CATEGORIES)[number]["key"];
export const CATEGORY_KEYS: readonly string[] = REQUEST_CATEGORIES.map((c) => c.key);
export const categoryLabel = (key: string): string => REQUEST_CATEGORIES.find((c) => c.key === key)?.label ?? "Something else";

export const URGENCIES = ["emergency", "urgent", "routine"] as const;
export type Urgency = (typeof URGENCIES)[number];
/** Stored in WorkRequests.Priority. */
export const URGENCY_PRIORITY: Record<Urgency, string> = { emergency: "Emergency", routine: "Routine", urgent: "Urgent" };

export const LIMITS = {
  accessNotes: 500,
  descriptionMax: 2000,
  descriptionMin: 10,
  location: 200,
  maxPhotosPerRequest: 5,
  photoBytes: 8 * 1024 * 1024,
  /**
   * A tenancy's hard daily caps, counted from the database so they hold across instances. Only a tenant's explicit
   * "emergency" choice may exceed requestsPerTenancyPerDay, and those have their own cap; keyword triage never does.
   */
  emergenciesPerTenancyPerDay: 5,
  requestsPerTenancyPerDay: 20,
  photosPerTenancyPerDay: 60,
  /** Photos may only be added to a request this recent. */
  photoWindowHours: 2,
} as const;
