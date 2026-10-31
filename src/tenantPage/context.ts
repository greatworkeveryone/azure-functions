// What the tenant page shows about the tenancy behind a working link (TR3). Everything is read by the
// identity resolveTenantLink returned; nothing from the request picks the tenancy.

import type { Connection } from "tedious";
import { fromName } from "../comms/config";
import { executeQuery } from "../db";
import type { TenantLinkIdentity } from "../tenantLinks/types";
import { companyAfterHours } from "../orgSettings/afterHours";
import { contactMayAct } from "../tenantLinks/purposes";
import { LIMITS, REQUEST_CATEGORIES, URGENCIES } from "./constants";
import { identityParams, suiteText, WHO_SQL } from "./who";

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

export async function readTenantContext(connection: Connection, identity: TenantLinkIdentity): Promise<TenantContextApi | null> {
  const [row] = await executeQuery(connection, WHO_SQL, identityParams(identity));
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
    suite: suiteText(row.Levels),
    urgencies: URGENCIES,
  };
}
