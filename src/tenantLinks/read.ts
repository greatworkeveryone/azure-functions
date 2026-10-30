import { executeQuery } from "../db";
import type { Connection } from "tedious";
import { TYPES } from "tedious";
import { listContacts, seedIfNoContacts, versionText } from "./store";
import type { TenancyContactsApi } from "./types";

/** The contacts of a tenancy (seeded from its primary contact on first read), with link status. Null when there is no such tenancy. */
export async function loadTenancyContacts(connection: Connection, tenantId: number, by: string, now: Date = new Date()): Promise<TenancyContactsApi | null> {
  const [tenancy] = await executeQuery(connection, `SELECT EmailOnly, RowVersion FROM dbo.Tenants WHERE TenantId = @TenantId`, [{ name: "TenantId", type: TYPES.Int, value: tenantId }]);
  if (!tenancy) return null;
  await seedIfNoContacts(connection, tenantId, by);
  return { contacts: await listContacts(connection, tenantId, now), emailOnly: tenancy.EmailOnly === true, tenancyRowVersion: versionText(tenancy.RowVersion), tenantId };
}
