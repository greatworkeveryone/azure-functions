// What the tenant page shows about the tenancy behind a working link (TR3). Everything is read by the
// identity resolveTenantLink returned; nothing from the request picks the tenancy.

import { TYPES, type Connection } from "tedious";
import { fromName } from "../comms/config";
import { executeQuery } from "../db";
import type { TenantLinkIdentity } from "../tenantLinks/types";
import { companyAfterHours } from "../orgSettings/afterHours";
import { contactMayAct } from "../tenantLinks/purposes";
import { LIMITS, REQUEST_CATEGORIES, URGENCIES } from "./constants";

export interface TenantContextApi {
  buildingName: string;
  canReport: boolean;
  categories: { key: string; label: string }[];
  companyName: string;
  contactName: string;
  /** The company after-hours line (Admin setting); null only if it is not set. */
  afterHoursPhone: string | null;
  /** Who the page speaks for (comms fromName), e.g. for "your landlord". */
  landlordName: string;
  limits: { accessNotes: number; descriptionMax: number; descriptionMin: number; location: number; maxPhotos: number; photoBytes: number };
  suite: string;
  urgencies: readonly string[];
}

function levelsText(levels: unknown): string {
  if (typeof levels !== "string" || levels.trim() === "") return "";
  try {
    const parsed: unknown = JSON.parse(levels);
    if (Array.isArray(parsed)) return parsed.filter((l): l is string => typeof l === "string").slice(0, 10).join(", ");
  } catch {
    // not JSON: fall through to the plain text
  }
  return levels.slice(0, 200);
}

export async function readTenantContext(connection: Connection, identity: TenantLinkIdentity): Promise<TenantContextApi | null> {
  const [row] = await executeQuery(
    connection,
    `SELECT COALESCE(NULLIF(t.TradingName, ''), t.LegalName) AS TenantName,
            (SELECT '[' + STRING_AGG('"' + STRING_ESCAPE(o.Level, 'json') + '"', ',') + ']'
               FROM (SELECT DISTINCT Level FROM dbo.TenantOccupancies WHERE TenantId = t.TenantId AND ArchivedAt IS NULL) o) AS Levels,
            b.BuildingName, c.Name AS ContactName, c.ReportsIssues
       FROM dbo.Tenants t
       JOIN dbo.TenancyContacts c ON c.ContactId = @ContactId AND c.TenantId = t.TenantId
       LEFT JOIN dbo.Buildings b ON b.BuildingID = t.BuildingID
      WHERE t.TenantId = @TenantId AND t.BuildingID = @BuildingId`,
    [
      { name: "TenantId", type: TYPES.Int, value: identity.tenantId },
      { name: "ContactId", type: TYPES.Int, value: identity.contactId },
      { name: "BuildingId", type: TYPES.Int, value: identity.buildingId },
    ],
  );
  if (!row) return null;
  return {
    afterHoursPhone: await companyAfterHours(connection),
    buildingName: String(row.BuildingName ?? ""),
    canReport: contactMayAct(identity.purpose, { reportsIssues: row.ReportsIssues === true }),
    categories: REQUEST_CATEGORIES.map((c) => ({ key: c.key, label: c.label })),
    companyName: String(row.TenantName ?? ""),
    contactName: String(row.ContactName ?? ""),
    landlordName: fromName(),
    limits: {
      accessNotes: LIMITS.accessNotes,
      descriptionMax: LIMITS.descriptionMax,
      descriptionMin: LIMITS.descriptionMin,
      location: LIMITS.location,
      maxPhotos: LIMITS.maxPhotosPerRequest,
      photoBytes: LIMITS.photoBytes,
    },
    suite: levelsText(row.Levels),
    urgencies: URGENCIES,
  };
}
