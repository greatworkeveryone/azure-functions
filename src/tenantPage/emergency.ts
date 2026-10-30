// The emergency number a tenant is told to ring (TR3). Fail closed: a page that tells a tenant in an
// emergency to "phone your property manager" with no number is worse than no page, so the tenant page is
// unavailable for a building with no number, and the tenantPage flag cannot be turned on until one exists.

import { TYPES, type Connection } from "tedious";
import { executeQuery } from "../db";
import { cleanPhone } from "./context";

export const fallbackEmergencyPhone = (): string | null => cleanPhone(process.env.TENANT_EMERGENCY_PHONE);

/** Buildings.EmergencyPhone, else TENANT_EMERGENCY_PHONE; null when neither is a usable number. */
export async function emergencyPhoneFor(connection: Connection, buildingId: number): Promise<string | null> {
  const [row] = await executeQuery(connection, `SELECT EmergencyPhone FROM dbo.Buildings WHERE BuildingID = @BuildingId`, [
    { name: "BuildingId", type: TYPES.Int, value: buildingId },
  ]);
  return cleanPhone(row?.EmergencyPhone) ?? fallbackEmergencyPhone();
}

/**
 * Staff-facing reason the flag cannot be enabled yet, or null when it can: the app-wide fallback is set,
 * or every building that has an active tenancy has its own number.
 */
export async function emergencyPhoneProblem(connection: Connection): Promise<string | null> {
  if (fallbackEmergencyPhone() !== null) return null;
  const rows = await executeQuery(
    connection,
    `SELECT b.BuildingName, b.EmergencyPhone FROM dbo.Buildings b
      WHERE EXISTS (SELECT 1 FROM dbo.Tenants t WHERE t.BuildingID = b.BuildingID AND t.ArchivedAt IS NULL)`,
  );
  const missing = rows.filter((r) => cleanPhone(r.EmergencyPhone) === null).map((r) => String(r.BuildingName ?? "a building"));
  if (rows.length === 0 || missing.length > 0) {
    return `The tenant page can't be turned on until an emergency phone number is set${
      missing.length > 0 ? ` for: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? " and others" : ""}` : ""
    }. Set it on the building, or set TENANT_EMERGENCY_PHONE.`;
  }
  return null;
}
