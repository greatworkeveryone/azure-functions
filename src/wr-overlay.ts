// ─────────────────────────────────────────────────────────────────────────────
// Work-request overlay: the list of columns that can be locally overridden
// without the myBuildings sync stomping them. Read-side queries LEFT JOIN
// WorkRequestOverrides and COALESCE overlay.col over wr.col per entry.
//
// Keep this in sync with migrations/004_work_request_overrides.sql.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Columns with a myBuildings-authoritative value that stays on WorkRequests.
 * Note: LastModifiedDate is computed as the MAX of wr.LastModifiedDate and
 * the overlay row's UpdatedAt, so local edits advance the "last changed"
 * timestamp too. See workRequestSelectColumns().
 */
export const AUTHORITATIVE_COLUMNS = [
  "WorkRequestID",
  "JobCode",
  "BuildingID",
  "BuildingName",
  "StatusID",
  "Status",
  "WorkBeganDate",
  "ActualCompletionDate",
  "LastSyncedAt",
  "CreatedAt",
  "UpdatedAt",
] as const;

/** Columns that can be overridden locally. */
export const OVERLAY_COLUMNS = [
  "AssignedTo",
  "Category",
  "Type",
  "SubType",
  "Priority",
  "Details",
  "LevelName",
  "TenantName",
  "ExactLocation",
  "PersonAffected",
  "ContactName",
  "ContactPhone",
  "ContactEmail",
  "ExpectedCompletionDate",
  "WorkNotes",
  "TotalCost",
  "CostNotToExceed",
] as const;

export type OverlayColumn = (typeof OVERLAY_COLUMNS)[number];

/**
 * Builds the SELECT column list for a WR fetch: authoritative columns direct
 * from `wr`, overlaid columns via COALESCE, plus AttachmentCount subquery and
 * a HasLocalOverride flag. Use inside:
 *
 *   SELECT ${workRequestSelectColumns()} FROM WorkRequests wr
 *   LEFT JOIN WorkRequestOverrides o ON o.WorkRequestID = wr.WorkRequestID
 *   WHERE ...
 */
export function workRequestSelectColumns(): string {
  const authoritative = AUTHORITATIVE_COLUMNS.map((c) => `wr.${quote(c)}`);
  const overlaid = OVERLAY_COLUMNS.map(
    (c) => `COALESCE(o.${quote(c)}, wr.${quote(c)}) AS ${quote(c)}`,
  );
  // LastModifiedDate = most recent of the myBuildings timestamp and the
  // overlay's UpdatedAt. If a local edit happens after a myBuildings sync,
  // the local timestamp wins — keeps stalled-detection and conflict checks
  // accurate when the team edits only via our UI.
  const lastModified =
    `CASE WHEN o.UpdatedAt IS NULL OR wr.LastModifiedDate > o.UpdatedAt
          THEN wr.LastModifiedDate ELSE o.UpdatedAt END AS LastModifiedDate`;
  const attachmentCount =
    `(SELECT COUNT(*) FROM Attachments a WHERE a.WorkRequestID = wr.WorkRequestID) AS AttachmentCount`;
  const overrideFlag =
    `CASE WHEN o.WorkRequestID IS NOT NULL THEN 1 ELSE 0 END AS HasLocalOverride`;
  return [...authoritative, ...overlaid, lastModified, attachmentCount, overrideFlag].join(", ");
}

/** Quote identifiers that collide with reserved words like `Type`. */
function quote(col: string): string {
  return col === "Type" ? "[Type]" : col;
}

/** SQL fragment for the LEFT JOIN that backs the overlay. */
export const WR_OVERLAY_JOIN =
  "LEFT JOIN WorkRequestOverrides o ON o.WorkRequestID = wr.WorkRequestID";

// ── Pure-logic helpers, used in tests and from the endpoint handler ──────────

/**
 * Returns a new object where overlay values (if non-null/undefined) take
 * precedence over the base WR. Mirrors the SQL-side COALESCE behaviour so
 * test assertions can match what the read query would produce.
 */
export function mergeOverride<T extends Record<string, any>>(
  baseWr: T,
  override: Partial<Record<OverlayColumn, any>> | null | undefined,
): T {
  if (!override) return baseWr;
  const merged: Record<string, any> = { ...baseWr };
  for (const col of OVERLAY_COLUMNS) {
    const v = override[col];
    if (v !== null && v !== undefined) {
      merged[col] = v;
    }
  }
  return merged as T;
}

/**
 * Filter arbitrary client input down to just the known overlay columns.
 * Unknown fields (including `WorkRequestID`, `UpdatedBy`, or anything
 * authoritative like `StatusID`) are dropped. Preserves `null` explicitly —
 * the caller needs it to distinguish "clear the override" from "not provided".
 */
export function pickOverlayFields(
  body: Record<string, any>,
): Partial<Record<OverlayColumn, any>> {
  const accepted: Record<string, any> = {};
  for (const col of OVERLAY_COLUMNS) {
    if (col in body) accepted[col] = body[col];
  }
  return accepted;
}

/**
 * Mirrors the SQL CASE expression for merged LastModifiedDate. Used by tests
 * so we can assert the JS and SQL agree. If either input is null we fall back
 * to the other; on ties the overlay timestamp wins (same as SQL's ELSE branch).
 */
export function computeMergedLastModified(
  wrLastModified: Date | null,
  overlayUpdatedAt: Date | null,
): Date | null {
  if (overlayUpdatedAt == null) return wrLastModified;
  if (wrLastModified == null) return overlayUpdatedAt;
  return wrLastModified.getTime() > overlayUpdatedAt.getTime()
    ? wrLastModified
    : overlayUpdatedAt;
}

/**
 * Builds the MERGE statement that upserts one overlay row given the subset of
 * overlay columns actually being written. Separated from the endpoint handler
 * so the SQL assembly — including reserved-word bracket quoting — is testable.
 */
export function buildOverlayUpsertSql(presentColumns: readonly string[]): string {
  const quoteCol = (c: string) => (c === "Type" ? "[Type]" : c);
  const updateSet = presentColumns
    .map((c) => `${quoteCol(c)} = @${c}`)
    .concat(["UpdatedAt = SYSUTCDATETIME()", "UpdatedBy = @UpdatedBy"]);
  const insertCols = [
    "WorkRequestID",
    ...presentColumns.map(quoteCol),
    "UpdatedBy",
  ];
  const insertVals = [
    "@WorkRequestID",
    ...presentColumns.map((c) => `@${c}`),
    "@UpdatedBy",
  ];
  return (
    `MERGE INTO WorkRequestOverrides WITH (HOLDLOCK) AS target ` +
    `USING (SELECT @WorkRequestID AS WorkRequestID) AS src ` +
    `ON target.WorkRequestID = src.WorkRequestID ` +
    `WHEN MATCHED THEN UPDATE SET ${updateSet.join(", ")} ` +
    `WHEN NOT MATCHED THEN INSERT (${insertCols.join(", ")}) ` +
    `VALUES (${insertVals.join(", ")});`
  );
}
