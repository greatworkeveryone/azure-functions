import type { ResponsibilityApi } from "./types";

/** The ledger copy of an item: what it is and who maintains it. The free-text note stays out. */
export function responsibilitySnapshot(r: ResponsibilityApi) {
  return {
    assetId: r.assetId,
    category: r.category,
    item: r.item,
    location: r.location,
    maintainedBy: r.maintainedBy,
    projectEventId: r.projectEventId,
    responsibilityId: r.responsibilityId,
  };
}
