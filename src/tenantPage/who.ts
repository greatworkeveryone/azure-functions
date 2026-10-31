// "Who is behind this link": the one SELECT the tenant page uses to read the tenancy, building and contact a
// resolved link points at (context and submit both). Scope is the link's own ids and nothing from the request.

import { TYPES } from "tedious";
import type { TenantLinkIdentity } from "../tenantLinks/types";

export const WHO_SQL = `SELECT COALESCE(NULLIF(t.TradingName, ''), t.LegalName) AS TenantName,
  (SELECT '[' + STRING_AGG('"' + STRING_ESCAPE(o.Level, 'json') + '"', ',') + ']'
     FROM (SELECT DISTINCT Level FROM dbo.TenantOccupancies WHERE TenantId = t.TenantId AND ArchivedAt IS NULL) o) AS Levels,
  b.BuildingName, c.Name AS ContactName, c.Phone, c.Email, c.ReportsIssues
  FROM dbo.Tenants t
  JOIN dbo.TenancyContacts c ON c.ContactId = @ContactId AND c.TenantId = t.TenantId
  LEFT JOIN dbo.Buildings b ON b.BuildingID = t.BuildingID
 WHERE t.TenantId = @TenantId AND t.BuildingID = @BuildingId`;

export const identityParams = (id: TenantLinkIdentity) => [
  { name: "TenantId", type: TYPES.Int, value: id.tenantId },
  { name: "ContactId", type: TYPES.Int, value: id.contactId },
  { name: "BuildingId", type: TYPES.Int, value: id.buildingId },
];

/** The occupancy levels (a JSON array from STRING_AGG, or plain text) as one short line. */
export function suiteText(levels: unknown): string {
  if (typeof levels !== "string" || levels.trim() === "") return "";
  try {
    const parsed: unknown = JSON.parse(levels);
    if (Array.isArray(parsed)) return parsed.filter((l): l is string => typeof l === "string").slice(0, 10).join(", ");
  } catch {
    // not JSON: fall through to the plain text
  }
  return levels.slice(0, 200);
}
