// Shapes of the "who maintains what" list (TR7).

export const MAINTAINED_BY = ["base_building", "owner_oncharge", "tenant"] as const;
export type MaintainedBy = (typeof MAINTAINED_BY)[number];

export interface ResponsibilityFields {
  assetId: number | null;
  category: string | null;
  drawingRef: string | null;
  item: string;
  location: string | null;
  maintainedBy: MaintainedBy;
  note: string | null;
  projectEventId: number | null;
}

export interface ResponsibilityApi extends ResponsibilityFields {
  archivedAt: string | null;
  archivedBy: string | null;
  assetName: string | null;
  projectTitle: string | null;
  responsibilityId: number;
  /** Send back with an edit or archive: a stale one is a 409. */
  rowVersion: string;
  tenantId: number;
}
